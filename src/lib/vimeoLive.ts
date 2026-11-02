/** Official CVM Television 24×7 live event on Vimeo (site.cvmtv.com/live). */

import { nativeFetchJson, nativeFetchText } from './nativeHttp'

export const CVM_VIMEO_EVENT_URL = 'https://vimeo.com/event/4401057'
export const CVM_VIMEO_EVENT_ID = '4401057'

export type VimeoLiveResolveResult =
  | { ok: true; url: string; title?: string }
  | { ok: false; error: string }

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 JiyuMedia'

type CacheEntry = { url: string; title: string; expires: number }
const hlsCache = new Map<string, CacheEntry>()

export function parseVimeoEventId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\d{5,}$/.test(raw)) return raw
  try {
    const u = new URL(raw)
    if (!/vimeo\.com$/i.test(u.hostname) && !/\.vimeo\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/\/event\/(\d+)/i)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export function isVimeoLiveEventUrl(url: string): boolean {
  return Boolean(parseVimeoEventId(url))
}

type ViewerPayload = { jwt?: string }
type LiveEventPayload = {
  error?: string
  stream_title?: string
  title?: string
  streamable_clip?: {
    uri?: string
    name?: string
    player_embed_url?: string
  }
}
type PlayerConfigPayload = {
  request?: {
    files?: {
      hls?: {
        default_cdn?: string
        cdns?: Record<string, { avc_url?: string; url?: string }>
      }
    }
  }
}
type VideoPlayPayload = {
  play?: { hls?: { link?: string } }
  name?: string
}

/**
 * Resolve a Vimeo live event to a short-lived HLS URL.
 * Desktop IPC preferred (same session as Electron); otherwise native HTTP
 * (Android CapacitorHttp / desktop fetchJson) so phone CVM works without a token UI.
 */
export async function resolveVimeoLiveHls(urlOrEventId: string): Promise<VimeoLiveResolveResult> {
  const eventId = parseVimeoEventId(urlOrEventId) || urlOrEventId.trim()
  if (!/^\d{5,}$/.test(eventId)) {
    return { ok: false, error: 'Not a Vimeo live event URL' }
  }

  if (typeof window !== 'undefined' && window.signalDesktop?.resolveVimeoLiveHls) {
    try {
      const result = await window.signalDesktop.resolveVimeoLiveHls(eventId)
      if (result.ok && result.url) {
        return { ok: true, url: result.url, title: result.title }
      }
      // Fall through to shared resolve when IPC fails (token / network blip).
    } catch {
      /* shared path below */
    }
  }

  return resolveVimeoLiveHlsShared(eventId)
}

async function resolveVimeoLiveHlsShared(eventId: string): Promise<VimeoLiveResolveResult> {
  const cached = hlsCache.get(eventId)
  if (cached && cached.expires > Date.now() && cached.url) {
    return { ok: true, url: cached.url, title: cached.title }
  }

  const viewer = await nativeFetchJson<ViewerPayload>('https://vimeo.com/_next/viewer', {
    headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
  })
  if (!viewer.ok || !viewer.data?.jwt) {
    return { ok: false, error: viewer.error || 'Could not get Vimeo viewer token' }
  }
  const jwt = viewer.data.jwt

  const eventRes = await nativeFetchJson<LiveEventPayload>(
    `https://api.vimeo.com/live_events/${eventId}`,
    {
      headers: {
        Accept: 'application/vnd.vimeo.*+json;version=3.4.2',
        Authorization: `jwt ${jwt}`,
        'User-Agent': BROWSER_UA,
      },
    },
  )
  if (!eventRes.ok || !eventRes.data) {
    return { ok: false, error: eventRes.error || 'Vimeo event request failed' }
  }
  const event = eventRes.data
  if (event.error) {
    return { ok: false, error: event.error }
  }

  const clip = event.streamable_clip
  const videoId = String(clip?.uri || '')
    .split('/')
    .filter(Boolean)
    .pop()
  if (!videoId) {
    return { ok: false, error: 'Vimeo event has no live clip right now' }
  }

  let hlsUrl = ''
  try {
    const embedUrl = clip?.player_embed_url || ''
    const h = embedUrl ? new URL(embedUrl).searchParams.get('h') : null
    const configUrl = `https://player.vimeo.com/video/${videoId}/config${h ? `?h=${h}` : ''}`
    const configRes = await nativeFetchJson<PlayerConfigPayload>(configUrl, {
      referer: 'https://site.cvmtv.com/',
      headers: {
        Accept: 'application/json',
        Origin: 'https://site.cvmtv.com',
        'User-Agent': BROWSER_UA,
      },
    })
    const hls = configRes.data?.request?.files?.hls
    const cdnKey = hls?.default_cdn || Object.keys(hls?.cdns || {})[0]
    hlsUrl = (cdnKey && hls?.cdns?.[cdnKey]?.avc_url) || (cdnKey && hls?.cdns?.[cdnKey]?.url) || ''
  } catch {
    /* fall through to play API */
  }

  if (!hlsUrl) {
    const playRes = await nativeFetchJson<VideoPlayPayload>(
      `https://api.vimeo.com/videos/${videoId}?fields=play.hls.link,name`,
      {
        headers: {
          Accept: 'application/vnd.vimeo.*+json;version=3.4.2',
          Authorization: `jwt ${jwt}`,
          'User-Agent': BROWSER_UA,
        },
      },
    )
    hlsUrl = playRes.data?.play?.hls?.link || ''
  }

  // Last resort: raw text parse if JSON path was blocked.
  if (!hlsUrl || !/^https?:\/\//i.test(hlsUrl)) {
    const raw = await nativeFetchText(
      `https://player.vimeo.com/video/${videoId}/config`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': BROWSER_UA,
          Referer: 'https://site.cvmtv.com/',
        },
      },
    )
    if (raw.ok && raw.content) {
      const m =
        raw.content.match(/"avc_url"\s*:\s*"(https:[^"]+m3u8[^"]*)"/i) ||
        raw.content.match(/"url"\s*:\s*"(https:[^"]+m3u8[^"]*)"/i)
      if (m?.[1]) hlsUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    }
  }

  if (!hlsUrl || !/^https?:\/\//i.test(hlsUrl)) {
    return { ok: false, error: 'No HLS URL in Vimeo live config' }
  }

  const title = event.stream_title || event.title || clip?.name || ''
  hlsCache.set(eventId, {
    url: hlsUrl,
    title,
    expires: Date.now() + 4 * 60 * 1000,
  })
  return { ok: true, url: hlsUrl, title }
}
