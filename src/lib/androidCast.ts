/**
 * Android Google Cast — only for streams with a real media URL.
 * Sports embeds have no castable URL; offer screen-cast settings instead.
 * If an embed source later yields a real HLS/MP4 URL, Cast uses that URL.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { isHlsUrl } from './iptv'
import { isWebEmbedPlaybackItem, isWebBrowserOnlyUrl } from './webBrowser'

type CastState = {
  ok?: boolean
  casting?: boolean
  deviceName?: string
  position?: number
  playing?: boolean
}

type AppCastPlugin = {
  isAvailable: () => Promise<{ ok?: boolean; available?: boolean }>
  getState: () => Promise<CastState>
  showPicker: () => Promise<{ ok?: boolean }>
  castMedia: (options: {
    url: string
    title?: string
    subtitle?: string
    imageUrl?: string
    contentType?: string
    position?: number
  }) => Promise<CastState>
  stop: () => Promise<CastState>
  openScreenCastSettings: () => Promise<{ ok?: boolean }>
  addListener: (
    event: 'castState',
    listener: (state: CastState) => void,
  ) => Promise<PluginListenerHandle>
}

const AppCast = registerPlugin<AppCastPlugin>('AppCast')

function isRemuxPlaybackUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return /\/stream\.mp4$/i.test(parsed.pathname) || parsed.searchParams.has('source')
  } catch {
    return false
  }
}

export function isAndroidCastHost(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** True when Jiyu has a media URL a Cast receiver can open (not a sports embed page). */
export function isCastableMediaUrl(url: string | undefined | null): boolean {
  const raw = String(url || '').trim()
  if (!raw) return false
  if (raw.startsWith('blob:')) return false
  if (!/^https?:\/\//i.test(raw)) return false
  if (isWebBrowserOnlyUrl(raw)) return false
  if (isRemuxPlaybackUrl(raw)) return true
  if (isHlsUrl(raw)) return true
  if (/\.m3u8(\?|#|$)/i.test(raw) || /format=m3u8/i.test(raw)) return true
  if (/\.mp4(\?|#|$)/i.test(raw) || /\/stream\.mp4/i.test(raw)) return true
  // Debrid / CDN direct links often omit an extension but are still progressive MP4.
  if (/real-debrid\.com|alldebrid\.com|premiumize\./i.test(raw)) return true
  return false
}

/**
 * media — hand a URL to Chromecast.
 * mirror — no URL (sports/embed); open system screen-cast settings.
 * none — not Android / nothing to offer.
 *
 * A real media URL wins even if the catalog item is still tagged as a web embed.
 */
export function castModeForPlayback(
  item: {
    url?: string
    tags?: string[]
    source?: string
    streamedMatchId?: string
  },
  playUrl?: string,
): 'media' | 'mirror' | 'none' {
  if (!isAndroidCastHost()) return 'none'
  const mediaUrl = playUrl || item.url
  if (isCastableMediaUrl(mediaUrl)) return 'media'
  if (isWebEmbedPlaybackItem(item)) return 'mirror'
  if (item.url && isWebBrowserOnlyUrl(item.url)) return 'mirror'
  return 'none'
}

export async function androidCastAvailable(): Promise<boolean> {
  if (!isAndroidCastHost()) return false
  try {
    const result = await AppCast.isAvailable()
    return Boolean(result.available)
  } catch {
    return false
  }
}

export async function androidCastMedia(options: {
  url: string
  title?: string
  subtitle?: string
  imageUrl?: string
  contentType?: string
  position?: number
}): Promise<CastState> {
  return AppCast.castMedia(options)
}

export async function androidCastStop(): Promise<CastState> {
  return AppCast.stop()
}

export async function androidCastGetState(): Promise<CastState> {
  try {
    return await AppCast.getState()
  } catch {
    return { casting: false }
  }
}

export async function androidOpenScreenCastSettings(): Promise<void> {
  await AppCast.openScreenCastSettings()
}

export function onAndroidCastState(listener: (state: CastState) => void): () => void {
  if (!isAndroidCastHost()) return () => {}
  let handle: PluginListenerHandle | undefined
  let removed = false
  void AppCast.addListener('castState', listener).then((h) => {
    if (removed) {
      void h.remove()
      return
    }
    handle = h
  })
  return () => {
    removed = true
    void handle?.remove()
  }
}
