import { normalizeIptvPlaylistUrl } from './iptv'
import { preparePlaylistContent } from './popularNews'
import { isDesktopApp } from './webBrowser'

const BRIDGE_POLL_MS = 50
const BRIDGE_MAX_WAIT_MS = 10_000

type DesktopPlaylistFetch = NonNullable<typeof window.signalDesktop>['fetchPlaylist']

async function waitForDesktopPlaylistFetch(): Promise<DesktopPlaylistFetch | undefined> {
  const deadline = Date.now() + BRIDGE_MAX_WAIT_MS
  while (Date.now() < deadline) {
    const fn = window.signalDesktop?.fetchPlaylist
    if (fn) return fn
    if (!isDesktopApp()) return undefined
    await new Promise((r) => setTimeout(r, BRIDGE_POLL_MS))
  }
  return window.signalDesktop?.fetchPlaylist
}

/** Fetch remote M3U/M3U8 over Electron IPC (avoids renderer CORS). */
export async function fetchRemotePlaylistContent(url: string): Promise<string> {
  const trimmed = normalizeIptvPlaylistUrl(url.trim())
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Playlist URL must start with http:// or https://')
  }

  const fetchPlaylist = await waitForDesktopPlaylistFetch()
  if (fetchPlaylist) {
    const result = await fetchPlaylist(trimmed)
    if (!result.ok) throw new Error(result.error || `Fetch failed (${result.status})`)
    return preparePlaylistContent(trimmed, result.content)
  }

  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchText } = await import('./nativeHttp')
      const result = await nativeFetchText(trimmed, { quiet: true })
      if (!result.ok) throw new Error(result.error || `Fetch failed (${result.status})`)
      return preparePlaylistContent(trimmed, result.content)
    }
  } catch (err) {
    if (err instanceof Error && /Fetch failed|Native|HTTP/i.test(err.message)) throw err
  }

  if (isDesktopApp()) {
    throw new Error('Desktop playlist bridge unavailable')
  }

  const response = await fetch(trimmed, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Fetch failed (${response.status})`)
  return preparePlaylistContent(trimmed, await response.text())
}
