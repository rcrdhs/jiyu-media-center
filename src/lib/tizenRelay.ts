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
  /^api\.wecollege\.net$/, // Movy seed / sources (needs the movy.sx Referer)
]

/** Mirrors IPTV_HOSTS in the worker. */
const IPTV_HOSTS: RegExp[] = [
  /^jmp2\.uk$/,
  /^(?:[a-z0-9-]+\.)*pluto\.tv$/,
  /^(?:[a-z0-9-]+\.)*plutotv\.net$/,
  /^(?:[a-z0-9-]+\.)*amagi\.tv$/,
  // tv5monde (ACAO locked to tv5monde.com) is not here: its Akamai edge returns
  // 403 to Cloudflare egress, so relaying it only burns requests.
]

/** Mirrors HLS_REFERERS in the worker. */
const HLS_REFERERS: RegExp[] = [
  /^https:\/\/(?:[a-z0-9-]+\.)*movy\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*atlantic[a-z0-9-]*\.[a-z.]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*bilibili\.tv$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*biliintl\.com$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*rivestream\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:embedsports|embedme|streamed)\.[a-z]+$/,
]

/** Mirrors ATLANTIC_HLS_HOSTS in the worker: Helios / Aphrodite entry playlist hosts. */
const ATLANTIC_REF = /^https:\/\/(?:[a-z0-9-]+\.)*atlantic[a-z0-9-]*\.[a-z.]+$/
const ATLANTIC_HLS_HOSTS: RegExp[] = [
  /^(?:stream|cdn)\.hls\.lol$/,
  /^(?:[a-z0-9-]+\.)*transcode\.cfd$/,
  /^(?:[a-z0-9-]+\.)*totallyacdn\.org$/,
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
  if (ATLANTIC_REF.test(origin)) {
    const host = parse(url)?.hostname.toLowerCase() || ''
    if (!ATLANTIC_HLS_HOSTS.some((re) => re.test(host))) return url
  }
  if (url.startsWith(TIZEN_RELAY_ORIGIN)) return url
  return `${TIZEN_RELAY_ORIGIN}/hls?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(referrer)}`
}

function isPublicIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const n = m.slice(1).map(Number)
  if (n.some((x) => x > 255)) return false
  const [a, b] = n
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

function iptvRelayable(url: string): boolean {
  const u = parse(url)
  if (!u || !/^https?:$/.test(u.protocol)) return false
  const host = u.hostname.toLowerCase()
  // Bare-IP channels: Cloudflare blocks Worker fetches to raw IPs (error 1003).
  return IPTV_HOSTS.some((re) => re.test(host))
}

function looksLikeHls(url: string): boolean {
  return /\.m3u8?(\?|#|$)/i.test(url) || /m3u8|mpegurl|\/hls\//i.test(url)
}

/** Same rule as the worker's iptvRefererAllowed — anything else is sent without one. */
function iptvReferer(referrer: string | undefined, url: string): string {
  if (!referrer) return ''
  const r = parse(referrer)
  const t = parse(url)
  if (!r || !t || !/^https?:$/.test(r.protocol)) return ''
  const rh = r.hostname.toLowerCase().replace(/^www\./, '')
  const th = t.hostname.toLowerCase()
  if (IPTV_HOSTS.some((re) => re.test(rh)) || isPublicIPv4(rh)) return referrer
  if (!isPublicIPv4(rh) && rh.includes('.') && (th === rh || th.endsWith(`.${rh}`))) return referrer
  return ''
}

const corsVerdict = new Map<string, { t: number; ok: boolean }>()

/** fetch() with a timeout (Chromium 76 on Tizen 6 has no AbortSignal.timeout). */
async function probeCors(url: string, ms: number): Promise<boolean> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'omit', mode: 'cors', signal: ctl?.signal })
    try {
      await res.body?.cancel()
    } catch {
      /* ignore */
    }
    return true // any readable response (even 4xx) means CORS is not what blocks it
  } catch (err) {
    // TypeError = network / CORS failure; AbortError = slow host → let hls.js try it directly.
    return !(err instanceof TypeError)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Tizen HLS source picker. Referer-locked sources → relay (as before). Plain IPTV:
 * direct, unless a CORS probe of the playlist fails AND the host is on the IPTV
 * allowlist — then the relay's /hls (which leaves CORS-open segments direct).
 * Never relays on desktop / Android, never relays a playlist that works directly.
 */
export async function tizenHlsSource(url: string, referrer?: string): Promise<string> {
  const viaReferer = tizenHlsUrl(url, referrer)
  if (viaReferer !== url || !isTizenTv()) return viaReferer
  if (url.startsWith(TIZEN_RELAY_ORIGIN) || !looksLikeHls(url) || !iptvRelayable(url)) return url
  const u = parse(url)
  const key = u ? u.host : url
  const cached = corsVerdict.get(key)
  let ok = cached && Date.now() - cached.t < 10 * 60_000 ? cached.ok : null
  if (ok === null) {
    ok = await probeCors(url, 6000)
    corsVerdict.set(key, { t: Date.now(), ok })
  }
  if (ok) return url
  const ref = iptvReferer(referrer, url)
  return `${TIZEN_RELAY_ORIGIN}/hls?u=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`
}

/** Sports-replay embeds whose host refuses a file:// parent frame (frame-ancestors). */
export function isTizenFrameBlockedEmbed(url: string): boolean {
  const u = parse(url)
  if (!u) return false
  const h = u.hostname.toLowerCase()
  return /^(?:www\.)?vidaraa?\.(?:cc|to)$/.test(h) || /^(?:www\.)?playmate\.[a-z]+$/.test(h)
}

export type TizenExtracted = { ok: true; url: string; kind: 'hls' | 'mp4'; referer?: string } | { ok: false; error: string }

/** Relay /x: the frame-blocked embed's own stream URL, for native playback on the TV. */
export async function tizenExtractEmbed(url: string, timeoutMs = 12_000): Promise<TizenExtracted> {
  if (!isTizenTv() || !isTizenFrameBlockedEmbed(url)) return { ok: false, error: 'not extractable' }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${TIZEN_RELAY_ORIGIN}/x?u=${encodeURIComponent(url)}`, {
      credentials: 'omit',
      signal: ctl?.signal,
    })
    const j = (await res.json().catch(() => null)) as
      | { ok?: boolean; url?: string; kind?: string; referer?: string; error?: string }
      | null
    if (j?.ok && typeof j.url === 'string' && /^https:\/\//.test(j.url)) {
      return { ok: true, url: j.url, kind: j.kind === 'mp4' ? 'mp4' : 'hls', referer: j.referer }
    }
    return { ok: false, error: j?.error || `relay ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'relay failed' }
  } finally {
    if (timer) clearTimeout(timer)
  }
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
      const headers = new Headers(
        init?.headers || (typeof input === 'object' && 'headers' in input ? (input as Request).headers : undefined),
      )
      if (!shouldRelayFetch(url, method)) {
        // Referer-locked HLS probes (Movy / Atlantic …): the browser drops the Referer
        // header, so send the playlist through /hls with it instead.
        const ref = headers.get('referer') || ''
        if (ref && (method === 'GET' || method === 'HEAD') && looksLikeHls(url)) {
          const relayed = tizenHlsUrl(url, ref)
          if (relayed !== url) return nativeFetch(relayed, { method, credentials: 'omit', mode: 'cors', signal: init?.signal })
        }
        return nativeFetch(input as RequestInfo, init)
      }
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
