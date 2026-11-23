/**
 * CVM Television — prefer official Vimeo event HLS; fall back to YouTube
 * `@cvm_television/live` when the Vimeo clip is down (site embeds the same event).
 */

import { CVM_VIMEO_EVENT_ID, CVM_VIMEO_EVENT_URL } from './vimeoLive'

export const CVM_YOUTUBE_LIVE_URLS = [
  'https://www.youtube.com/@cvm_television/live',
  'https://www.youtube.com/@cvmtvnews/live',
] as const

export const CVM_YOUTUBE_LIVE_URL = CVM_YOUTUBE_LIVE_URLS[0]

export function isCvmChannelId(id: string | undefined): boolean {
  return id === 'local-cvm'
}

export function isCvmVimeoUrl(url: string): boolean {
  const u = String(url || '')
  if (!u) return false
  if (u === CVM_VIMEO_EVENT_URL || u.includes(`/event/${CVM_VIMEO_EVENT_ID}`)) return true
  return /vimeo\.com\/event\/4401057/i.test(u)
}

export function cvmYoutubeFallbackUrl(detailUrl?: string): string {
  const detail = String(detailUrl || '').trim()
  if (/youtube\.com\/@/i.test(detail)) {
    return /\/live\/?$/i.test(detail) ? detail : `${detail.replace(/\/$/, '')}/live`
  }
  return CVM_YOUTUBE_LIVE_URL
}

export function cvmYoutubeLiveCandidates(detailUrl?: string): string[] {
  const primary = cvmYoutubeFallbackUrl(detailUrl)
  return [...new Set([primary, ...CVM_YOUTUBE_LIVE_URLS])]
}
