/**
 * Atlantic / Cinecat family — TMDB → HLS via stream.hls.lol Helios
 * (route.transcode.cfd → zenoak) and cdn.hls.lol Aphrodite (totallyacdn).
 *
 * Prefer Helios: Aphrodite/totallyacdn often serves an encoded Cloudflare Warp
 * bumper video (looks like the atlantic.st interstitial) instead of the title.
 */

export const ATLANTIC_PLAY_REFERER = 'https://atlantic.st/'
export const ATLANTIC_CDN_ORIGIN = 'https://cdn.hls.lol'
export const ATLANTIC_HELIOS_ORIGIN = 'https://stream.hls.lol'

/**
 * atlantic.st's Cloudflare edge serves a Warp/VPN interstitial as HTML.
 * Aphrodite may also encode that same screen as an HLS "stream".
 */
export function looksLikeAtlanticWarpPage(body: string | undefined | null): boolean {
  const text = String(body || '')
  if (!text) return false
  if (/Cloudflare Warp VPN|using Cloudflare Warp|please disable it, and refresh/i.test(text)) {
    return true
  }
  if (
    /atlantic\.st/i.test(text) &&
    /Warp/i.test(text) &&
    /disable/i.test(text) &&
    !/#EXTM3U/i.test(text) &&
    !/id=["']root["']/i.test(text)
  ) {
    return true
  }
  return false
}

/** AES-GCM key used by Atlantic to unwrap Helios `hl_…` payloads (public client bundle). */
const HELIOS_KEY_HEX =
  '117c358bcfcaf8fe2cfca57c9d2238a300e1c4de2efb83a5012ba84d8a31f1dd'

export type AtlanticResolveOptions = {
  tmdbId: string | number
  mediaType: 'movie' | 'tv'
  season?: number
  episode?: number
  title?: string
}

export type AtlanticPlayResult =
  | {
      ok: true
      mode: 'hls'
      url: string
      referer: string
      provider: 'aphrodite' | 'helios'
      tmdbId: string
      season?: number
      episode?: number
    }
  | { ok: false; error: string }

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16)
  }
  return out
}

async function decryptHeliosUrl(enc: string): Promise<string> {
  if (!enc.startsWith('hl_')) return enc
  const bytes = hexToBytes(enc.slice(3))
  if (bytes.length < 28) throw new Error('Helios payload too short')
  const iv = bytes.slice(0, 12)
  const data = bytes.slice(12)
  const keyMaterial = hexToBytes(HELIOS_KEY_HEX)
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    data as BufferSource,
  )
  return new TextDecoder().decode(plain).trim()
}

async function fetchText(
  url: string,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    Referer: ATLANTIC_PLAY_REFERER,
    Origin: 'https://atlantic.st',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    try {
      // fetchJsonGet returns text body for any content-type.
      const r = await window.signalDesktop.fetchJsonGet(url, ATLANTIC_PLAY_REFERER)
      return {
        ok: Boolean(r.ok),
        status: Number(r.status) || 0,
        text: String(r.content || ''),
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const { nativeFetchText } = await import('./nativeHttp')
    const r = await nativeFetchText(url, {
      headers,
    })
    return { ok: r.ok, status: r.status || (r.ok ? 200 : 0), text: String(r.content || '') }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, text }
  } catch {
    return { ok: false, status: 0, text: '' }
  }
}

async function fetchBinarySize(url: string, timeoutMs = 8_000): Promise<number> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    Referer: ATLANTIC_PLAY_REFERER,
    Origin: 'https://atlantic.st',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  try {
    const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const r = await CapacitorHttp.get({
        url,
        headers,
        responseType: 'arraybuffer',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      if (r.status < 200 || r.status >= 300) return 0
      if (typeof r.data === 'string') {
        // base64
        return Math.floor((r.data.length * 3) / 4)
      }
      return Number((r.data as ArrayBuffer)?.byteLength || 0)
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return 0
    const buf = await res.arrayBuffer()
    return buf.byteLength
  } catch {
    return 0
  }
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    try {
      const r = await window.signalDesktop.fetchJsonGet(url, ATLANTIC_PLAY_REFERER)
      let json: unknown = null
      try {
        json = JSON.parse(String(r.content || 'null'))
      } catch {
        json = null
      }
      return { ok: Boolean(r.ok), status: Number(r.status) || 0, json }
    } catch {
      /* fall through */
    }
  }
  try {
    const { nativeFetchJson } = await import('./nativeHttp')
    const r = await nativeFetchJson<unknown>(url, {
      referer: ATLANTIC_PLAY_REFERER,
      headers: {
        Accept: 'application/json',
        Origin: 'https://atlantic.st',
        Referer: ATLANTIC_PLAY_REFERER,
      },
    })
    return { ok: r.ok, status: r.ok ? 200 : 0, json: r.data }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: ATLANTIC_PLAY_REFERER,
        Origin: 'https://atlantic.st',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, json }
  } catch {
    return { ok: false, status: 0, json: null }
  }
}

/**
 * Aphrodite/totallyacdn sometimes returns a long VOD that is only the Warp
 * interstitial re-encoded (~20–40 KB/s). Real 1080p is hundreds of KB/s+.
 */
async function aphroditeLooksLikeWarpBumper(masterUrl: string): Promise<boolean> {
  try {
    const master = await fetchText(masterUrl, 6_000)
    if (!master.ok || !/#EXTM3U/i.test(master.text)) return true
    if (looksLikeAtlanticWarpPage(master.text)) return true
    const levels = master.text
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
    const levelUrl = levels.at(-1) || levels[0]
    if (!levelUrl) return true
    const level = await fetchText(levelUrl, 6_000)
    if (!level.ok || !/#EXTM3U/i.test(level.text)) return true
    if (looksLikeAtlanticWarpPage(level.text)) return true
    const inf = level.text.match(/#EXTINF:([\d.]+)/i)
    const seg = level.text
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//i.test(l) && !/#EXT-X-MAP/i.test(l))
    // Prefer first media URI after EXTINF (skip MAP if listed as bare URL earlier).
    const lines = level.text.split(/\n/).map((l) => l.trim())
    let mediaUrl = ''
    let duration = Number(inf?.[1] || 0)
    for (let i = 0; i < lines.length; i++) {
      if (/^#EXTINF:/i.test(lines[i])) {
        duration = Number(lines[i].match(/#EXTINF:([\d.]+)/i)?.[1] || duration)
        const next = lines[i + 1]
        if (next && /^https?:\/\//i.test(next)) {
          mediaUrl = next
          break
        }
      }
    }
    if (!mediaUrl) mediaUrl = seg || ''
    if (!mediaUrl || !(duration > 0)) return false
    const bytes = await fetchBinarySize(mediaUrl, 8_000)
    if (!(bytes > 0)) return true
    const bytesPerSec = bytes / duration
    // Warp bumper we measured ~24 KB/s; real Helios ~650 KB/s+.
    return bytesPerSec < 80_000
  } catch {
    return true
  }
}

/** Aphrodite: direct HLS on totallyacdn (may be Warp bumper — probe before use). */
async function resolveAphrodite(
  opts: AtlanticResolveOptions,
): Promise<{ url: string } | null> {
  const id = String(opts.tmdbId).trim()
  const path =
    opts.mediaType === 'tv'
      ? `/content/tv/${id}/${Math.max(1, opts.season || 1)}/${Math.max(1, opts.episode || 1)}`
      : `/content/movie/${id}`
  const res = await fetchJson(`${ATLANTIC_CDN_ORIGIN}${path}`)
  if (!res.ok || !res.json || typeof res.json !== 'object') return null
  const body = res.json as {
    found?: boolean
    hls?: string
    type?: string
    url?: string
  }
  if (!body.found) return null
  const url = String(body.hls || (body.type === 'hls' ? body.url : '') || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  if (/atlantic\.st/i.test(url) && !/totallyacdn|cdn\.hls\.lol|stream\.hls\.lol/i.test(url)) {
    return null
  }
  if (await aphroditeLooksLikeWarpBumper(url)) return null
  return { url }
}

/** Helios: stream.hls.lol → route.transcode.cfd proxy (real title; needs atlantic.st Referer). */
async function resolveHelios(
  opts: AtlanticResolveOptions,
): Promise<{ url: string } | null> {
  const id = String(opts.tmdbId).trim()
  const params = new URLSearchParams()
  params.set('tmdbId', id)
  params.set('type', opts.mediaType)
  if (opts.mediaType === 'tv') {
    params.set('seasonId', String(Math.max(1, opts.season || 1)))
    params.set('episodeId', String(Math.max(1, opts.episode || 1)))
  }
  const res = await fetchJson(`${ATLANTIC_HELIOS_ORIGIN}/helios?${params}`)
  if (!res.ok || !res.json || typeof res.json !== 'object') return null
  const sources = (res.json as { sources?: Record<string, { url?: string }> }).sources
  const enc = String(sources?.Moscow?.url || '').trim()
  if (!enc) return null
  try {
    const url = await decryptHeliosUrl(enc)
    if (!/^https?:\/\//i.test(url)) return null
    // Quick sanity: master must be m3u8, not HTML/forbidden.
    const master = await fetchText(url, 8_000)
    if (!master.ok || !/#EXTM3U/i.test(master.text) || looksLikeAtlanticWarpPage(master.text)) {
      return null
    }
    return { url }
  } catch {
    return null
  }
}

export async function resolveAtlanticPlay(
  options: AtlanticResolveOptions,
): Promise<AtlanticPlayResult> {
  const tmdbId = String(options.tmdbId || '').trim()
  if (!tmdbId) return { ok: false, error: 'No TMDB id for Atlantic' }

  const season = options.mediaType === 'tv' ? Math.max(1, options.season || 1) : undefined
  const episode = options.mediaType === 'tv' ? Math.max(1, options.episode || 1) : undefined

  // Helios first — matches atlantic.st embed; Aphrodite is often a Warp bumper VOD.
  const helios = await resolveHelios(options)
  if (helios) {
    return {
      ok: true,
      mode: 'hls',
      url: helios.url,
      referer: ATLANTIC_PLAY_REFERER,
      provider: 'helios',
      tmdbId,
      season,
      episode,
    }
  }

  const aphrodite = await resolveAphrodite(options)
  if (aphrodite) {
    return {
      ok: true,
      mode: 'hls',
      url: aphrodite.url,
      referer: ATLANTIC_PLAY_REFERER,
      provider: 'aphrodite',
      tmdbId,
      season,
      episode,
    }
  }

  return { ok: false, error: 'No Atlantic HLS for this title' }
}

/** True when the playable URL looks like Movy / zenoak Direct (stall → Atlantic). */
export function isMovyStreamUrl(url: string | undefined): boolean {
  if (!url) return false
  // Hosts rotate (zenoak → paleoak / sun.*); match the family, not one CDN name.
  return /zenoak|paleoak|wecollege\.net|movy\.sx|\bmoon\.|\bsun\./i.test(url)
}
