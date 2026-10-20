/**
 * Jiyu subtitle proxy — Cloudflare Worker.
 * Holds API keys server-side; clients call this URL with no secrets.
 *
 * Secrets (wrangler secret put):
 *   WYZIE_API_KEY           — required for /search
 *   OPENSUBTITLES_API_KEY   — optional; enables /opensubtitles
 *
 *   GEMINI_API_KEY          - optional; /translate provider 1
 *   DEEPL_API_KEY           - optional; /translate provider 2 (":fx" = API Free)
 *
 * Bindings (wrangler.toml, optional): TRANSLATE_CACHE (KV), AI (Workers AI, provider 3),
 *   TRANSLATE_RATE_LIMITER (rate limit). See src/translate.js.
 *
 * Optional vars (wrangler.toml [vars]):
 *   ALLOWED_UA_SUBSTR — default "Jiyu" (soft filter; not real auth)
 */
import { availableProviders, handleTranslate } from './translate.js'

const WYZIE_ORIGIN = 'https://sub.wyzie.io'
const OPENSUBTITLES_ORIGIN = 'https://api.opensubtitles.com/api/v1'

export default {
  async fetch(request, env, ctx) {
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
          translateProviders: availableProviders(env),
          hasTranslateCache: Boolean(env.TRANSLATE_CACHE),
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

    if (url.pathname === '/translate') {
      if (request.method !== 'POST') {
        return cors(Response.json({ ok: false, error: 'Use POST' }, { status: 405 }))
      }
      try {
        return cors(await handleTranslate(request, env, ctx))
      } catch (err) {
        return cors(
          Response.json(
            { ok: false, error: err instanceof Error ? err.message : 'Translate failed' },
            { status: 500 },
          ),
        )
      }
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
  // language=any: no language filter; rank by the client's `prefer` list (translation source).
  const anyLanguage = language === 'any' || language === '*'
  const prefer = String(url.searchParams.get('prefer') || '')
    .split(',')
    .map(normalizeTrackLanguage)
    .filter(Boolean)
    .slice(0, 24)
  // Title's original language: always beats other languages regardless of release quality.
  const original = normalizeTrackLanguage(url.searchParams.get('original') || '')
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
    if (!anyLanguage) search.searchParams.set('languages', language)
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
        const lang = normalizeTrackLanguage(attrs.language)
        let score
        if (anyLanguage) {
          score = scoreAnyLanguage(lang, prefer, original)
          score += Math.min(100, (Number(attrs.download_count) || 0) / 2.5)
          if (attrs.hearing_impaired) score -= 80
          if (attrs.ai_translated || attrs.machine_translated) score -= 300
        } else {
          score = Number(attrs.download_count) || 0
          if (attrs.hearing_impaired) score -= 500
          if (String(attrs.language || '').toLowerCase().startsWith('en')) score += 1000
        }
        return { fileId, score, language: lang, release: String(attrs.release || '').slice(0, 200) }
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

    return Response.json({
      ok: true,
      subtitleUrl: link,
      source: 'opensubtitles',
      language: best.language || undefined,
      release: best.release || undefined,
      candidates: anyLanguage ? ranked.length : undefined,
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'OpenSubtitles upstream failed' },
      { status: 502 },
    )
  }
}

/** OpenSubtitles / Wyzie track codes -> base language (pt-BR/pb -> pt, zh-TW/zt -> zh, ea -> es). */
export function normalizeTrackLanguage(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  const legacy = { pb: 'pt', pob: 'pt', zt: 'zh', ze: 'zh', zhs: 'zh', zht: 'zh', ea: 'es', spl: 'es', chi: 'zh', jpn: 'ja', eng: 'en' }
  if (legacy[s]) return legacy[s]
  const m = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,4})?$/.exec(s)
  return m ? m[1] : ''
}

/**
 * Language rank for language=any: the title's original language first (dominates every quality
 * signal), then earlier in `prefer` (x10 so downloads only break near-ties).
 */
export function scoreAnyLanguage(lang, prefer, original = '') {
  if (lang && original && lang === original) return 10000
  const i = prefer.indexOf(lang)
  if (i >= 0) return (100 - i * 6) * 10
  return lang ? 200 : 0
}

function cors(res) {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    'Accept, Content-Type, User-Agent, X-Jiyu-Client, Referer, Origin',
  )
  return new Response(res.body, { status: res.status, headers })
}
