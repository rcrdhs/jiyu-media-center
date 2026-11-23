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
  sniffCurrentMedia?: () => Promise<ResolveMediaResult>
}

const NativeBrowser = registerPlugin<InAppBrowserResolve>('InAppBrowser')

/** Coalesce StrictMode / remount double-sniffs for the same embed URL. */
const inflightByUrl = new Map<string, Promise<ResolveMediaResult>>()
const recentByUrl = new Map<string, { at: number; result: ResolveMediaResult }>()
const RECENT_MS = 15_000

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
  const key = String(embedUrl || '').trim()
  if (!key) return { ok: false, error: 'Empty URL' }

  const recent = recentByUrl.get(key)
  if (recent && Date.now() - recent.at < RECENT_MS) {
    return recent.result
  }

  const existing = inflightByUrl.get(key)
  if (existing) return existing

  const work = (async (): Promise<ResolveMediaResult> => {
    try {
      const result = await NativeBrowser.resolveMedia({ url: key, timeoutMs })
      recentByUrl.set(key, { at: Date.now(), result })
      return result
    } catch (err) {
      const result = {
        ok: false as const,
        error: err instanceof Error ? err.message : 'resolveMedia failed',
      }
      recentByUrl.set(key, { at: Date.now(), result })
      return result
    } finally {
      inflightByUrl.delete(key)
    }
  })()

  inflightByUrl.set(key, work)
  return work
}

/**
 * Sniff the already-open Gecko page for a playable media URL (no reload).
 * Used to promote StreamCorner Bitmovin → Media3 after the embed is playing.
 */
export async function androidSniffCurrentMedia(): Promise<ResolveMediaResult> {
  if (!canAndroidResolveEmbedMedia()) {
    return { ok: false, error: 'Not available' }
  }
  if (typeof NativeBrowser.sniffCurrentMedia !== 'function') {
    return { ok: false, error: 'sniffCurrentMedia unavailable' }
  }
  try {
    return await NativeBrowser.sniffCurrentMedia()
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'sniffCurrentMedia failed',
    }
  }
}
