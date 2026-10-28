/**
 * jiyu-sync billing scaffold: per-account entitlements (trial -> paid) and provider webhooks.
 *
 * OFF by default. With BILLING_ENABLED != "true" every billing route answers 404 and no code
 * reads or writes the entitlements / billing_events tables, so live sync behaviour is unchanged.
 *
 * Providers (BILLING_PROVIDER):
 *   none    entitlements + trial only; checkout / portal / webhooks are refused
 *   test    local adapter: HMAC-signed webhooks with BILLING_TEST_WEBHOOK_SECRET, fake checkout
 *   stripe  Stripe adapter, TEST MODE ONLY: refuses any key that is not sk_test_ / rk_test_ and
 *           any webhook event with livemode = true
 *
 * Secrets (wrangler secret put, never in wrangler.toml or git):
 *   BILLING_TEST_WEBHOOK_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 * See docs/payments.md before turning any of this on.
 */

const DAY_MS = 24 * 3600 * 1000
const ACTIVE_SLACK_MS = 2 * DAY_MS // webhook delay tolerance past current_period_end
const MAX_WEBHOOK_BYTES = 256 * 1024
const SIGNATURE_TOLERANCE_S = 300
const RECHECK_MS = 6 * 3600 * 1000
const STRIPE_API = 'https://api.stripe.com'
const PAID_STATUSES = new Set(['active', 'past_due', 'canceled', 'comp'])
const SETTABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'comp', 'expired', 'none'])
const DEFAULT_PLANS = [
  { id: 'monthly', label: 'Monthly', priceLabel: null },
  { id: 'yearly', label: 'Yearly', priceLabel: null },
]

function clampInt(raw, fallback, min, max) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function billingConfig(env) {
  const e = env || {}
  return {
    enabled: String(e.BILLING_ENABLED || '').trim() === 'true',
    provider: String(e.BILLING_PROVIDER || 'none').trim().toLowerCase(),
    trialMs: clampInt(e.BILLING_TRIAL_DAYS, 7, 0, 60) * DAY_MS,
    pastDueGraceMs: clampInt(e.BILLING_PAST_DUE_GRACE_DAYS, 3, 0, 30) * DAY_MS,
    offlineGraceMs: clampInt(e.BILLING_OFFLINE_GRACE_HOURS, 72, 0, 24 * 14) * 3600 * 1000,
    devTools: String(e.BILLING_DEV_TOOLS || '').trim() === 'true',
  }
}

function plansFromEnv(env) {
  try {
    const parsed = JSON.parse(String(env.BILLING_PLANS || ''))
    if (Array.isArray(parsed)) {
      const plans = parsed
        .filter((p) => p && typeof p.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(p.id))
        .map((p) => ({
          id: p.id,
          label: String(p.label || p.id).slice(0, 48),
          priceLabel: p.priceLabel ? String(p.priceLabel).slice(0, 48) : null,
        }))
      if (plans.length) return plans
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_PLANS
}

// ---------------------------------------------------------------- entitlement evaluation

/** Pure: what a stored row means right now. Exported for tests. */
export function evaluateEntitlement(row, now, cfg) {
  if (!row) return { status: 'none', entitled: false, accessUntil: null }
  const periodEnd = row.current_period_end == null ? null : Number(row.current_period_end)
  const trialEnd = row.trial_ends_at == null ? null : Number(row.trial_ends_at)
  switch (row.status) {
    case 'trialing': {
      const ok = trialEnd != null && now < trialEnd
      return { status: ok ? 'trialing' : 'expired', entitled: ok, accessUntil: trialEnd }
    }
    case 'active': {
      if (periodEnd == null) return { status: 'active', entitled: true, accessUntil: null }
      const until = periodEnd + ACTIVE_SLACK_MS
      return { status: now < until ? 'active' : 'expired', entitled: now < until, accessUntil: until }
    }
    case 'past_due': {
      const until = (periodEnd ?? Number(row.updated_at || now)) + cfg.pastDueGraceMs
      return { status: now < until ? 'past_due' : 'expired', entitled: now < until, accessUntil: until }
    }
    case 'canceled': {
      const ok = periodEnd != null && now < periodEnd
      return { status: ok ? 'canceled' : 'expired', entitled: ok, accessUntil: periodEnd }
    }
    case 'comp': {
      const ok = periodEnd == null || now < periodEnd
      return { status: ok ? 'comp' : 'expired', entitled: ok, accessUntil: periodEnd }
    }
    default:
      return { status: row.status === 'none' ? 'none' : 'expired', entitled: false, accessUntil: null }
  }
}

function entitlementBody(row, now, cfg) {
  const ev = evaluateEntitlement(row, now, cfg)
  let recheckAfterMs = RECHECK_MS
  if (ev.accessUntil != null && ev.accessUntil > now) {
    recheckAfterMs = Math.max(60_000, Math.min(RECHECK_MS, ev.accessUntil - now))
  }
  return {
    enabled: true,
    provider: cfg.provider,
    entitled: ev.entitled,
    status: ev.status,
    plan: row?.plan || null,
    trialEndsAt: row?.trial_ends_at == null ? null : Number(row.trial_ends_at),
    currentPeriodEnd: row?.current_period_end == null ? null : Number(row.current_period_end),
    cancelAtPeriodEnd: Boolean(Number(row?.cancel_at_period_end || 0)),
    accessUntil: ev.accessUntil,
    canManage: Boolean(row?.provider_customer_id),
    now,
    recheckAfterMs,
    offlineGraceMs: cfg.offlineGraceMs,
  }
}

async function loadOrStartTrial(env, userId, cfg) {
  const now = Date.now()
  const existing = await env.DB.prepare('SELECT * FROM entitlements WHERE user_id = ?').bind(userId).first()
  if (existing) return existing
  const trial = cfg.trialMs > 0
  await env.DB.prepare(
    `INSERT OR IGNORE INTO entitlements
       (user_id, plan, status, trial_started_at, trial_ends_at, updated_at, last_event_at)
     VALUES (?, 'trial', ?, ?, ?, ?, 0)`,
  )
    .bind(userId, trial ? 'trialing' : 'none', trial ? now : null, trial ? now + cfg.trialMs : null, now)
    .run()
  return env.DB.prepare('SELECT * FROM entitlements WHERE user_id = ?').bind(userId).first()
}

// ---------------------------------------------------------------- crypto helpers

const enc = new TextEncoder()

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Parses "t=123,v1=abc,v1=def" (Stripe-Signature / Jiyu-Test-Signature). */
function parseSignatureHeader(header) {
  const out = { t: null, v1: [] }
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') out.t = v
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase())
  }
  return out
}

/** Stripe scheme: HMAC-SHA256(secret, `${t}.${rawBody}`), timestamp within tolerance. Exported for tests. */
export async function verifySignedPayload(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, reason: 'Webhook secret not configured' }
  const sig = parseSignatureHeader(header)
  const t = Number(sig.t)
  if (!sig.t || !Number.isFinite(t) || sig.v1.length === 0) return { ok: false, reason: 'Missing signature' }
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: 'Signature timestamp outside tolerance' }
  const expected = await hmacSha256Hex(secret, `${sig.t}.${rawBody}`)
  if (!sig.v1.some((v) => timingSafeEqualHex(v, expected))) return { ok: false, reason: 'Bad signature' }
  return { ok: true }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

// ---------------------------------------------------------------- provider adapters
//
// Adapter interface:
//   name: string
//   parseWebhook(request, rawBody, env) -> NormalizedEvent | null   (throws httpError(400) on bad signature)
//   createCheckout({ env, userId, plan, row, returnBase }) -> { url, test? }
//   createPortal({ env, row, returnBase }) -> { url }
//
// NormalizedEvent: { id, type, created (ms), userId?, customerId?, subscriptionId?, patch? }
//   patch: { status?, plan?, currentPeriodEnd?, cancelAtPeriodEnd? }  (null = record only)

const noneAdapter = {
  name: 'none',
  async parseWebhook() {
    throw httpError(404, 'No billing provider configured')
  },
  async createCheckout() {
    throw httpError(503, 'Payments are not set up yet')
  },
  async createPortal() {
    throw httpError(503, 'Payments are not set up yet')
  },
}

/** Local / CI adapter. Payload is already a NormalizedEvent; signed like Stripe with a shared secret. */
const testAdapter = {
  name: 'test',
  async parseWebhook(request, rawBody, env) {
    const check = await verifySignedPayload(rawBody, request.headers.get('Jiyu-Test-Signature'), env.BILLING_TEST_WEBHOOK_SECRET)
    if (!check.ok) throw httpError(400, check.reason)
    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      throw httpError(400, 'Invalid JSON')
    }
    if (!body || typeof body.id !== 'string' || typeof body.type !== 'string') throw httpError(400, 'Bad event')
    const patch = {}
    if (body.status !== undefined) patch.status = body.status
    if (body.plan !== undefined) patch.plan = body.plan
    if (body.currentPeriodEnd !== undefined) patch.currentPeriodEnd = body.currentPeriodEnd
    if (body.cancelAtPeriodEnd !== undefined) patch.cancelAtPeriodEnd = body.cancelAtPeriodEnd
    return {
      id: body.id,
      type: body.type,
      created: Number(body.created) || Date.now(),
      userId: body.userId || null,
      customerId: body.customerId || null,
      subscriptionId: body.subscriptionId || null,
      patch: Object.keys(patch).length ? patch : null,
    }
  },
  async createCheckout({ userId, plan, returnBase }) {
    return { url: `${returnBase}?result=test&plan=${encodeURIComponent(plan)}&u=${encodeURIComponent(userId)}`, test: true }
  },
  async createPortal({ returnBase }) {
    return { url: `${returnBase}?result=test-portal`, test: true }
  },
}

function stripeKey(env) {
  const key = String(env.STRIPE_SECRET_KEY || '')
  if (!key) throw httpError(503, 'Stripe test key not configured')
  if (!/^(sk|rk)_test_/.test(key)) throw httpError(503, 'Live Stripe keys are disabled in this build (test mode only)')
  return key
}

function stripeApiBase(env) {
  const raw = String(env.STRIPE_API_BASE || '').trim()
  if (!raw) return STRIPE_API
  // Only the real API or a loopback mock (tests) - never send the key anywhere else.
  if (raw === STRIPE_API || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(raw)) return raw
  throw httpError(503, 'STRIPE_API_BASE must be api.stripe.com or a loopback mock')
}

async function stripeCall(env, path, params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.append(k, String(v))
  const res = await fetch(`${stripeApiBase(env)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw httpError(502, `Stripe error: ${data?.error?.message || res.status}`)
  return data
}

const STRIPE_STATUS = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'expired',
  incomplete_expired: 'expired',
  paused: 'expired',
}

function stripePlanFor(env, sub) {
  const priceId = sub?.items?.data?.[0]?.price?.id
  if (priceId && priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly'
  if (priceId && priceId === env.STRIPE_PRICE_YEARLY) return 'yearly'
  return sub?.metadata?.jiyu_plan || undefined
}

const stripeAdapter = {
  name: 'stripe',
  async parseWebhook(request, rawBody, env) {
    const check = await verifySignedPayload(rawBody, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET)
    if (!check.ok) throw httpError(400, check.reason)
    let event
    try {
      event = JSON.parse(rawBody)
    } catch {
      throw httpError(400, 'Invalid JSON')
    }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw httpError(400, 'Bad event')
    if (event.livemode === true) throw httpError(400, 'Live-mode events are refused (test mode only)')
    const obj = event.data?.object || {}
    const base = { id: event.id, type: event.type, created: Number(event.created || 0) * 1000 || Date.now() }

    if (event.type === 'checkout.session.completed') {
      if (obj.mode && obj.mode !== 'subscription') return { ...base, patch: null }
      return {
        ...base,
        userId: obj.client_reference_id || obj.metadata?.jiyu_user || null,
        customerId: obj.customer || null,
        subscriptionId: obj.subscription || null,
        patch: { status: 'active', plan: obj.metadata?.jiyu_plan || undefined },
      }
    }
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const periodEndS = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end
      const deleted = event.type === 'customer.subscription.deleted'
      const status = deleted ? 'expired' : STRIPE_STATUS[obj.status]
      return {
        ...base,
        userId: obj.metadata?.jiyu_user || null,
        customerId: obj.customer || null,
        subscriptionId: obj.id || null,
        patch: status
          ? {
              status,
              plan: stripePlanFor(env, obj),
              currentPeriodEnd: periodEndS ? Number(periodEndS) * 1000 : undefined,
              cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
            }
          : null,
      }
    }
    if (event.type === 'invoice.payment_failed') {
      return { ...base, customerId: obj.customer || null, subscriptionId: obj.subscription || null, patch: { status: 'past_due' } }
    }
    return { ...base, patch: null }
  },
  async createCheckout({ env, userId, plan, row, returnBase }) {
    const price = plan === 'yearly' ? env.STRIPE_PRICE_YEARLY : plan === 'monthly' ? env.STRIPE_PRICE_MONTHLY : null
    if (!price) throw httpError(503, `Plan "${plan}" has no Stripe test price configured`)
    const session = await stripeCall(env, '/v1/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      client_reference_id: userId,
      'metadata[jiyu_user]': userId,
      'metadata[jiyu_plan]': plan,
      'subscription_data[metadata][jiyu_user]': userId,
      'subscription_data[metadata][jiyu_plan]': plan,
      customer: row?.provider === 'stripe' ? row.provider_customer_id : undefined,
      success_url: `${returnBase}?result=success`,
      cancel_url: `${returnBase}?result=cancel`,
    })
    if (session.livemode === true) throw httpError(503, 'Live-mode session refused')
    return { url: session.url }
  },
  async createPortal({ env, row, returnBase }) {
    if (row?.provider !== 'stripe' || !row.provider_customer_id) throw httpError(409, 'No subscription to manage yet')
    const portal = await stripeCall(env, '/v1/billing_portal/sessions', {
      customer: row.provider_customer_id,
      return_url: `${returnBase}?result=portal`,
    })
    return { url: portal.url }
  },
}

const ADAPTERS = { none: noneAdapter, test: testAdapter, stripe: stripeAdapter }

function adapterFor(cfg) {
  return ADAPTERS[cfg.provider] || noneAdapter
}

// ---------------------------------------------------------------- webhook application

async function applyEvent(env, providerName, event) {
  const now = Date.now()
  const fresh = await env.DB.prepare(
    'INSERT OR IGNORE INTO billing_events (provider, event_id, type, user_id, received_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(providerName, event.id, event.type, event.userId || null, now)
    .run()
  if (!fresh.meta?.changes) return { ok: true, duplicate: true }
  if (!event.patch) return { ok: true, ignored: true }

  let row = null
  if (event.userId) {
    row = await env.DB.prepare('SELECT * FROM entitlements WHERE user_id = ?').bind(event.userId).first()
  }
  if (!row && event.customerId) {
    row = await env.DB.prepare('SELECT * FROM entitlements WHERE provider = ? AND provider_customer_id = ?')
      .bind(providerName, event.customerId)
      .first()
  }
  let userId = row?.user_id || event.userId || null
  if (!userId) return { ok: true, unmatched: true }
  if (!row) {
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
    if (!user) return { ok: true, unmatched: true }
  }
  if (row && Number(row.last_event_at || 0) > event.created) return { ok: true, stale: true }

  const p = event.patch
  const status = p.status && SETTABLE_STATUSES.has(p.status) ? p.status : row?.status || 'expired'
  const plan = p.plan || row?.plan || 'paid'
  const periodEnd =
    p.currentPeriodEnd !== undefined ? (p.currentPeriodEnd == null ? null : Number(p.currentPeriodEnd)) : row?.current_period_end ?? null
  const cancel = p.cancelAtPeriodEnd !== undefined ? (p.cancelAtPeriodEnd ? 1 : 0) : Number(row?.cancel_at_period_end || 0)
  await env.DB.prepare(
    `INSERT INTO entitlements
       (user_id, plan, status, trial_started_at, trial_ends_at, current_period_end, cancel_at_period_end,
        provider, provider_customer_id, provider_subscription_id, last_event_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (user_id) DO UPDATE SET
       plan = excluded.plan, status = excluded.status, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, provider = excluded.provider,
       provider_customer_id = COALESCE(excluded.provider_customer_id, entitlements.provider_customer_id),
       provider_subscription_id = COALESCE(excluded.provider_subscription_id, entitlements.provider_subscription_id),
       last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      plan,
      status,
      periodEnd,
      cancel,
      providerName,
      event.customerId || null,
      event.subscriptionId || null,
      event.created,
      now,
    )
    .run()
  return { ok: true, applied: true }
}

// ---------------------------------------------------------------- routes

const RETURN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Jiyu</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh">
<div style="text-align:center;max-width:28rem"><h1 style="font-size:1.3rem">You can go back to Jiyu now</h1>
<p style="opacity:.75">Your plan updates in the app within a minute. You can close this tab.</p></div></body>`

/**
 * @param {{ json: Function, fail: Function, readJson: Function }} helpers from index.js
 */
export function createBilling({ json, fail, readJson }) {
  function off() {
    return fail(404, 'Billing is not enabled')
  }

  /** Unauthenticated billing routes. Returns null when the path is not a billing path. */
  async function publicRoute(request, env, url, path, method) {
    if (!path.startsWith('/v1/billing/')) return null
    const cfg = billingConfig(env)
    if (method === 'GET' && path === '/v1/billing/return') {
      if (!cfg.enabled) return off()
      return new Response(RETURN_PAGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    if (method === 'GET' && path === '/v1/billing/plans') {
      if (!cfg.enabled) return off()
      return json(200, { provider: cfg.provider, trialDays: Math.round(cfg.trialMs / DAY_MS), plans: plansFromEnv(env) })
    }
    if (method === 'POST' && path.startsWith('/v1/billing/webhook/')) {
      if (!cfg.enabled) return off()
      const name = path.slice('/v1/billing/webhook/'.length)
      if (name !== cfg.provider || name === 'none') return fail(404, 'Unknown billing provider')
      const len = Number(request.headers.get('Content-Length') || 0)
      if (len > MAX_WEBHOOK_BYTES) return fail(413, 'Body too large')
      const raw = await request.text()
      if (raw.length > MAX_WEBHOOK_BYTES) return fail(413, 'Body too large')
      const event = await adapterFor(cfg).parseWebhook(request, raw, env)
      if (!event) return json(200, { ok: true, ignored: true })
      return json(200, await applyEvent(env, name, event))
    }
    return null
  }

  /** Authenticated billing routes (/v1/entitlement, /v1/billing/*). Returns null for other paths. */
  async function authedRoute(request, env, auth, url, path, method, loopback) {
    if (path !== '/v1/entitlement' && !path.startsWith('/v1/billing/')) return null
    const cfg = billingConfig(env)
    if (!cfg.enabled) return off()
    const returnBase = `${url.origin}/v1/billing/return`

    if (method === 'GET' && path === '/v1/entitlement') {
      const row = await loadOrStartTrial(env, auth.userId, cfg)
      return json(200, entitlementBody(row, Date.now(), cfg))
    }

    if (method === 'POST' && path === '/v1/billing/checkout') {
      const body = await readJson(request)
      const plan = String(body.plan || 'monthly')
      if (!plansFromEnv(env).some((p) => p.id === plan)) return fail(400, 'Unknown plan')
      const row = await loadOrStartTrial(env, auth.userId, cfg)
      return json(200, await adapterFor(cfg).createCheckout({ env, userId: auth.userId, plan, row, returnBase }))
    }

    if (method === 'POST' && path === '/v1/billing/portal') {
      const row = await loadOrStartTrial(env, auth.userId, cfg)
      return json(200, await adapterFor(cfg).createPortal({ env, row, returnBase }))
    }

    // Local testing only: needs BILLING_DEV_TOOLS = "true" AND a loopback host (wrangler dev).
    if (method === 'POST' && path === '/v1/billing/dev/entitlement') {
      if (!cfg.devTools || !loopback) return fail(404, 'Not found')
      const body = await readJson(request)
      const status = String(body.status || '')
      if (!SETTABLE_STATUSES.has(status)) return fail(400, 'Unknown status')
      const now = Date.now()
      const trialEnd = body.trialEndsInMs == null ? null : now + Number(body.trialEndsInMs)
      const periodEnd = body.periodEndsInMs == null ? null : now + Number(body.periodEndsInMs)
      await env.DB.prepare(
        `INSERT INTO entitlements (user_id, plan, status, trial_started_at, trial_ends_at, current_period_end,
           cancel_at_period_end, provider, last_event_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'dev', 0, ?4)
         ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status,
           trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
      )
        .bind(auth.userId, String(body.plan || 'dev'), status, now, trialEnd, periodEnd, body.cancelAtPeriodEnd ? 1 : 0)
        .run()
      const row = await env.DB.prepare('SELECT * FROM entitlements WHERE user_id = ?').bind(auth.userId).first()
      return json(200, entitlementBody(row, now, cfg))
    }

    return fail(404, 'Not found')
  }

  /**
   * Extra statements for revokeDevice when an account's last device is removed.
   * Billing off: nothing (no new tables touched). Billing on: unpaid rows are dropped with the
   * account; a paid account keeps its users + entitlements rows so a subscription is never orphaned
   * by deleting the data it pays for (recovery flow: see docs/payments.md, decision D3).
   */
  async function lastDeviceCleanup(env, userId) {
    const cfg = billingConfig(env)
    if (!cfg.enabled) return { keepUser: false, stmts: [] }
    const row = await env.DB.prepare('SELECT status, current_period_end FROM entitlements WHERE user_id = ?')
      .bind(userId)
      .first()
    const paid = Boolean(row && PAID_STATUSES.has(row.status) && evaluateEntitlement(row, Date.now(), cfg).entitled)
    if (paid) return { keepUser: true, stmts: [] }
    return { keepUser: false, stmts: [env.DB.prepare('DELETE FROM entitlements WHERE user_id = ?').bind(userId)] }
  }

  return { publicRoute, authedRoute, lastDeviceCleanup }
}
