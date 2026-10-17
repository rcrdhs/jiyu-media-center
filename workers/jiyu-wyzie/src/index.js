/**
 * Jiyu subtitle proxy — Cloudflare Worker.
 * Holds API keys server-side; clients call this URL with no secrets.
 *
 * Secrets (wrangler secret put):
 *   WYZIE_API_KEY           — required for /search
 *   OPENSUBTITLES_API_KEY   — optional; enables /opensubtitles
 *
 * Optional vars (wrangler.toml [vars]):
 *   ALLOWED_UA_SUBSTR — default "Jiyu" (soft filter; not real auth)
 */
const WYZIE_ORIGIN = 'https://sub.wyzie.io'
const OPENSUBTITLES_ORIGIN = 'https://api.opensubtitles.com/api/v1'

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
          hasOpenSubtitles: Boolean(env.OPENSUBTITLES_API_KEY),
        }),
      )
    }

    // Soft client gate — not secret auth; reduces casual scrapers hitting the worker URL.
    // Android WebView/Capacitor often strips or replaces User-Agent, so also accept X-Jiyu-Client.
    const ua = request.headers.get('user-agent') || ''
    const client = request.headers.get('x-jiyu-client') || ''
    const need = String(env.ALLOWED_UA_SUBSTR || 'Jiyu').trim()
    const clientOk =
      !need ||
      ua.includes(need) ||
      ua.includes('Electron') ||
      client.includes(need) ||
      client.includes('JiyuMedia')
    if (!clientOk) {
      return cors(Response.json({ code: 403, message: 'Forbidden' }, { status: 403 }))
    }

    if (url.pathname === '/opensubtitles' && request.method === 'GET') {
      return cors(await handleOpenSubtitles(url, env))
    }

    const key = String(env.WYZIE_API_KEY || '').trim()
    if (!key) {
      return cors(Response.json({ code: 503, message: 'WYZIE_API_KEY not configured' }, { status: 503 }))
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

async function handleOpenSubtitles(url, env) {
  const key = String(env.OPENSUBTITLES_API_KEY || '').trim()
  if (!key) {
    return Response.json(
      { ok: false, error: 'OPENSUBTITLES_API_KEY not configured on Worker' },
      { status: 503 },
    )
  }

  const tmdbId = String(url.searchParams.get('id') || '').trim()
  if (!tmdbId) {
    return Response.json({ ok: false, error: 'Missing id' }, { status: 400 })
  }

  const language = String(url.searchParams.get('language') || 'en').trim() || 'en'
  const season = Number(url.searchParams.get('season'))
  const episode = Number(url.searchParams.get('episode'))
  const isEpisode =
    Number.isFinite(season) && Number.isFinite(episode) && season >= 1 && episode >= 1

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Api-Key': key,
    'User-Agent': 'JiyuMedia v1.0',
  }

  try {
    const search = new URL(`${OPENSUBTITLES_ORIGIN}/subtitles`)
    search.searchParams.set('languages', language)
    search.searchParams.set('order_by', 'download_count')
    search.searchParams.set('order_direction', 'desc')
    if (isEpisode) {
      search.searchParams.set('parent_tmdb_id', tmdbId)
      search.searchParams.set('season_number', String(Math.floor(season)))
      search.searchParams.set('episode_number', String(Math.floor(episode)))
    } else {
      search.searchParams.set('tmdb_id', tmdbId)
    }

    const searchRes = await fetch(search.toString(), { method: 'GET', headers })
    const searchText = await searchRes.text()
    if (!searchRes.ok) {
      let detail = `HTTP ${searchRes.status}`
      try {
        const err = JSON.parse(searchText)
        detail = err.message || err.error || detail
      } catch {
        /* keep */
      }
      return Response.json({ ok: false, error: detail }, { status: searchRes.status })
    }

    let rows = []
    try {
      const parsed = JSON.parse(searchText)
      rows = Array.isArray(parsed?.data) ? parsed.data : []
    } catch {
      return Response.json({ ok: false, error: 'Invalid OpenSubtitles search response' }, { status: 502 })
    }

    const ranked = rows
      .map((row) => {
        const attrs = row?.attributes || {}
        const file = Array.isArray(attrs.files) ? attrs.files[0] : null
        const fileId = Number(file?.file_id)
        if (!Number.isFinite(fileId) || fileId < 1) return null
        let score = Number(attrs.download_count) || 0
        if (attrs.hearing_impaired) score -= 500
        if (String(attrs.language || '').toLowerCase().startsWith('en')) score += 1000
        return { fileId, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)

    const best = ranked[0]
    if (!best) {
      return Response.json({ ok: false, error: 'No OpenSubtitles for this episode' })
    }

    const dlRes = await fetch(`${OPENSUBTITLES_ORIGIN}/download`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file_id: best.fileId }),
    })
    const dlText = await dlRes.text()
    if (!dlRes.ok) {
      let detail = `Download HTTP ${dlRes.status}`
      try {
        const err = JSON.parse(dlText)
        detail = err.message || err.error || detail
      } catch {
        /* keep */
      }
      return Response.json({ ok: false, error: detail }, { status: dlRes.status })
    }

    let link = ''
    try {
      const parsed = JSON.parse(dlText)
      link = String(parsed?.link || '').trim()
    } catch {
      return Response.json({ ok: false, error: 'Invalid OpenSubtitles download response' }, { status: 502 })
    }
    if (!/^https?:\/\//i.test(link)) {
      return Response.json({ ok: false, error: 'OpenSubtitles returned no download link' })
    }

    return Response.json({ ok: true, subtitleUrl: link, source: 'opensubtitles' })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'OpenSubtitles upstream failed' },
      { status: 502 },
    )
  }
}

function cors(res) {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    'Accept, Content-Type, User-Agent, X-Jiyu-Client, Referer, Origin',
  )
  return new Response(res.body, { status: res.status, headers })
}
