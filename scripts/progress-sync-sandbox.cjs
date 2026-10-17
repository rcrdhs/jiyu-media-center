/**
 * Progress sync sandbox — proves the API contract + merge rules before
 * wiring production clients. No external cloud required.
 *
 *   node scripts/progress-sync-sandbox.cjs
 *
 * Starts an in-memory server on 127.0.0.1:8787, runs device A/B simulations,
 * exits 0 on success.
 */
const http = require('http')
const { pathToFileURL } = require('url')
const path = require('path')

const HOST = '127.0.0.1'
const PORT = 8787
const ROOT = path.resolve(__dirname, '..')

/** @type {Map<string, { userId: string, pairCode: string, label: string }>} */
const tokens = new Map()
/** @type {Map<string, string>} pairCode -> userId */
const pairCodes = new Map()
/** @type {Map<string, Map<string, any>>} userId -> itemId -> record */
const stores = new Map()

let nextUser = 1

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function authUser(req) {
  const header = String(req.headers.authorization || '')
  const m = /^Bearer\s+(.+)$/i.exec(header)
  if (!m) return null
  return tokens.get(m[1].trim()) || null
}

function makePairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  if (pairCodes.has(code)) return makePairCode()
  return code
}

function ensureStore(userId) {
  if (!stores.has(userId)) stores.set(userId, new Map())
  return stores.get(userId)
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        return json(res, 204, {})
      }

      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return json(res, 200, { ok: true, service: 'jiyu-progress-sync-sandbox' })
      }

      if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
        const body = await readBody(req)
        const userId = `user_${nextUser++}`
        const token = `tok_${userId}_${Date.now()}`
        const pairCode = makePairCode()
        const label = String(body.label || 'Jiyu account').slice(0, 64)
        tokens.set(token, { userId, pairCode, label })
        pairCodes.set(pairCode, userId)
        ensureStore(userId)
        return json(res, 200, { token, userId, pairCode, label })
      }

      if (req.method === 'POST' && url.pathname === '/v1/auth/pair') {
        const body = await readBody(req)
        const code = String(body.code || '')
          .trim()
          .toUpperCase()
        const userId = pairCodes.get(code)
        if (!userId) return json(res, 404, { error: 'Invalid pair code' })
        const token = `tok_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const label = `Linked device`
        tokens.set(token, { userId, pairCode: code, label })
        return json(res, 200, { token, userId, pairCode: code, label })
      }

      const session = authUser(req)
      if (!session) return json(res, 401, { error: 'Unauthorized' })

      if (req.method === 'GET' && url.pathname === '/v1/progress') {
        const store = ensureStore(session.userId)
        return json(res, 200, { entries: [...store.values()] })
      }

      if (req.method === 'PUT' && url.pathname === '/v1/progress') {
        const body = await readBody(req)
        const entries = Array.isArray(body.entries) ? body.entries : body.id ? [body] : []
        const store = ensureStore(session.userId)
        let upserted = 0
        for (const entry of entries) {
          if (!entry?.id) continue
          const prev = store.get(entry.id)
          if (!prev || Number(entry.updatedAt) >= Number(prev.updatedAt)) {
            store.set(entry.id, { ...prev, ...entry, id: String(entry.id) })
            upserted += 1
          }
        }
        return json(res, 200, { ok: true, upserted })
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/progress/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/progress/'.length))
        const store = ensureStore(session.userId)
        const prev = store.get(id)
        store.set(id, {
          id,
          title: prev?.title || id,
          category: prev?.category || 'movies',
          playlistIndex: prev?.playlistIndex || 0,
          currentTime: prev?.currentTime || 0,
          duration: prev?.duration || 0,
          updatedAt: Date.now(),
          deleted: true,
        })
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { error: 'Not found' })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  })
}

async function api(base, method, pathName, { token, body } = {}) {
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function runTests(base, mergeProgressRecords) {
  let passed = 0
  const ok = (name) => {
    passed += 1
    console.log(`  ✓ ${name}`)
  }

  // Merge unit cases (shared production logic)
  {
    const merged = mergeProgressRecords(
      [
        {
          id: 'a',
          title: 'A',
          category: 'anime',
          playlistIndex: 0,
          currentTime: 100,
          duration: 1400,
          updatedAt: 1000,
        },
      ],
      [
        {
          id: 'a',
          title: 'A',
          category: 'anime',
          playlistIndex: 0,
          currentTime: 500,
          duration: 1400,
          updatedAt: 2000,
        },
        {
          id: 'b',
          title: 'B',
          category: 'movies',
          playlistIndex: 0,
          currentTime: 50,
          duration: 7000,
          updatedAt: 1500,
          deleted: true,
        },
      ],
    )
    assert(merged.length === 1, 'tombstone removed')
    assert(merged[0].currentTime === 500, 'newer remote wins')
    ok('merge: newer remote playhead wins; tombstones drop')
  }

  {
    const merged = mergeProgressRecords(
      [
        {
          id: 'x',
          title: 'X',
          category: 'series',
          playlistIndex: 2,
          currentTime: 900,
          duration: 2400,
          updatedAt: 5000,
        },
      ],
      [
        {
          id: 'x',
          title: 'X',
          category: 'series',
          playlistIndex: 2,
          currentTime: 200,
          duration: 2400,
          updatedAt: 4000,
        },
      ],
    )
    assert(merged[0].currentTime === 900, 'stale remote must not rewind')
    ok('merge: stale remote cannot rewind local')
  }

  // Device A registers
  const a = await api(base, 'POST', '/v1/auth/register', {
    body: { label: 'Phone' },
  })
  assert(a.token && a.pairCode && a.userId, 'register returns session')
  ok('auth: register device A')

  // Device A pushes anime progress
  await api(base, 'PUT', '/v1/progress', {
    token: a.token,
    body: {
      entries: [
        {
          id: 'anime-slime-1',
          title: 'That Time I Got Reincarnated as a Slime',
          category: 'anime',
          playlistIndex: 1,
          episodeTitle: 'Meeting the Goblins',
          currentTime: 812,
          duration: 1440,
          updatedAt: 1_700_000_000_000,
        },
      ],
    },
  })
  ok('push: device A uploads progress')

  // Device B pairs with code
  const b = await api(base, 'POST', '/v1/auth/pair', {
    body: { code: a.pairCode },
  })
  assert(b.userId === a.userId, 'pair joins same account')
  ok('auth: device B pairs with code')

  // Device B pulls
  const pulled = await api(base, 'GET', '/v1/progress', { token: b.token })
  assert(pulled.entries.length === 1, 'B sees A progress')
  assert(pulled.entries[0].currentTime === 812, 'playhead matches')
  ok('pull: device B receives A progress')

  // B watches further and pushes
  await api(base, 'PUT', '/v1/progress', {
    token: b.token,
    body: {
      entries: [
        {
          ...pulled.entries[0],
          currentTime: 1100,
          updatedAt: 1_700_000_100_000,
        },
      ],
    },
  })
  const aPull = await api(base, 'GET', '/v1/progress', { token: a.token })
  assert(aPull.entries[0].currentTime === 1100, 'A sees B advance')
  ok('sync: later device B progress visible on A')

  // Stale write ignored by server (older updatedAt)
  await api(base, 'PUT', '/v1/progress', {
    token: a.token,
    body: {
      entries: [
        {
          ...aPull.entries[0],
          currentTime: 50,
          updatedAt: 1_600_000_000_000,
        },
      ],
    },
  })
  const afterStale = await api(base, 'GET', '/v1/progress', { token: b.token })
  assert(afterStale.entries[0].currentTime === 1100, 'stale put ignored')
  ok('conflict: older updatedAt does not overwrite')

  // Delete tombstone
  await api(base, 'DELETE', `/v1/progress/${encodeURIComponent('anime-slime-1')}`, {
    token: a.token,
  })
  const afterDel = await api(base, 'GET', '/v1/progress', { token: b.token })
  const live = afterDel.entries.filter((e) => !e.deleted)
  const tombs = afterDel.entries.filter((e) => e.deleted)
  assert(live.length === 0 && tombs.length === 1, 'delete stores tombstone')
  const clientView = mergeProgressRecords([], afterDel.entries)
  assert(clientView.length === 0, 'client merge hides tombstone')
  ok('delete: tombstone syncs; client merge hides it')

  // Unauthorized
  let unauthorized = false
  try {
    await api(base, 'GET', '/v1/progress')
  } catch (err) {
    unauthorized = err.status === 401
  }
  assert(unauthorized, 'missing token rejected')
  ok('auth: unauthorized without bearer token')

  console.log(`\nSandbox passed (${passed} checks)`)
}

async function main() {
  const mergeUrl = pathToFileURL(
    path.join(ROOT, 'src/lib/progressSync/mergeLogic.js'),
  ).href
  const { mergeProgressRecords } = await import(mergeUrl)
  const serveOnly = process.argv.includes('--serve')

  const server = createServer()
  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  const base = `http://${HOST}:${PORT}`
  console.log(`[progress-sync-sandbox] listening on ${base}`)

  if (serveOnly) {
    console.log(
      '[progress-sync-sandbox] --serve mode: leave running, set Library → Sync server URL to',
      base,
    )
    return
  }

  try {
    const health = await api(base, 'GET', '/v1/health')
    assert(health.ok, 'health')
    console.log('  ✓ health')
    await runTests(base, mergeProgressRecords)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((err) => {
  console.error('\nSandbox FAILED:', err.message || err)
  process.exit(1)
})
