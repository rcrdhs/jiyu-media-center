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
}

type NativeTorrentStreamer = {
  stream: (options: {
    uri: string
    keepOthers?: boolean
    fileIndex?: number
    fileName?: string
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

export async function torrentStream(
  uri: string,
  options?: TorrentStreamOptions,
): Promise<TorrentStreamResult> {
  if (isDesktopTorrentAvailable() && window.signalDesktop?.torrentStream) {
    return window.signalDesktop.torrentStream(uri, options)
  }
  if (isAndroidTorrentAvailable()) {
    try {
      return await NativeTorrent.stream({
        uri,
        keepOthers: options?.keepOthers,
        fileIndex: options?.fileIndex,
        fileName: options?.fileName,
      })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Android torrent engine failed',
      }
    }
  }
  return {
    ok: false,
    error: 'Torrent playback needs the Jiyu desktop app or the Android torrent engine.',
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
        error: err instanceof Error ? err.message : 'Could not stop torrent',
      }
    }
  }
  return { ok: false, error: 'Torrent stop unavailable' }
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
        error: err instanceof Error ? err.message : 'Could not read torrent status',
      }
    }
  }
  return { ok: false, torrents: [], error: 'Torrent status unavailable' }
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
        error: err instanceof Error ? err.message : 'Could not resume torrent download',
      }
    }
  }
  return { ok: false, error: 'Torrent ensure-downloading unavailable' }
}
