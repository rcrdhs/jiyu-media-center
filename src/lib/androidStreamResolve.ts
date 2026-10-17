/**
 * Android: use GeckoView to unwrap sports embeds → real media URL for Media3.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { isAndroidInAppBrowser } from './androidBrowser'

type ResolveMediaResult = {
  ok: boolean
  mediaUrl?: string
  pageUrl?: string
  referrer?: string
  error?: string
}

type InAppBrowserResolve = {
  resolveMedia: (options: {
    url: string
    timeoutMs?: number
  }) => Promise<ResolveMediaResult>
}

const NativeBrowser = registerPlugin<InAppBrowserResolve>('InAppBrowser')

export function canAndroidResolveEmbedMedia(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android' &&
      isAndroidInAppBrowser()
    )
  } catch {
    return false
  }
}

/** Probe an embed page in Gecko and return a playable media URL when found. */
export async function androidResolveEmbedMedia(
  embedUrl: string,
  timeoutMs = 12_000,
): Promise<ResolveMediaResult> {
  if (!canAndroidResolveEmbedMedia()) {
    return { ok: false, error: 'Not available' }
  }
  try {
    return await NativeBrowser.resolveMedia({ url: embedUrl, timeoutMs })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'resolveMedia failed',
    }
  }
}
