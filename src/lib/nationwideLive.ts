/**
 * Nationwide (90FM) live — prefer the jiyu-nnn HLS Worker (native player) over
 * the YouTube embed path that sat on "Unwrapping stream…".
 */

/** Direct m3u8 (not /nnn) — Android ExoPlayer / hls.js need a .m3u8 path. */
export const NATIONWIDE_HLS_URL = 'https://jiyu-nnn.free-river.workers.dev/live.m3u8'
export const NATIONWIDE_YOUTUBE_LIVE_URLS = [
  'https://www.youtube.com/@nnn-RADIOLIVE/live',
  'https://www.youtube.com/@nationwidenewsnetwork/live',
] as const

export function isNationwideChannelId(id: string | undefined): boolean {
  return id === 'local-nationwide'
}

export function isNationwideHlsUrl(url: string): boolean {
  const u = String(url || '')
  return (
    /jiyu\.free-river\.workers\.dev\/(?:nnn|nationwide)(?:\?|$)/i.test(u) ||
    /jiyu-nnn\.free-river\.workers\.dev(?:\/|$|\?)/i.test(u) ||
    /jiyu-nnn\.free-river\.workers\.dev\/live\.m3u8/i.test(u)
  )
}

/** True when the Worker returns a live m3u8 (not an offline JSON error). */
export async function probeNationwideHls(
  url: string = NATIONWIDE_HLS_URL,
  timeoutMs = 8_000,
): Promise<boolean> {
  const target = String(url || NATIONWIDE_HLS_URL).trim()
  if (!target) return false
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = window.setTimeout(() => ctrl?.abort(), timeoutMs)
  try {
    if (window.signalDesktop?.fetchPlaylist) {
      const result = await window.signalDesktop.fetchPlaylist(target)
      if (!result.ok || !result.content) return false
      const body = String(result.content)
      if (/^\s*\{/.test(body) && /"ok"\s*:\s*false/i.test(body)) return false
      return body.includes('#EXTM3U')
    }
    try {
      const { Capacitor } = await import('@capacitor/core')
      if (Capacitor.isNativePlatform()) {
        const { nativeFetchText } = await import('./nativeHttp')
        const result = await nativeFetchText(target, {
          quiet: true,
          headers: { Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' },
        })
        if (!result.ok || !result.content) return false
        const body = String(result.content)
        if (/^\s*\{/.test(body) && /"ok"\s*:\s*false/i.test(body)) return false
        return body.includes('#EXTM3U')
      }
    } catch {
      /* fall through */
    }
    const res = await fetch(target, {
      signal: ctrl?.signal,
      redirect: 'follow',
      headers: { Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' },
    })
    if (!res.ok) return false
    const body = await res.text()
    if (/^\s*\{/.test(body) && /"ok"\s*:\s*false/i.test(body)) return false
    return body.includes('#EXTM3U')
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

export function nationwideYoutubeFallbackUrl(detailUrl?: string): string {
  const detail = String(detailUrl || '').trim()
  if (/youtube\.com\/@/i.test(detail)) {
    return /\/live\/?$/i.test(detail) ? detail : `${detail.replace(/\/$/, '')}/live`
  }
  return NATIONWIDE_YOUTUBE_LIVE_URLS[0]
}
