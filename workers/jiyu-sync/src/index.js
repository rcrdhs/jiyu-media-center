/**
 * jiyu-sync — cross-device Continue watching for every Jiyu build (Android, desktop).
 *
 * Storage: Cloudflare D1 (binding DB). Free-tier friendly: indexed reads only, one batch per
 * write request, at most one `last_seen_at` write per device per hour.
 *
 * Security
 *  - Device tokens are 32 random bytes (base64url, "jys_" prefix). Only SHA-256 hashes are stored.
 *  - Pair codes are 8 random characters, single-use (deleted on redeem), expire after 10 minutes,
 *    stored hashed, and pairing / registration are rate limited per IP.
 *  - HTTPS only (loopback http allowed for `wrangler dev`).
 *  - The server stamps every row: `rev` (per-user monotonic revision) and `updatedAt` (server
 *    clock). Clients send how long ago they edited a row (`ageMs`), never their wall clock, so a
 *    device with a wrong clock can't win every conflict.
 */

import { createBilling } from './billing.js'

const PAIR_TTL_MS = 10 * 60 * 1000
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
const MAX_DEVICES = 10
const MAX_ENTRIES_PER_PUT = 100
const MAX_ROW_BYTES = 4096
const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const LAST_SEEN_WRITE_MS = 3600 * 1000
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

const RECORD_FIELDS = {
  title: 'string',
  poster: 'string',
  category: 'string',
  playlistIndex: 'number',
  episodeTitle: 'string',
  currentTime: 'number',
  duration: 'number',
  runtimeSeconds: 'number',
  torrentUri: 'string',
  detailUrl: 'string',
  playUrl: 'string',
  transport: 'string',
  sourceKind: 'string',
  source: 'string',
}
const CATEGORIES = new Set(['movies', 'series', 'anime', 'kids'])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  })
}

function fail(status, error) {
  return json(status, { error })
}

function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(n) {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

function randomId(prefix) {
  return `${prefix}_${[...randomBytes(12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function newToken() {
  return `jys_${b64url(randomBytes(32))}`
}

function newPairCode() {
  const bytes = randomBytes(8)
  let code = ''
  for (const b of bytes) code += PAIR_ALPHABET[b % 32]
  return code
}

function normalizePairCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16)
}

function cleanLabel(raw, fallback) {
  const s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return s || fallback
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}

async function limited(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return false
  try {
    const { success } = await limiter.limit({ key })
    return !success
  } catch {
    return false
  }
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0)
  if (len > 512 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 })
  const text = await request.text()
  if (text.length > 512 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 })
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 })
  }
}

async function authDevice(request, env) {
  const header = request.headers.get('Authorization') || ''
  const m = /^Bearer\s+(jys_[A-Za-z0-9_-]{40,})$/.exec(header.trim())
  if (!m) return null
  const hash = await sha256Hex(m[1])
  const row = await env.DB.prepare(
    'SELECT id, user_id, label, last_seen_at FROM devices WHERE token_hash = ?',
  )
    .bind(hash)
    .first()
  if (!row) return null
  const now = Date.now()
  if (now - Number(row.last_seen_at || 0) > LAST_SEEN_WRITE_MS) {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run()
  }
  return { deviceId: row.id, userId: row.user_id, label: row.label }
}

async function issuePairCode(env, userId) {
  const now = Date.now()
  const code = newPairCode()
  const expiresAt = now + PAIR_TTL_MS
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pair_codes WHERE user_id = ? OR expires_at < ?').bind(userId, now),
    env.DB.prepare('INSERT INTO pair_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(
      await sha256Hex(code),
      userId,
      expiresAt,
    ),
  ])
  return { pairCode: code, pairCodeExpiresAt: expiresAt }
}

async function createDevice(env, userId, label) {
  const token = newToken()
  const deviceId = randomId('d')
  const now = Date.now()
  const stmt = env.DB.prepare(
    'INSERT INTO devices (id, user_id, token_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(deviceId, userId, await sha256Hex(token), label, now, now)
  return { token, deviceId, stmt }
}

/** Sanitised record body stored in `data` (id / rev / updatedAt / deleted live in columns). */
function sanitizeRecord(input) {
  const out = {}
  for (const [key, type] of Object.entries(RECORD_FIELDS)) {
    const v = input[key]
    if (v === undefined || v === null) continue
    if (type === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) out[key] = Math.max(0, Math.min(n, 1e7))
    } else if (typeof v === 'string') {
      out[key] = v.slice(0, 1500)
    }
  }
  if (!CATEGORIES.has(out.category)) out.category = 'movies'
  return out
}

function rowToRecord(row) {
  let data = {}
  try {
    data = JSON.parse(row.data || '{}')
  } catch {
    data = {}
  }
  return {
    ...data,
    id: row.item_id,
    rev: Number(row.rev),
    updatedAt: Number(row.updated_at),
    ...(Number(row.deleted) ? { deleted: true } : {}),
  }
}

async function pullProgress(env, userId, since) {
  const [entries, user] = await env.DB.batch([
    env.DB.prepare(
      'SELECT item_id, rev, updated_at, deleted, data FROM progress WHERE user_id = ? AND rev > ? ORDER BY rev',
    ).bind(userId, since),
    env.DB.prepare('SELECT rev FROM users WHERE id = ?').bind(userId),
  ])
  return {
    entries: (entries.results || []).map(rowToRecord),
    rev: Number(user.results?.[0]?.rev || 0),
    now: Date.now(),
  }
}

async function pushProgress(env, userId, rawEntries) {
  if (!Array.isArray(rawEntries)) throw Object.assign(new Error('entries must be an array'), { status: 400 })
  if (rawEntries.length > MAX_ENTRIES_PER_PUT) {
    throw Object.assign(new Error(`At most ${MAX_ENTRIES_PER_PUT} entries per request`), { status: 413 })
  }
  const now = Date.now()
  /** @type {Map<string, { id: string, updatedAt: number, deleted: boolean, data: string }>} */
  const incoming = new Map()
  for (const raw of rawEntries) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 300) continue
    const age = Number.isFinite(Number(raw.ageMs)) ? Math.max(0, Math.min(Number(raw.ageMs), MAX_AGE_MS)) : 0
    const updatedAt = now - age
    const deleted = Boolean(raw.deleted)
    const data = JSON.stringify(deleted ? { category: sanitizeRecord(raw).category } : sanitizeRecord(raw))
    if (data.length > MAX_ROW_BYTES) continue
    const prev = incoming.get(raw.id)
    if (!prev || updatedAt >= prev.updatedAt) incoming.set(raw.id, { id: raw.id, updatedAt, deleted, data })
  }
  if (incoming.size === 0) {
    const user = await env.DB.prepare('SELECT rev FROM users WHERE id = ?').bind(userId).first()
    return { results: [], rev: Number(user?.rev || 0), now }
  }

  const ids = [...incoming.keys()]
  const existing = await env.DB.prepare(
    'SELECT item_id, rev, updated_at, deleted, data FROM progress WHERE user_id = ? AND item_id IN (SELECT value FROM json_each(?))',
  )
    .bind(userId, JSON.stringify(ids))
    .all()
  const byId = new Map((existing.results || []).map((row) => [row.item_id, row]))

  const accepted = []
  const results = []
  for (const row of incoming.values()) {
    const prev = byId.get(row.id)
    // Server-clock last-writer-wins. Equal edit times keep the further playhead.
    let ok = !prev || row.updatedAt > Number(prev.updated_at)
    if (prev && !ok && row.updatedAt === Number(prev.updated_at) && !row.deleted && !Number(prev.deleted)) {
      try {
        ok = Number(JSON.parse(row.data).currentTime || 0) > Number(JSON.parse(prev.data).currentTime || 0)
      } catch {
        ok = false
      }
    }
    if (ok) accepted.push(row)
    else results.push({ id: row.id, accepted: false, current: rowToRecord(prev) })
  }

  let rev = 0
  if (accepted.length > 0) {
    const stmts = [env.DB.prepare('UPDATE users SET rev = rev + 1 WHERE id = ?').bind(userId)]
    for (const row of accepted) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO progress (user_id, item_id, rev, updated_at, deleted, data)
           VALUES (?1, ?2, (SELECT rev FROM users WHERE id = ?1), ?3, ?4, ?5)
           ON CONFLICT (user_id, item_id) DO UPDATE SET
             rev = excluded.rev, updated_at = excluded.updated_at, deleted = excluded.deleted, data = excluded.data
           WHERE excluded.updated_at >= progress.updated_at`,
        ).bind(userId, row.id, row.updatedAt, row.deleted ? 1 : 0, row.data),
      )
    }
    stmts.push(env.DB.prepare('SELECT rev FROM users WHERE id = ?').bind(userId))
    const out = await env.DB.batch(stmts)
    rev = Number(out[out.length - 1].results?.[0]?.rev || 0)
    for (const row of accepted) {
      results.push({ id: row.id, accepted: true, rev, updatedAt: row.updatedAt, ...(row.deleted ? { deleted: true } : {}) })
    }
    // Occasionally drop old tombstones so storage stays tiny.
    if (Math.random() < 0.05) {
      await env.DB.prepare('DELETE FROM progress WHERE user_id = ? AND deleted = 1 AND updated_at < ?')
        .bind(userId, now - TOMBSTONE_TTL_MS)
        .run()
    }
  } else {
    const user = await env.DB.prepare('SELECT rev FROM users WHERE id = ?').bind(userId).first()
    rev = Number(user?.rev || 0)
  }
  return { results, rev, now }
}

// Entitlements / payments scaffold. Inert unless BILLING_ENABLED = "true" (docs/payments.md).
const billing = createBilling({ json, fail, readJson })

async function revokeDevice(env, userId, deviceId) {
  const res = await env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').bind(deviceId, userId).run()
  if (!res.meta?.changes) return false
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').bind(userId).first()
  if (!Number(left?.n)) {
    // Last device gone: nothing can read this account any more, so remove its data.
    // Billing off (default): exactly the original three deletes. Billing on: see billing.js.
    const extra = await billing.lastDeviceCleanup(env, userId)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM pair_codes WHERE user_id = ?').bind(userId),
      ...extra.stmts,
      ...(extra.keepUser ? [] : [env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)]),
    ])
  }
  return true
}

async function route(request, env) {
  const url = new URL(request.url)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) return fail(400, 'HTTPS required')
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method

  if (method === 'GET' && (path === '/' || path === '/v1/health')) {
    return json(200, { ok: true, service: 'jiyu-sync', version: 1 })
  }

  if (method === 'POST' && path === '/v1/auth/register') {
    if (await limited(env.AUTH_LIMITER, `reg:${clientIp(request)}`)) return fail(429, 'Too many attempts, try again in a minute')
    const body = await readJson(request)
    const userId = randomId('u')
    const label = cleanLabel(body.label, 'Jiyu device')
    const device = await createDevice(env, userId, label)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, created_at, rev) VALUES (?, ?, 0)').bind(userId, Date.now()),
      device.stmt,
    ])
    const pair = await issuePairCode(env, userId)
    return json(200, { token: device.token, userId, deviceId: device.deviceId, label, ...pair })
  }

  if (method === 'POST' && path === '/v1/auth/pair') {
    const ip = clientIp(request)
    if (await limited(env.AUTH_LIMITER, `pair:${ip}`)) return fail(429, 'Too many attempts, try again in a minute')
    const body = await readJson(request)
    const code = normalizePairCode(body.code)
    if (code.length !== 8) return fail(400, 'Enter the 8-character pair code')
    const row = await env.DB.prepare('DELETE FROM pair_codes WHERE code_hash = ? RETURNING user_id, expires_at')
      .bind(await sha256Hex(code))
      .first()
    if (!row) return fail(404, 'Pair code not found or already used')
    if (Number(row.expires_at) < Date.now()) return fail(410, 'Pair code expired — make a new one on the other device')
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').bind(row.user_id).first()
    if (Number(count?.n || 0) >= MAX_DEVICES) return fail(409, `At most ${MAX_DEVICES} devices per account`)
    const label = cleanLabel(body.label, 'Linked device')
    const device = await createDevice(env, row.user_id, label)
    await device.stmt.run()
    return json(200, { token: device.token, userId: row.user_id, deviceId: device.deviceId, label })
  }

  const billingPublic = await billing.publicRoute(request, env, url, path, method)
  if (billingPublic) return billingPublic

  // ---- authenticated routes
  const auth = await authDevice(request, env)
  if (!auth) return fail(401, 'Signed out — this device was removed or its sign-in is invalid')
  if (await limited(env.SYNC_LIMITER, `dev:${auth.deviceId}`)) return fail(429, 'Slow down')

  const billingAuthed = await billing.authedRoute(request, env, auth, url, path, method, loopback)
  if (billingAuthed) return billingAuthed

  if (method === 'POST' && path === '/v1/auth/pair-code') {
    return json(200, await issuePairCode(env, auth.userId))
  }

  if (method === 'POST' && path === '/v1/auth/signout') {
    await revokeDevice(env, auth.userId, auth.deviceId)
    return json(200, { ok: true })
  }

  if (method === 'GET' && path === '/v1/devices') {
    const rows = await env.DB.prepare(
      'SELECT id, label, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at',
    )
      .bind(auth.userId)
      .all()
    return json(200, {
      devices: (rows.results || []).map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: Number(r.created_at),
        lastSeenAt: Number(r.last_seen_at),
        current: r.id === auth.deviceId,
      })),
    })
  }

  if (method === 'DELETE' && path.startsWith('/v1/devices/')) {
    const id = decodeURIComponent(path.slice('/v1/devices/'.length))
    const ok = await revokeDevice(env, auth.userId, id)
    return ok ? json(200, { ok: true, self: id === auth.deviceId }) : fail(404, 'Device not found')
  }

  if (method === 'GET' && path === '/v1/progress') {
    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') || 0)) || 0)
    return json(200, await pullProgress(env, auth.userId, since))
  }

  if (method === 'PUT' && path === '/v1/progress') {
    const body = await readJson(request)
    const entries = Array.isArray(body.entries) ? body.entries : body.id ? [body] : null
    if (!entries) return fail(400, 'entries must be an array')
    return json(200, await pushProgress(env, auth.userId, entries))
  }

  if (method === 'DELETE' && path.startsWith('/v1/progress/')) {
    const id = decodeURIComponent(path.slice('/v1/progress/'.length))
    return json(200, await pushProgress(env, auth.userId, [{ id, deleted: true, ageMs: 0 }]))
  }

  return fail(404, 'Not found')
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env)
    } catch (err) {
      const status = Number(err?.status) || 500
      return fail(status, status === 500 ? 'Server error' : String(err?.message || err))
    }
  },
}
