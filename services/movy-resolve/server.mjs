/**
 * Slim Movy seed/sources proxy for a non-Cloudflare VPS (Hetzner).
 * GET /health
 * GET /api/movy?u=https://api.wecollege.net/seed|…/sources…
 * Auth: Authorization: Bearer <JIYU_MOVY_TOKEN> or ?token=
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const TOKEN = String(process.env.JIYU_MOVY_TOKEN || '').trim()
const REF = 'https://www.movy.sx/'
const ORIGIN = 'https://www.movy.sx'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function sendJson(res, status, body) {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(raw)
}

function authOk(req, url) {
  if (!TOKEN) return true
  const h = String(req.headers.authorization || '')
  if (h === `Bearer ${TOKEN}`) return true
  if (url.searchParams.get('token') === TOKEN) return true
  const x = String(req.headers['x-jiyu-token'] || '')
  return x === TOKEN
}

function isMovyApiTarget(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (u.hostname.toLowerCase() !== 'api.wecollege.net') return false
    return /^\/(?:seed\b|[a-z0-9_-]+\/sources\b)/i.test(u.pathname)
  } catch {
    return false
  }
}

async function proxyMovy(res, target) {
  const upstream = await fetch(target, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: '*/*',
      Referer: REF,
      Origin: ORIGIN,
      'User-Agent': UA,
    },
  })
  const buf = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Jiyu-Movy-Status',
    'Cache-Control': 'no-store',
    'X-Jiyu-Movy-Status': String(upstream.status),
  })
  res.end(buf)
}

const started = Date.now()
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Jiyu-Token',
    })
    res.end()
    return
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'movy-resolve',
      uptimeSec: Math.floor((Date.now() - started) / 1000),
      id: process.env.HOSTNAME || randomUUID().slice(0, 8),
    })
    return
  }

  if (!authOk(req, url)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/movy') {
    const target = String(url.searchParams.get('u') || '').trim()
    if (!isMovyApiTarget(target)) {
      sendJson(res, 403, { ok: false, error: 'Host not allowed' })
      return
    }
    try {
      await proxyMovy(res, target)
    } catch (err) {
      sendJson(res, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'proxy failed',
      })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'Not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[movy-resolve] :${PORT} token=${TOKEN ? 'on' : 'off'}`)
})
