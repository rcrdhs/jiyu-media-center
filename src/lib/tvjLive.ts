/**
 * TVJ — prefer univtec HLS; fall back to YouTube `@TelevisionJamaica/live`
 * when the public m3u8 is down.
 */

export const TVJ_HLS_URL =
  'https://vod2live.univtec.com/manifest/a99a1804-dc83-411f-8c1c-b62f08cdfa59.m3u8'

export const TVJ_YOUTUBE_LIVE_URL = 'https://www.youtube.com/@TelevisionJamaica/live'

export function isTvjChannelId(id: string | undefined): boolean {
  return id === 'local-tvj'
}

export function isTvjHlsUrl(url: string): boolean {
  return /vod2live\.univtec\.com\/manifest\/a99a1804-dc83-411f-8c1c-b62f08cdfa59/i.test(
    String(url || ''),
  )
}

export function tvjYoutubeFallbackUrl(detailUrl?: string): string {
  const detail = String(detailUrl || '').trim()
  if (/youtube\.com\/@/i.test(detail)) {
    return /\/live\/?$/i.test(detail) ? detail : `${detail.replace(/\/$/, '')}/live`
  }
  return TVJ_YOUTUBE_LIVE_URL
}
