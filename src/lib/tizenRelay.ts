/**
 * Samsung (Tizen) only: route CORS-blocked scraper fetches, referer-locked HLS and
 * YouTube embeds through the jiyu-relay Worker (workers/jiyu-relay).
 *
 * Desktop uses Electron IPC and Android uses CapacitorHttp — neither ever calls
 * this: every export is a no-op unless isTizenTv().
 */
import { isTizenTv } from './tvMode'

export const TIZEN_RELAY_ORIGIN = 'https://jiyu-relay.free-river.workers.dev'

/** Must mirror DATA_HOSTS in workers/jiyu-relay/src/index.js. */
const RELAY_HOSTS: RegExp[] = [
  /^(?:[a-z0-9-]+\.)*streamed\.pk$/,
  /^(?:[a-z0-9-]+\.)*streamed\.su$/,
  /^ppv\.st$/, // api.ppv.st already sends CORS
  /^subsplease\.org$/,
  /^livextv-backend\.onrender\.com$/,
  /^livextv\.hybrows\.workers\.dev$/,
  /^(?:www\.)?livextv\.(?:com|live|pro)$/,
  /^i\.mjh\.nz$/,
  /^epgshare01\.online$/,
  /^(?:www\.)?fullmatchshows\.com$/,
  /^(?:www\.)?soccerfull\.net$/,
]

/** Mirrors HLS_REFERERS in the worker. */
const HLS_REFERERS: RegExp[] = [
  /^https:\/\/(?:[a-z0-9-]+\.)*movy\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*atlantic[a-z0-9-]*\.[a-z.]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*bilibili\.tv$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*biliintl\.com$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*rivestream\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*streamo\.pro$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:embedsports|embedme|streamed)\.[a-z]+$/,
]

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function youtubeRelayable(u: URL, method: string): boolean {
  if (u.hostname !== 'www.youtube.com' && u.hostname !== 'youtube.com') return false
  if (method === 'POST') return /^\/youtubei\/v1\/(?:navigation\/resolve_url|player)$/.test(u.pathname)
  return /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/.test(u.pathname)
}

/** True when this request should go through /r on this device. */
export function shouldRelayFetch(url: string, method = 'GET'): boolean {
  if (!isTizenTv()) return false
  const u = parse(url)
  if (!u || !/^https?:$/.test(u.protocol)) return false
  if (u.origin === TIZEN_RELAY_ORIGIN) return false
  const m = method.toUpperCase()
  if (youtubeRelayable(u, m)) return true
  if (m !== 'GET' && m !== 'HEAD') return false
  const host = u.hostname.toLowerCase()
  return RELAY_HOSTS.some((re) => re.test(host))
}

export function tizenRelayUrl(url: string): string {
  const u = parse(url)
  const target = u && u.hostname === 'youtube.com' ? url.replace('://youtube.com', '://www.youtube.com') : url
  return `${TIZEN_RELAY_ORIGIN}/r?u=${encodeURIComponent(target)}`
}

/** Referer-locked HLS (Movy / Atlantic / Bilibili …) → relay playlist; else unchanged. */
export function tizenHlsUrl(url: string, referrer?: string): string {
  if (!isTizenTv() || !referrer) return url
  if (!/\.m3u8?(\?|#|$)/i.test(url) && !/m3u8|mpegurl|\/hls\//i.test(url)) return url
  let origin = ''
  try {
    origin = new URL(referrer).origin.toLowerCase()
  } catch {
    return url
  }
  if (!HLS_REFERERS.some((re) => re.test(origin))) return url
  if (url.startsWith(TIZEN_RELAY_ORIGIN)) return url
  return `${TIZEN_RELAY_ORIGIN}/hls?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(referrer)}`
}

/** https embed page hosted on the relay (correct origin/referrer → no Error 153). */
export function tizenYouTubeEmbedUrl(videoId: string, opts?: { mute?: boolean; controls?: boolean }): string {
  const qs = new URLSearchParams({ v: videoId })
  if (opts?.mute) qs.set('mute', '1')
  if (opts?.controls) qs.set('controls', '1')
  qs.set('pv', '2') // embed page revision: bumps past TV-cached copies after relay changes
  return `${TIZEN_RELAY_ORIGIN}/yt?${qs.toString()}`
}

export function isTizenYouTubeEmbedUrl(url: string): boolean {
  return url.startsWith(`${TIZEN_RELAY_ORIGIN}/yt?`)
}

/** Any YouTube watch/embed/youtu.be URL → relay embed page (null if no video id). */
export function tizenYouTubeEmbedFor(url: string): string | null {
  if (isTizenYouTubeEmbedUrl(url)) return url
  const u = parse(url)
  if (!u) return null
  const host = u.hostname.replace(/^www\.|^m\./, '')
  let id = ''
  if (host === 'youtu.be') id = u.pathname.slice(1, 12)
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (/^\/(?:embed|live|shorts)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1] ?? '')
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null
  return tizenYouTubeEmbedUrl(id, { mute: u.searchParams.get('mute') === '1' })
}

/** Headers the browser won't send itself — carried to the worker instead. */
function moveForbiddenHeaders(headers: Headers): void {
  const ref = headers.get('referer')
  if (ref) {
    headers.delete('referer')
    headers.set('X-Relay-Referer', ref)
  }
  const ua = headers.get('user-agent')
  if (ua) {
    headers.delete('user-agent')
    headers.set('X-Relay-UA', ua)
  }
  headers.delete('origin')
  headers.delete('cookie')
}

let installed = false

/**
 * Wrap window.fetch once on Tizen so every existing scraper (streamed, livextv,
 * SubsPlease, IPTV list, YouTube live lookups) reaches the relay without touching
 * each module. Other hosts and other platforms are untouched.
 */
export function installTizenFetchRelay(): void {
  if (installed || !isTizenTv() || typeof window.fetch !== 'function') return
  installed = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const method = (init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET') || 'GET').toUpperCase()
      if (!shouldRelayFetch(url, method)) return nativeFetch(input as RequestInfo, init)
      const headers = new Headers(
        init?.headers || (typeof input === 'object' && 'headers' in input ? (input as Request).headers : undefined),
      )
      moveForbiddenHeaders(headers)
      const next: RequestInit = {
        ...init,
        method,
        headers,
        credentials: 'omit',
        mode: 'cors',
        redirect: 'follow',
      }
      return nativeFetch(tizenRelayUrl(url), next)
    } catch {
      return nativeFetch(input as RequestInfo, init)
    }
  }) as typeof window.fetch
}
