/**
 * Local billing tests for jiyu-sync. Never touches the live worker or a real Stripe account.
 *
 *   node workers/jiyu-sync/test/billing-local.mjs
 *
 * 1. Unit checks of evaluateEntitlement + webhook signature verification (no network).
 * 2. Starts a loopback mock of the Stripe API, then `wrangler dev --local` with a throwaway
 *    persisted D1 in the OS temp dir, BILLING_ENABLED=true, BILLING_PROVIDER=stripe, and
 *    random fake sk_test_ / whsec_ values passed with --var (nothing written to disk in the repo).
 * 3. Runs trial -> checkout -> signed webhooks -> cancel -> expire, plus idempotency, bad
 *    signatures, live-mode refusal and the dev grant route.
 * 4. Restarts wrangler with billing OFF and checks that billing routes 404 and sync still works.
 *
 * Env: BILLING_TEST_PORT (default 8799), KEEP_TEMP=1 to keep the temp D1 folder.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateEntitlement, verifySignedPayload, billingConfig } from '../src/billing.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.resolve(here, '..')
const PORT = Number(process.env.BILLING_TEST_PORT || 8799)
const BASE = `http://127.0.0.1:${PORT}`
const DAY = 24 * 3600 * 1000

let failures = 0
let passes = 0
function check(name, ok, detail) {
  if (ok) {
    passes++
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.log(`FAIL ${name}${detail !== undefined ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

// ------------------------------------------------------------------ 1. unit checks
async function unit() {
  const cfg = billingConfig({ BILLING_ENABLED: 'true', BILLING_PAST_DUE_GRACE_DAYS: '3' })
  const now = Date.now()
  check('unit: config defaults off', billingConfig({}).enabled === false && billingConfig({}).provider === 'none')
  check('unit: trial active', evaluateEntitlement({ status: 'trialing', trial_ends_at: now + 1000 }, now, cfg).entitled)
  check('unit: trial expired', !evaluateEntitlement({ status: 'trialing', trial_ends_at: now - 1 }, now, cfg).entitled)
  check('unit: active within period', evaluateEntitlement({ status: 'active', current_period_end: now + DAY }, now, cfg).entitled)
  check('unit: active 1 day past period (webhook slack)', evaluateEntitlement({ status: 'active', current_period_end: now - DAY }, now, cfg).entitled)
  check('unit: active 3 days past period expires', !evaluateEntitlement({ status: 'active', current_period_end: now - 3 * DAY }, now, cfg).entitled)
  check('unit: past_due grace', evaluateEntitlement({ status: 'past_due', current_period_end: now - 2 * DAY }, now, cfg).entitled)
  check('unit: past_due after grace', !evaluateEntitlement({ status: 'past_due', current_period_end: now - 4 * DAY }, now, cfg).entitled)
  check('unit: canceled until period end', evaluateEntitlement({ status: 'canceled', current_period_end: now + 1 }, now, cfg).entitled)
  check('unit: comp forever', evaluateEntitlement({ status: 'comp', current_period_end: null }, now, cfg).entitled)
  check('unit: no row', !evaluateEntitlement(null, now, cfg).entitled)

  const secret = 'whsec_unit'
  const body = '{"a":1}'
  const t = Math.floor(now / 1000)
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  check('unit: signature ok', (await verifySignedPayload(body, `t=${t},v1=${sig}`, secret, t)).ok)
  check('unit: signature ok with extra v1/v0', (await verifySignedPayload(body, `t=${t},v0=zz,v1=${'0'.repeat(64)},v1=${sig}`, secret, t)).ok)
  check('unit: tampered body rejected', !(await verifySignedPayload('{"a":2}', `t=${t},v1=${sig}`, secret, t)).ok)
  check('unit: old timestamp rejected', !(await verifySignedPayload(body, `t=${t},v1=${sig}`, secret, t + 301)).ok)
  check('unit: wrong secret rejected', !(await verifySignedPayload(body, `t=${t},v1=${sig}`, 'whsec_other', t)).ok)
  check('unit: missing secret rejected', !(await verifySignedPayload(body, `t=${t},v1=${sig}`, '', t)).ok)
  check('unit: missing header rejected', !(await verifySignedPayload(body, '', secret, t)).ok)
}

// ------------------------------------------------------------------ 2. mock Stripe API
const stripeCalls = []
function startMockStripe() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(data))
        stripeCalls.push({ path: req.url, auth: req.headers.authorization || '', params })
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/v1/checkout/sessions') {
          res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', livemode: false, url: 'https://checkout.stripe.com/c/pay/cs_test_1' }))
        } else if (req.url === '/v1/billing_portal/sessions') {
          res.end(JSON.stringify({ id: 'bps_test_1', livemode: false, url: 'https://billing.stripe.com/p/session/test_1' }))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: { message: 'mock: unknown path' } }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ------------------------------------------------------------------ wrangler helpers
function npx(args, opts = {}) {
  return spawnSync('npx', ['--yes', 'wrangler', ...args], { cwd: workerDir, shell: true, encoding: 'utf8', ...opts })
}

/** Stops only the wrangler dev process tree this script started. */
function stopChild(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

async function startWrangler(persistDir, vars) {
  const args = ['--yes', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', `"${persistDir}"`]
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`)
  const child = spawn('npx', args, { cwd: workerDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/v1/health`)
      if (res.ok) return child
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 500))
  }
  stopChild(child)
  // Mask the fake --var values anyway.
  throw new Error(`wrangler dev did not start:\n${log.replace(/(sk_test_|whsec_)[A-Za-z0-9]+/g, '$1***').slice(-3000)}`)
}

async function call(method, p, { token, body, raw, headers } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

function stripeSigned(secret, event, tOverride) {
  const raw = JSON.stringify(event)
  const t = tOverride ?? Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return { raw, headers: { 'Stripe-Signature': `t=${t},v1=${v1}` } }
}

let eventSeq = 0
function stripeEvent(type, object, createdS) {
  eventSeq++
  return { id: `evt_test_${eventSeq}`, object: 'event', livemode: false, type, created: createdS ?? Math.floor(Date.now() / 1000) + eventSeq, data: { object } }
}

function sql(persistDir, query) {
  const out = npx(['d1', 'execute', 'jiyu-sync', '--local', '--persist-to', `"${persistDir}"`, '--json', '--command', `"${query}"`])
  try {
    return JSON.parse(out.stdout)[0].results
  } catch {
    return { error: (out.stderr || out.stdout || '').slice(-500) }
  }
}

// ------------------------------------------------------------------ 3. billing ON
async function billingOn(persistDir, mockPort) {
  const stripeKey = `sk_test_${randomBytes(18).toString('hex')}`
  const whsec = `whsec_${randomBytes(18).toString('hex')}`
  const child = await startWrangler(persistDir, {
    BILLING_ENABLED: 'true',
    BILLING_PROVIDER: 'stripe',
    BILLING_DEV_TOOLS: 'true',
    BILLING_TRIAL_DAYS: '7',
    STRIPE_SECRET_KEY: stripeKey,
    STRIPE_WEBHOOK_SECRET: whsec,
    STRIPE_PRICE_MONTHLY: 'price_test_monthly',
    STRIPE_PRICE_YEARLY: 'price_test_yearly',
    STRIPE_API_BASE: `http://127.0.0.1:${mockPort}`,
  })
  const hook = (signed) => call('POST', '/v1/billing/webhook/stripe', signed)
  try {
    const reg = await call('POST', '/v1/auth/register', { body: { label: 'billing test A' } })
    check('on: register', reg.status === 200 && reg.data.token, reg)
    const A = reg.data

    const plans = await call('GET', '/v1/billing/plans')
    check('on: plans listed', plans.status === 200 && plans.data.plans.length >= 1 && plans.data.trialDays === 7, plans)
    check('on: entitlement needs auth', (await call('GET', '/v1/entitlement')).status === 401)

    const e1 = await call('GET', '/v1/entitlement', { token: A.token })
    const trialLen = e1.data.trialEndsAt - e1.data.now
    check('on: lazy trial started', e1.status === 200 && e1.data.entitled && e1.data.status === 'trialing' && Math.abs(trialLen - 7 * DAY) < 60_000, e1)
    const e1b = await call('GET', '/v1/entitlement', { token: A.token })
    check('on: trial not restarted on recheck', e1b.data.trialEndsAt === e1.data.trialEndsAt, e1b)

    const bad = await call('POST', '/v1/billing/checkout', { token: A.token, body: { plan: 'lifetime' } })
    check('on: unknown plan rejected', bad.status === 400, bad)

    const co = await call('POST', '/v1/billing/checkout', { token: A.token, body: { plan: 'monthly' } })
    const coCall = stripeCalls.find((c) => c.path === '/v1/checkout/sessions')
    check('on: checkout returns Stripe URL', co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.data.url), co)
    check(
      'on: checkout sent subscription + user ref + test key',
      coCall &&
        coCall.params.mode === 'subscription' &&
        coCall.params.client_reference_id === A.userId &&
        coCall.params['line_items[0][price]'] === 'price_test_monthly' &&
        coCall.params['subscription_data[metadata][jiyu_user]'] === A.userId &&
        coCall.auth === `Bearer ${stripeKey}` &&
        coCall.params.success_url === `${BASE}/v1/billing/return?result=success`,
      coCall && { path: coCall.path, params: coCall.params },
    )
    const portal0 = await call('POST', '/v1/billing/portal', { token: A.token })
    check('on: portal refused before subscription', portal0.status === 409, portal0)
    await webhookChecks(A, whsec, hook)
    await accountChecks(persistDir, child)
  } finally {
    stopChild(child)
  }
}

async function webhookChecks(A, whsec, hook) {
  check('on: unsigned webhook rejected', (await call('POST', '/v1/billing/webhook/stripe', { raw: JSON.stringify(stripeEvent('checkout.session.completed', {})) })).status === 400)
  check('on: wrong-secret webhook rejected', (await hook(stripeSigned('whsec_wrong', stripeEvent('checkout.session.completed', {})))).status === 400)
  check('on: old-timestamp (replay) webhook rejected', (await hook(stripeSigned(whsec, stripeEvent('checkout.session.completed', {}), Math.floor(Date.now() / 1000) - 600))).status === 400)
  check('on: live-mode event refused', (await hook(stripeSigned(whsec, { ...stripeEvent('checkout.session.completed', {}), livemode: true }))).status === 400)
  check('on: other provider path 404', (await call('POST', '/v1/billing/webhook/test', stripeSigned(whsec, stripeEvent('x', {})))).status === 404)

  const completed = stripeEvent('checkout.session.completed', {
    id: 'cs_test_1', mode: 'subscription', client_reference_id: A.userId, customer: 'cus_test_A', subscription: 'sub_test_A',
    metadata: { jiyu_user: A.userId, jiyu_plan: 'monthly' },
  })
  const w1 = await hook(stripeSigned(whsec, completed))
  check('on: checkout.session.completed applied', w1.status === 200 && w1.data.applied, w1)
  const w1dup = await hook(stripeSigned(whsec, completed))
  check('on: duplicate event is idempotent', w1dup.status === 200 && w1dup.data.duplicate, w1dup)

  const periodEnd = Math.floor((Date.now() + 30 * DAY) / 1000)
  const subObj = {
    id: 'sub_test_A', object: 'subscription', customer: 'cus_test_A', status: 'active', cancel_at_period_end: false,
    metadata: { jiyu_user: A.userId, jiyu_plan: 'monthly' },
    items: { data: [{ current_period_end: periodEnd, price: { id: 'price_test_monthly' } }] },
  }
  const w2 = await hook(stripeSigned(whsec, stripeEvent('customer.subscription.created', subObj)))
  check('on: subscription.created applied', w2.data?.applied, w2)
  const e2 = await call('GET', '/v1/entitlement', { token: A.token })
  check('on: now active monthly, period end from items',
    e2.data.entitled && e2.data.status === 'active' && e2.data.plan === 'monthly' && e2.data.currentPeriodEnd === periodEnd * 1000 && e2.data.canManage, e2)

  const portal = await call('POST', '/v1/billing/portal', { token: A.token })
  const pCall = stripeCalls.find((c) => c.path === '/v1/billing_portal/sessions')
  check('on: portal session for customer', portal.status === 200 && pCall?.params.customer === 'cus_test_A', portal)

  const unknownType = await hook(stripeSigned(whsec, stripeEvent('charge.succeeded', { customer: 'cus_test_A' })))
  check('on: unhandled event type recorded + ignored', unknownType.status === 200 && unknownType.data.ignored, unknownType)
  const stale = await hook(stripeSigned(whsec, stripeEvent('customer.subscription.updated', { ...subObj, status: 'past_due' }, 1000)))
  check('on: out-of-order (older) event not applied', stale.data?.stale, stale)

  const failed = await hook(stripeSigned(whsec, stripeEvent('invoice.payment_failed', { customer: 'cus_test_A', subscription: 'sub_test_A' })))
  const e3 = await call('GET', '/v1/entitlement', { token: A.token })
  check('on: payment_failed -> past_due, still entitled (grace)', failed.data?.applied && e3.data.status === 'past_due' && e3.data.entitled, e3)

  await hook(stripeSigned(whsec, stripeEvent('customer.subscription.updated', { ...subObj, cancel_at_period_end: true })))
  const e4 = await call('GET', '/v1/entitlement', { token: A.token })
  check('on: cancel at period end keeps access', e4.data.status === 'active' && e4.data.cancelAtPeriodEnd && e4.data.entitled, e4)

  await hook(stripeSigned(whsec, stripeEvent('customer.subscription.deleted', { ...subObj, status: 'canceled' })))
  const e5 = await call('GET', '/v1/entitlement', { token: A.token })
  check('on: subscription.deleted -> expired, no access', e5.data.status === 'expired' && !e5.data.entitled, e5)

  const orphan = await hook(stripeSigned(whsec, stripeEvent('invoice.payment_failed', { customer: 'cus_nobody' })))
  check('on: unknown customer is recorded, not applied', orphan.status === 200 && orphan.data.unmatched, orphan)
}

async function accountChecks(persistDir, child) {
  // Dev grant route (loopback + BILLING_DEV_TOOLS only)
  const B = (await call('POST', '/v1/auth/register', { body: { label: 'billing test B' } })).data
  const expired = await call('POST', '/v1/billing/dev/entitlement', { token: B.token, body: { status: 'trialing', trialEndsInMs: -1000 } })
  check('on: dev route -> expired trial', expired.status === 200 && !expired.data.entitled && expired.data.status === 'expired', expired)
  const comp = await call('POST', '/v1/billing/dev/entitlement', { token: B.token, body: { status: 'comp' } })
  check('on: dev route -> comp', comp.data.entitled && comp.data.status === 'comp', comp)

  // Entitlement is per account (a paired device shares it) and sync still works
  const pair = await call('POST', '/v1/auth/pair', { body: { code: B.pairCode, label: 'billing test B2' } })
  const eB2 = await call('GET', '/v1/entitlement', { token: pair.data.token })
  check('on: paired device shares account entitlement', pair.status === 200 && eB2.data.status === 'comp', eB2)
  const put = await call('PUT', '/v1/progress', { token: B.token, body: { entries: [{ id: 'm1', title: 'Test', category: 'movies', currentTime: 10, duration: 100, ageMs: 0 }] } })
  check('on: progress sync unaffected', put.status === 200 && put.data.results?.[0]?.accepted, put)

  // Last-device removal: unpaid entitlement goes with the account, a paid one is kept
  const C = (await call('POST', '/v1/auth/register', { body: { label: 'billing test C' } })).data
  await call('GET', '/v1/entitlement', { token: C.token })
  check('on: signout of unpaid account ok', (await call('POST', '/v1/auth/signout', { token: C.token })).status === 200)
  await call('POST', '/v1/auth/signout', { token: pair.data.token })
  check('on: signout of paid account ok', (await call('POST', '/v1/auth/signout', { token: B.token })).status === 200)
  stopChild(child)
  const found = sql(persistDir, `SELECT user_id, status FROM entitlements WHERE user_id IN ('${C.userId}','${B.userId}')`)
  check('on: unpaid entitlement deleted with account, paid one kept',
    Array.isArray(found) && found.length === 1 && found[0].user_id === B.userId, found)
}

// ------------------------------------------------------------------ 4. billing OFF (default config)
async function billingOff(persistDir) {
  const child = await startWrangler(persistDir, {})
  let userId = null
  try {
    const reg = await call('POST', '/v1/auth/register', { body: { label: 'billing off' } })
    check('off: register', reg.status === 200, reg)
    const t = reg.data.token
    userId = reg.data.userId
    check('off: /v1/entitlement 404', (await call('GET', '/v1/entitlement', { token: t })).status === 404)
    check('off: /v1/billing/plans 404', (await call('GET', '/v1/billing/plans')).status === 404)
    check('off: /v1/billing/checkout 404', (await call('POST', '/v1/billing/checkout', { token: t, body: { plan: 'monthly' } })).status === 404)
    check('off: webhook 404', (await call('POST', '/v1/billing/webhook/stripe', { raw: '{}' })).status === 404)
    check('off: dev route 404', (await call('POST', '/v1/billing/dev/entitlement', { token: t, body: { status: 'comp' } })).status === 404)
    const put = await call('PUT', '/v1/progress', { token: t, body: { entries: [{ id: 'x1', title: 'Off', category: 'movies', currentTime: 5, duration: 50, ageMs: 0 }] } })
    const pull = await call('GET', '/v1/progress?since=0', { token: t })
    check('off: sync push/pull unchanged', put.status === 200 && pull.data.entries?.some((e) => e.id === 'x1'), pull)
    check('off: signout works', (await call('POST', '/v1/auth/signout', { token: t })).status === 200)
  } finally {
    stopChild(child)
  }
  const rows = sql(persistDir, `SELECT COUNT(*) AS n FROM entitlements WHERE user_id = '${userId}'`)
  check('off: no entitlement row written', Array.isArray(rows) && rows[0]?.n === 0, rows)
  const users = sql(persistDir, `SELECT COUNT(*) AS n FROM users WHERE id = '${userId}'`)
  check('off: last-device signout still deletes the account', Array.isArray(users) && users[0]?.n === 0, users)
}

// ------------------------------------------------------------------ main
await unit()
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiyu-billing-test-'))
const mock = await startMockStripe()
try {
  const mig = npx(['d1', 'migrations', 'apply', 'jiyu-sync', '--local', '--persist-to', `"${persistDir}"`], { input: 'y\n' })
  check('setup: local D1 migrations applied', mig.status === 0, (mig.stderr || mig.stdout || '').slice(-800))
  await billingOn(persistDir, mock.address().port)
  await billingOff(persistDir)
} catch (err) {
  failures++
  console.log(`FAIL harness :: ${err?.message || err}`)
} finally {
  mock.close()
  if (!process.env.KEEP_TEMP) fs.rmSync(persistDir, { recursive: true, force: true })
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
