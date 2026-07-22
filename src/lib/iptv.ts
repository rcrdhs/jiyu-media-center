/**
 * Build and normalize IPTV / Xtream Codes playlist URLs.
 * Users supply their own provider credentials or open playlist links.
 */

export type IptvOutput = 'hls' | 'ts' | 'mpegts'

export interface XtreamCredentials {
  /** e.g. http://host:8080, host:8080, or a full .m3u / get.php URL */
  server: string
  /** Optional — leave blank for open / no-auth playlists */
  username?: string
  /** Optional — leave blank for open / no-auth playlists */
  password?: string
  output?: IptvOutput
}

export function normalizeServerBase(server: string): string {
  let s = server.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  // Strip accidental get.php / player_api paths when we only need the panel root
  s = s.replace(/\/(get\.php|player_api\.php|panel_api\.php).*$/i, '')
  return s.replace(/\/+$/, '')
}

function mapOutput(output: IptvOutput): string {
  if (output === 'hls') return 'hls'
  return 'ts'
}

function isDirectPlaylistUrl(server: string): boolean {
  const s = server.trim()
  return /\.m3u8?(\?|$)/i.test(s) || /[?&]type=m3u(_plus)?\b/i.test(s)
}

/**
 * Build a playlist fetch URL from panel host and optional credentials.
 * Username/password are omitted when blank (open IPTV / public M3U hosts).
 */
export function buildXtreamPlaylistUrl(creds: XtreamCredentials): string {
  const raw = creds.server.trim()
  const output = mapOutput(creds.output ?? 'hls')
  const user = creds.username?.trim() ?? ''
  const pass = creds.password?.trim() ?? ''

  // Full playlist link pasted into the server field
  if (isDirectPlaylistUrl(raw)) {
    return normalizeIptvPlaylistUrl(raw)
  }

  // get.php (or similar) already on the URL — keep it, fill missing bits
  try {
    const asUrl = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (/get\.php$/i.test(asUrl.pathname)) {
      if (user) asUrl.searchParams.set('username', user)
      if (pass) asUrl.searchParams.set('password', pass)
      if (!asUrl.searchParams.has('type')) asUrl.searchParams.set('type', 'm3u_plus')
      if (!asUrl.searchParams.has('output')) asUrl.searchParams.set('output', output)
      return asUrl.toString()
    }
  } catch {
    /* fall through */
  }

  const base = normalizeServerBase(raw)
  const params = new URLSearchParams()
  if (user) params.set('username', user)
  if (pass) params.set('password', pass)
  params.set('type', 'm3u_plus')
  params.set('output', output)
  return `${base}/get.php?${params.toString()}`
}

/**
 * If the user pastes a bare get.php link or panel URL, normalize toward an M3U playlist fetch URL.
 */
export function normalizeIptvPlaylistUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return raw

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    const path = url.pathname.toLowerCase()

    // Already a get.php playlist
    if (path.endsWith('/get.php') || path.endsWith('get.php')) {
      if (!url.searchParams.has('type')) url.searchParams.set('type', 'm3u_plus')
      if (!url.searchParams.has('output')) url.searchParams.set('output', 'hls')
      return url.toString()
    }

    // player_api.php → convert to get.php m3u_plus (with or without credentials)
    if (path.includes('player_api.php') || path.includes('panel_api.php')) {
      const user = url.searchParams.get('username') ?? ''
      const pass = url.searchParams.get('password') ?? ''
      return buildXtreamPlaylistUrl({
        server: `${url.protocol}//${url.host}`,
        username: user,
        password: pass,
        output: 'hls',
      })
    }

    return url.toString()
  } catch {
    return raw
  }
}

export function looksLikeIptvUrl(url: string): boolean {
  return /get\.php|player_api\.php|m3u_plus|\.m3u8?(\?|$)/i.test(url)
}

/** Detect MPEG-TS style live URLs common in IPTV (non-HLS). */
export function isMpegTsUrl(url: string): boolean {
  if (/\.m3u8(\?|$)/i.test(url)) return false
  if (/\.mp4(\?|$)/i.test(url)) return false
  if (/\.ts(\?|$)/i.test(url)) return true
  // Xtream live lines: http://host:port/live/user/pass/123.ts or /123
  if (/\/live\/[^/]+\/[^/]+\/\d+(\.ts)?(\?|$)/i.test(url)) return true
  if (/\/movie\/[^/]+\/[^/]+\/\d+(\.mp4|\.mkv|\.ts)?(\?|$)/i.test(url)) return false
  if (/\/series\/[^/]+\/[^/]+\/\d+(\.mp4|\.mkv|\.ts)?(\?|$)/i.test(url)) return false
  if (/[?&]output=ts\b/i.test(url)) return true
  return false
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || /[?&]output=hls\b/i.test(url)
}
