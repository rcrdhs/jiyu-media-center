/**
 * Jiyu Nationwide resolver — Cloudflare Worker
 *
 * Hardcoded NNN livestream page → VISIONOS Innertube HLS → proxied m3u8
 * so Roku plays inside Jiyu with no PC bridge and no YouTube app.
 *
 *   GET /live.m3u8   master playlist (rewritten through /p)
 *   GET /            same as /live.m3u8
 *   GET /p?u=<url>   proxy allowlisted googlevideo / youtube playlist or segment
 *   GET /health
 */

const NNN_LIVE = 'https://www.youtube.com/@nnn-RADIOLIVE/live'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

const RESOLVE_CACHE_MS = 45_000
/** @type {{ at: number, masterUrl: string, title: string, videoId: string } | null} */
let resolveCache = null

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    ...extra,
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors(extraHeaders),
    },
  })
}

function allowProxyHost(host) {
  const h = String(host || '').toLowerCase()
  return (
    h === 'googlevideo.com' ||
    h.endsWith('.googlevideo.com') ||
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'ytimg.com' ||
    h.endsWith('.ytimg.com') ||
    h === 'ggpht.com' ||
    h.endsWith('.ggpht.com')
  )
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
    redirect: 'follow',
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

function extractVideoId(html) {
  const live = html.match(
    /"liveStreamability"\s*:\s*\{[^}]{0,500}?"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
  )
  if (live?.[1]) return live[1]
  const m = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/)
  if (m?.[1]) return m[1]
  const w = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/)
  return w?.[1] || ''
}

function extractVisitorData(html) {
  const a = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)
  if (a?.[1]) return a[1]
  const b = html.match(/"visitorData"\s*:\s*"([^"]+)"/)
  return b?.[1] || ''
}

async function resolveLiveVideoId() {
  const page = await fetchText(NNN_LIVE, {
    Accept: 'text/html,application/xhtml+xml',
  })
  if (!page.ok) throw new Error(`NNN live page HTTP ${page.status}`)
  if (/LIVE_STREAM_OFFLINE/i.test(page.text) && !/"isLiveNow"\s*:\s*true/i.test(page.text)) {
    throw new Error('Nationwide is not live on YouTube right now')
  }
  let videoId = extractVideoId(page.text)
  let visitorData = extractVisitorData(page.text)

  if (!videoId) {
    const body = {
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          hl: 'en',
          gl: 'US',
        },
      },
      url: NNN_LIVE,
    }
    const res = await fetch(
      'https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
          'X-Youtube-Client-Name': '3',
          'X-Youtube-Client-Version': '20.10.38',
        },
        body: JSON.stringify(body),
      },
    )
    const data = await res.json()
    videoId = data?.endpoint?.watchEndpoint?.videoId || ''
    if (!videoId && data?.endpoint?.browseEndpoint?.browseId) {
      throw new Error('Nationwide is not live on YouTube right now')
    }
  }

  if (!videoId) throw new Error('Could not resolve Nationwide live video id')

  if (!visitorData) {
    const watch = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {
      Accept: 'text/html,application/xhtml+xml',
    })
    visitorData = extractVisitorData(watch.text)
  }

  return { videoId, visitorData }
}

async function fetchHlsManifest(videoId, visitorData) {
  const client = {
    clientName: 'VISIONOS',
    clientVersion: '1.02',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    userAgent: UA,
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    hl: 'en',
    gl: 'US',
  }
  if (visitorData) client.visitorData = visitorData

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Youtube-Client-Name': '101',
    'X-Youtube-Client-Version': '1.02',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  }
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: { client },
      videoId,
      playbackContext: {
        contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
      },
    }),
  })
  const data = await res.json()
  const status = data?.playabilityStatus?.status || ''
  const hls = data?.streamingData?.hlsManifestUrl || ''
  const title = data?.videoDetails?.title || 'Nationwide'
  if (!hls) {
    throw new Error(`YouTube player returned no HLS (status=${status || 'unknown'})`)
  }
  return { hls, title, status }
}

async function resolveNationwide() {
  const now = Date.now()
  if (resolveCache && now - resolveCache.at < RESOLVE_CACHE_MS) {
    return { ...resolveCache, cached: true }
  }
  const { videoId, visitorData } = await resolveLiveVideoId()
  const { hls, title } = await fetchHlsManifest(videoId, visitorData)
  resolveCache = { at: now, masterUrl: hls, title, videoId }
  return { ...resolveCache, cached: false }
}

function rewritePlaylist(body, baseUrl, proxyOrigin) {
  const lines = String(body || '').split(/\r?\n/)
  const out = []
  for (const line of lines) {
    if (!line) {
      out.push(line)
      continue
    }
    if (line.startsWith('#')) {
      out.push(
        line.replace(/URI="([^"]+)"/gi, (_, u) => {
          try {
            const abs = new URL(u, baseUrl).href
            return `URI="${proxyOrigin}/p?u=${encodeURIComponent(abs)}"`
          } catch {
            return `URI="${u}"`
          }
        }),
      )
      continue
    }
    try {
      const abs = new URL(line.trim(), baseUrl).href
      out.push(`${proxyOrigin}/p?u=${encodeURIComponent(abs)}`)
    } catch {
      out.push(line)
    }
  }
  return out.join('\n')
}

async function handleMaster(request) {
  const resolved = await resolveNationwide()
  const upstream = await fetch(resolved.masterUrl, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
      Accept: '*/*',
    },
  })
  if (!upstream.ok) {
    return json(
      {
        ok: false,
        error: `Upstream master HTTP ${upstream.status}`,
        videoId: resolved.videoId,
      },
      502,
    )
  }
  const text = await upstream.text()
  if (!text.startsWith('#EXTM3U')) {
    return json({ ok: false, error: 'Upstream was not an m3u8' }, 502)
  }
  const origin = new URL(request.url).origin
  const rewritten = rewritePlaylist(text, resolved.masterUrl, origin)
  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'X-Jiyu-Title': encodeURIComponent(resolved.title).slice(0, 180),
      'X-Jiyu-VideoId': resolved.videoId,
      'X-Jiyu-Cached': String(resolved.cached),
      ...cors(),
    },
  })
}

async function handleProxy(request, url) {
  const target = url.searchParams.get('u') || ''
  if (!/^https?:\/\//i.test(target)) {
    return new Response('Missing u=', { status: 400, headers: cors() })
  }
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return new Response('Bad u=', { status: 400, headers: cors() })
  }
  if (!allowProxyHost(parsed.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: cors() })
  }

  const upstream = await fetch(target, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
      Accept: '*/*',
    },
  })
  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: cors(),
    })
  }

  const ct = String(upstream.headers.get('content-type') || '')
  const buf = await upstream.arrayBuffer()
  const head = new TextDecoder().decode(buf.slice(0, 16))
  if (head.startsWith('#EXTM3U') || /mpegurl|m3u8/i.test(ct)) {
    const text = new TextDecoder().decode(buf)
    const origin = new URL(request.url).origin
    const rewritten = rewritePlaylist(text, target, origin)
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        ...cors(),
      },
    })
  }

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': ct || 'application/octet-stream',
      'Cache-Control': 'public, max-age=4',
      ...cors(),
    },
  })
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: 'Method not allowed' }, 405)
    }

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (path === '/health') {
        return json({
          ok: true,
          service: 'jiyu-nnn',
          live: NNN_LIVE,
          cacheAgeMs: resolveCache ? Date.now() - resolveCache.at : null,
        })
      }

      if (path === '/p') {
        return await handleProxy(request, url)
      }

      if (path === '/' || path === '/live.m3u8' || path === '/nnn' || path === '/nationwide') {
        return await handleMaster(request)
      }

      return json({
        ok: true,
        service: 'jiyu-nnn',
        use: '/live.m3u8',
        note: 'Hardcoded @nnn-RADIOLIVE/live → proxied HLS for Roku',
      })
    } catch (err) {
      resolveCache = null
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message : 'Resolve error',
        },
        502,
      )
    }
  },
}
