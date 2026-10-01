/**
 * Jiyu Wyzie proxy — Cloudflare Worker.
 * Holds WYZIE_API_KEY server-side; clients call this URL with no Wyzie key.
 *
 * Secrets (wrangler secret put):
 *   WYZIE_API_KEY  — required
 *
 * Optional vars (wrangler.toml [vars]):
 *   ALLOWED_UA_SUBSTR — default "Jiyu" (soft filter; not real auth)
 */
const WYZIE_ORIGIN = 'https://sub.wyzie.io'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }))
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return cors(
        Response.json({
          ok: true,
          service: 'jiyu-wyzie-proxy',
          hasKey: Boolean(env.WYZIE_API_KEY),
        }),
      )
    }

    const key = String(env.WYZIE_API_KEY || '').trim()
    if (!key) {
      return cors(Response.json({ code: 503, message: 'WYZIE_API_KEY not configured' }, { status: 503 }))
    }

    // Soft UA gate — not secret auth; reduces casual scrapers hitting the worker URL.
    const ua = request.headers.get('user-agent') || ''
    const need = String(env.ALLOWED_UA_SUBSTR || 'Jiyu').trim()
    if (need && !ua.includes(need) && !ua.includes('Electron')) {
      return cors(Response.json({ code: 403, message: 'Forbidden' }, { status: 403 }))
    }

    // Only proxy Wyzie search (and optional one-call download). Block open proxy.
    const allowed = url.pathname === '/search' || url.pathname === '/download'
    if (!allowed || request.method !== 'GET') {
      return cors(Response.json({ code: 404, message: 'Not found' }, { status: 404 }))
    }

    const upstream = new URL(WYZIE_ORIGIN + url.pathname)
    url.searchParams.forEach((v, k) => {
      if (k === 'key') return // never accept client-supplied Wyzie keys
      upstream.searchParams.set(k, v)
    })
    upstream.searchParams.set('key', key)

    try {
      const upstreamRes = await fetch(upstream.toString(), {
        method: 'GET',
        headers: {
          Accept: request.headers.get('Accept') || 'application/json',
          'User-Agent': 'Jiyu-Wyzie-Proxy/1.0',
        },
        redirect: 'follow',
      })

      // For /download (binary/text subtitle body), pass through as-is.
      if (url.pathname === '/download') {
        const headers = new Headers(upstreamRes.headers)
        headers.set('Access-Control-Allow-Origin', '*')
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
        headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type, User-Agent')
        return new Response(upstreamRes.body, { status: upstreamRes.status, headers })
      }

      const text = await upstreamRes.text()
      return cors(
        new Response(text, {
          status: upstreamRes.status,
          headers: {
            'Content-Type': upstreamRes.headers.get('Content-Type') || 'application/json',
          },
        }),
      )
    } catch (err) {
      return cors(
        Response.json(
          { code: 502, message: err instanceof Error ? err.message : 'Upstream failed' },
          { status: 502 },
        ),
      )
    }
  },
}

function cors(res) {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type, User-Agent')
  return new Response(res.body, { status: res.status, headers })
}
