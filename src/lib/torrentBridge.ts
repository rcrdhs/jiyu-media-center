/**
 * Unified torrent playback bridge.
 * Desktop → Electron WebTorrent. Android → Capacitor TorrentStreamer plugin.
 * Shared Player / Show / Watch call this so desktop behavior stays unchanged.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import type { TorrentInfo, TorrentStreamResult } from '../types'

export type TorrentStreamOptions = {
  keepOthers?: boolean
  fileIndex?: number
  fileName?: string
  /** Anime MULTI packs: remux Japanese audio instead of French a:0. */
  preferJapaneseAudio?: boolean
  category?: string
  anime?: boolean
  /** Sidecar torrent used only for its softsubs (Android: no 12 MB / 180 s readiness wait). */
  subtitleOnly?: boolean
}

type NativeTorrentStreamer = {
  stream: (options: {
    uri: string
    keepOthers?: boolean
    fileIndex?: number
    fileName?: string
    preferJapaneseAudio?: boolean
    subtitleOnly?: boolean
  }) => Promise<TorrentStreamResult>
  stop: (options?: { infoHash?: string }) => Promise<{ ok: boolean; error?: string }>
  status: (options?: { infoHash?: string }) => Promise<{
    ok: boolean
    torrents: TorrentInfo[]
    error?: string
  }>
  ensureDownloading: (options: {
    infoHash: string
    playheadSec?: number
    runtimeSec?: number
  }) => Promise<{ ok: boolean; error?: string }>
  /** Subtitle-step diagnostics → logcat (tag JiyuSubs). Missing on APKs before 0.3.80. */
  log?: (options: { message: string; tag?: string }) => Promise<void>
}

const NativeTorrent = registerPlugin<NativeTorrentStreamer>('TorrentStreamer')

export function isDesktopTorrentAvailable(): boolean {
  return Boolean(window.signalDesktop?.torrentStream)
}

export function isAndroidTorrentAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

export function isTorrentPlaybackAvailable(): boolean {
  return isDesktopTorrentAvailable() || isAndroidTorrentAvailable()
}

function wantsJapaneseAudio(options?: TorrentStreamOptions): boolean {
  return Boolean(
    options?.preferJapaneseAudio ||
      options?.anime ||
      String(options?.category || '').toLowerCase() === 'anime',
  )
}

export async function torrentStream(
  uri: string,
  options?: TorrentStreamOptions,
): Promise<TorrentStreamResult> {
  const preferJapaneseAudio = wantsJapaneseAudio(options)
  const bridged = { ...options, preferJapaneseAudio }
  if (isDesktopTorrentAvailable() && window.signalDesktop?.torrentStream) {
    return window.signalDesktop.torrentStream(uri, bridged)
  }
  if (isAndroidTorrentAvailable()) {
    try {
      return await NativeTorrent.stream({
        uri,
        keepOthers: options?.keepOthers,
        fileIndex: options?.fileIndex,
        fileName: options?.fileName,
        preferJapaneseAudio,
        subtitleOnly: options?.subtitleOnly,
      })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Android source engine failed',
      }
    }
  }
  return {
    ok: false,
    error: 'Playback needs the Jiyu desktop app or the Android source engine.',
  }
}

export async function torrentStop(infoHash?: string): Promise<{ ok: boolean; error?: string }> {
  if (window.signalDesktop?.torrentStop) {
    return window.signalDesktop.torrentStop(infoHash)
  }
  if (isAndroidTorrentAvailable()) {
    try {
      return await NativeTorrent.stop({ infoHash })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Could not stop source',
      }
    }
  }
  return { ok: false, error: 'Source stop unavailable' }
}

export async function torrentStatus(infoHash?: string): Promise<{
  ok: boolean
  torrents: TorrentInfo[]
  error?: string
}> {
  if (window.signalDesktop?.torrentStatus) {
    return window.signalDesktop.torrentStatus(infoHash)
  }
  if (isAndroidTorrentAvailable()) {
    try {
      return await NativeTorrent.status({ infoHash })
    } catch (err) {
      return {
        ok: false,
        torrents: [],
        error: err instanceof Error ? err.message : 'Could not read source status',
      }
    }
  }
  return { ok: false, torrents: [], error: 'Source status unavailable' }
}

export async function torrentEnsureDownloading(
  infoHash: string,
  playheadSec?: number,
  runtimeSec?: number,
): Promise<{ ok: boolean; error?: string }> {
  if (window.signalDesktop?.torrentEnsureDownloading) {
    return window.signalDesktop.torrentEnsureDownloading(infoHash, playheadSec, runtimeSec)
  }
  if (isAndroidTorrentAvailable()) {
    try {
      return await NativeTorrent.ensureDownloading({ infoHash, playheadSec, runtimeSec })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Could not resume source download',
      }
    }
  }
  return { ok: false, error: 'Source download unavailable' }
}

let nativeLogUnavailable = false

/** Android: write one diagnostics line to logcat via the TorrentStreamer plugin (tag JiyuSubs). */
/** Logcat line (tag JiyuSubs, or JiyuBili when `tag` is passed and the APK supports it). */
export function nativeSubtitleLog(message: string, tag?: 'JiyuBili'): void {
  if (nativeLogUnavailable || !isAndroidTorrentAvailable()) return
  try {
    const call = NativeTorrent.log?.(tag ? { message, tag } : { message })
    if (call && typeof call.catch === 'function') {
      call.catch(() => {
        // Older APK without the method: stop trying, console.info still shows in WebView logs.
        nativeLogUnavailable = true
      })
    }
  } catch {
    nativeLogUnavailable = true
  }
}
