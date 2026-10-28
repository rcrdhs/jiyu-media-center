/** Detect whether a YouTube @handle/live URL is currently on-air */

import { isTizenTv } from './tvMode'
import { tizenYouTubeEmbedUrl } from './tizenRelay'

export type YouTubeLivePlayResult =
  | {
      ok: true
      videoId: string
      watchUrl: string
      /** Autoplay embed for in-app Web player / muted card preview */
      embedUrl: string
      previewUrl: string
      posterUrl?: string
    }
  | { ok: false; error: string }

const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  hl: 'en',
  gl: 'US',
}

function looksLikeBotWall(html: string): boolean {
  if (!html) return false
  if (/Sign in to confirm you.?re not a bot/i.test(html)) return true
  if (/"status"\s*:\s*"LOGIN_REQUIRED"/i.test(html) && /not a bot|captcha/i.test(html)) {
    return true
  }
  return false
}

function looksOffline(html: string): boolean {
  if (/LIVE_STREAM_OFFLINE/i.test(html)) return true
  if (/"status"\s*:\s*"LIVE_STREAM_OFFLINE"/i.test(html)) return true
  if (/this channel isn.?t live right now/i.test(html)) return true
  if (/"isLiveNow"\s*:\s*false/i.test(html) && !/"isLiveNow"\s*:\s*true/i.test(html)) {
    return true
  }
  return false
}

function looksLive(html: string): boolean {
  if (!html || html.length < 200) return false
  if (looksLikeBotWall(html) || looksOffline(html)) return false

  if (/"isLiveNow"\s*:\s*true/i.test(html)) return true
  if (/liveStreamability/i.test(html) && /"playableInEmbed"\s*:\s*true/i.test(html)) return true
  if (/"isLiveContent"\s*:\s*true/i.test(html) && /\/watch\?v=/i.test(html)) return true
  if (/hqdefault_live\.jpg/i.test(html) && /"isLiveNow"\s*:\s*true/i.test(html)) return true
  if (/itemprop="isLiveBroadcast"[^>]*content="True"/i.test(html)) return true
  return false
}

export function extractYouTubeVideoId(html: string): string | null {
  // Prefer liveStreamability video id when present (more specific than first videoId).
  const fromLive = html.match(
    /"liveStreamability"\s*:\s*\{[^}]{0,400}?"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/i,
  )
  if (fromLive?.[1]) return fromLive[1]
  const fromJson = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/)
  if (fromJson?.[1]) return fromJson[1]
  const fromWatch = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/)
  if (fromWatch?.[1]) return fromWatch[1]
  const fromEmbed = html.match(/\/embed\/([a-zA-Z0-9_-]{11})/)
  if (fromEmbed?.[1]) return fromEmbed[1]
  return null
}

/** https embedder identity Jiyu sends to YouTube (electron/main.cjs + GeckoOverlayController). */
const YOUTUBE_EMBEDDER_ORIGIN = 'https://jiyu.app'

/** IFrame API rejects unmute commands when origin doesn't match the real page. */
function youtubeEmbedOrigin(): string {
  if (typeof window !== 'undefined') {
    try {
      const origin = window.location.origin
      if (origin && origin !== 'null' && /^https?:\/\//i.test(origin)) return origin
    } catch {
      /* ignore */
    }
  }
  return YOUTUBE_EMBEDDER_ORIGIN
}

function playUrlsForVideoId(videoId: string): Omit<
  Extract<YouTubeLivePlayResult, { ok: true }>,
  'ok'
> {
  const origin = encodeURIComponent(youtubeEmbedOrigin())
  // embedUrl is only loaded top-level (Android Gecko player / multiview tiles),
  // where the native side sends Referer https://jiyu.app/ — keep origin and
  // widget_referrer on the same embedder so YouTube doesn't answer Error 153.
  const embedder = encodeURIComponent(YOUTUBE_EMBEDDER_ORIGIN)
  const embedderReferrer = encodeURIComponent(`${YOUTUBE_EMBEDDER_ORIGIN}/`)
  if (isTizenTv()) {
    // Samsung: the app runs from a widget/file origin, so YouTube's own embed
    // answers Error 153. The relay's https page embeds it with a real origin.
    return {
      videoId,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}&autoplay=1`,
      embedUrl: tizenYouTubeEmbedUrl(videoId),
      previewUrl: tizenYouTubeEmbedUrl(videoId, { mute: true }),
      posterUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault_live.jpg`,
    }
  }
  const qs =
    'autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1&enablejsapi=1'
  return {
    videoId,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}&autoplay=1`,
    // Full Watch prefers watchUrl in WebContentsView; embed is for iframes.
    // origin= helps some embed configs; Referer is still required (Error 153).
    embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1&origin=${embedder}&widget_referrer=${embedderReferrer}`,
    // Card preview: nocookie + muted autoplay (allowed after frame-src CSP).
    previewUrl: `https://www.youtube-nocookie.com/embed/${videoId}?${qs}&origin=${origin}`,
    posterUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault_live.jpg`,
  }
}

async function fetchPageHtml(url: string): Promise<string> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url, { quiet: true })
    if (result.ok && result.content) return result.content
  }
  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(url)
    if (!result.ok) return ''
    return result.content || ''
  }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchText } = await import('./nativeHttp')
      const result = await nativeFetchText(url, {
        quiet: true,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      if (result.ok && result.content) return result.content
    }
  } catch {
    /* fall through */
  }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    })
    if (!response.ok) return ''
    return await response.text()
  } catch {
    return ''
  }
}

async function innertubePost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const url = `https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`
  const payload = {
    context: { client: ANDROID_CLIENT },
    ...body,
  }
  if (window.signalDesktop?.fetchJsonPost) {
    const result = await window.signalDesktop.fetchJsonPost(url, payload, 'https://www.youtube.com/')
    if (!result.ok || !result.content) return null
    try {
      return JSON.parse(result.content) as T
    } catch {
      return null
    }
  }
  const ytHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
    'X-Youtube-Client-Name': '3',
    'X-Youtube-Client-Version': '20.10.38',
  }
  // Android WebView fetch sends Origin: https://localhost → YouTube answers the
  // CORS preflight with 403 (measured ~0.4–0.8 s wasted, then the 1.3 MB HTML
  // fallback). CapacitorHttp sends no Origin and gets 200 in ~100–300 ms.
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJsonPost } = await import('./nativeHttp')
      const res = await nativeFetchJsonPost<unknown>(url, payload, { headers: ytHeaders })
      if (!res.ok || res.data == null) return null
      if (typeof res.data === 'string') {
        try {
          return JSON.parse(res.data) as T
        } catch {
          return null
        }
      }
      return res.data as T
    }
  } catch {
    /* fall through to WebView fetch */
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: ytHeaders,
      body: JSON.stringify(payload),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

type ResolveUrlResponse = {
  endpoint?: {
    watchEndpoint?: { videoId?: string }
    browseEndpoint?: { browseId?: string }
    urlEndpoint?: { url?: string }
  }
}

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string }
  videoDetails?: {
    videoId?: string
    title?: string
    isLive?: boolean
    isLiveContent?: boolean
    lengthSeconds?: string
  }
}

/** Resolve @handle/live → current video id via Innertube (survives HTML bot walls). */
async function resolveLiveVideoIdViaInnertube(
  liveUrl: string,
): Promise<string | 'channel' | null> {
  const data = await innertubePost<ResolveUrlResponse>('navigation/resolve_url', {
    url: liveUrl,
  })
  const id = data?.endpoint?.watchEndpoint?.videoId
  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id
  // /live that maps back to the channel page = not on-air (no 1.3 MB HTML fallback).
  if (data?.endpoint?.browseEndpoint?.browseId) return 'channel'
  return null
}

async function playerSaysLive(videoId: string): Promise<'live' | 'offline' | 'unknown'> {
  const data = await innertubePost<PlayerResponse>('player', { videoId })
  if (!data) return 'unknown'
  const details = data.videoDetails
  if (details?.isLive === true) return 'live'
  if (details?.isLiveContent === true && String(details.lengthSeconds || '') === '0') return 'live'
  const status = String(data.playabilityStatus?.status || '')
  if (/LIVE_STREAM_OFFLINE/i.test(status)) return 'offline'
  if (details?.isLive === false && details?.isLiveContent === false) return 'offline'
  if (status === 'OK' && details?.isLiveContent) return 'live'
  return 'unknown'
}

export async function isYouTubeLiveNow(liveUrl: string): Promise<boolean> {
  const resolved = await resolveYouTubeLivePlay(liveUrl)
  return resolved.ok
}

const resolveCache = new Map<string, { at: number; result: YouTubeLivePlayResult }>()
const resolveInflight = new Map<string, Promise<YouTubeLivePlayResult>>()
const RESOLVE_CACHE_TTL_MS = 90_000
/** Offline answers expire fast so a channel that just went live opens on retry. */
const RESOLVE_OFFLINE_TTL_MS = 20_000

/**
 * Warm the live resolve (card hover / visible / tap) so Watch opens with the
 * video id already cached. Safe to call repeatedly — deduped + cached.
 */
export function prefetchYouTubeLive(liveUrl: string): void {
  const key = String(liveUrl || '').trim()
  if (!key || !/youtube\.com\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live/i.test(key)) {
    return
  }
  void resolveYouTubeLivePlay(key).catch(() => undefined)
}

/**
 * Resolve a channel `/live` URL into a playable watch/embed when on-air.
 * Prefers Innertube (ANDROID) so HTML bot-walls don't false-offline local channels.
 * Short TTL cache so Home card preview + Watch click share one resolve.
 */
export async function resolveYouTubeLivePlay(liveUrl: string): Promise<YouTubeLivePlayResult> {
  const key = String(liveUrl || '').trim()
  const hit = key ? resolveCache.get(key) : undefined
  if (hit) {
    const ttl = hit.result.ok ? RESOLVE_CACHE_TTL_MS : RESOLVE_OFFLINE_TTL_MS
    if (Date.now() - hit.at < ttl) return hit.result
  }
  const pending = key ? resolveInflight.get(key) : undefined
  if (pending) return pending
  const run = resolveYouTubeLivePlayUncached(liveUrl, key)
  if (key) {
    resolveInflight.set(key, run)
    void run.finally(() => resolveInflight.delete(key))
  }
  return run
}

async function resolveYouTubeLivePlayUncached(
  liveUrl: string,
  key: string,
): Promise<YouTubeLivePlayResult> {
  const store = (result: YouTubeLivePlayResult) => {
    if (key) resolveCache.set(key, { at: Date.now(), result })
    return result
  }

  try {
    // 1) Innertube resolve_url → videoId → player isLive (most reliable).
    const innertubeId = await resolveLiveVideoIdViaInnertube(liveUrl)
    if (innertubeId === 'channel') {
      return store({ ok: false, error: 'This channel is not live on YouTube right now' })
    }
    if (innertubeId) {
      const state = await playerSaysLive(innertubeId)
      if (state === 'live' || state === 'unknown') {
        // unknown: still open the resolved /live video — better than false offline.
        return store({ ok: true, ...playUrlsForVideoId(innertubeId) })
      }
      if (state === 'offline') {
        return store({ ok: false, error: 'This channel is not live on YouTube right now' })
      }
    }

    // 2) HTML fallback when Innertube is unavailable.
    const html = await fetchPageHtml(liveUrl)
    if (looksLikeBotWall(html)) {
      return store({
        ok: false,
        error: 'YouTube blocked the live check — open Watch once, then try again',
      })
    }
    if (looksOffline(html)) {
      return store({ ok: false, error: 'This channel is not live on YouTube right now' })
    }
    if (looksLive(html)) {
      const videoId = extractYouTubeVideoId(html)
      if (videoId) return store({ ok: true, ...playUrlsForVideoId(videoId) })
      return store({
        ok: true,
        videoId: '',
        watchUrl: liveUrl,
        embedUrl: liveUrl,
        previewUrl: liveUrl,
      })
    }

    return store({ ok: false, error: 'This channel is not live on YouTube right now' })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not load YouTube live',
    }
  }
}
