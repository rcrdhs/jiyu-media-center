/**
 * Device-aware performance profiles for Jiyu.
 * Detects CPU/RAM/battery (Electron) or browser hints, then resolves knobs
 * for playback, torrents, and catalog sync — ready for phones/TVs later.
 */

import { Capacitor } from '@capacitor/core'

export type PerformanceMode = 'auto' | 'high' | 'balanced' | 'lite'
export type DeviceClass = 'high' | 'balanced' | 'lite'

export interface DeviceCapabilities {
  platform: string
  arch: string
  cpuCount: number
  totalMemGB: number
  freeMemGB: number
  onBattery: boolean | null
  gpuAccelerated: boolean | null
  source: 'electron' | 'browser' | 'fallback'
}

export interface PerformanceKnobs {
  mode: PerformanceMode
  deviceClass: DeviceClass
  /** Cap for Auto quality and torrent picks. */
  maxQuality: 720 | 1080 | 2160
  hlsMaxBufferLength: number
  hlsLowLatency: boolean
  /**
   * Live sports / IPTV HLS — keep farther behind the live edge than VOD.
   * Public match feeds jitter; low-latency ABR is the usual stall source.
   */
  liveHlsMaxBufferLength: number
  liveHlsSyncSegments: number
  liveHlsLowLatency: boolean
  /** MPEG-TS / FLV live (mpegts.js): stash absorbs jitter; chasing the edge removes it. */
  mpegTsEnableStashBuffer: boolean
  mpegTsStashInitialSize: number
  mpegTsLiveLatencyChasing: boolean
  mpegTsLiveLatencyMaxLatency: number
  enableMediaWorkers: boolean
  torrentMaxConns: number
  torrentPrefetchPieces: number
  torrentCriticalPieces: number
  remuxStallMs: number
  localStallMs: number
  pausePrefetchMs: number
  /** Keep this many seconds of playable lead ahead of the remux playhead. */
  remuxLeadSeconds: number
  syncYieldMs: number
  syncShowlistYieldMs: number
  syncIdbBatchSize: number
  streamProbeConcurrency: number
  summary: string
}

const MODE_KEY = 'jiyu.pref.performanceMode'
const PROFILE_EVENT = 'jiyu:performance-profile'

const CLASS_KNOBS: Record<DeviceClass, Omit<PerformanceKnobs, 'mode' | 'deviceClass' | 'summary'>> = {
  high: {
    maxQuality: 2160,
    hlsMaxBufferLength: 45,
    hlsLowLatency: true,
    liveHlsMaxBufferLength: 60,
    liveHlsSyncSegments: 5,
    liveHlsLowLatency: false,
    mpegTsEnableStashBuffer: true,
    mpegTsStashInitialSize: 384 * 1024,
    mpegTsLiveLatencyChasing: false,
    mpegTsLiveLatencyMaxLatency: 8,
    enableMediaWorkers: true,
    torrentMaxConns: 100,
    torrentPrefetchPieces: 160,
    torrentCriticalPieces: 24,
    remuxStallMs: 90_000,
    localStallMs: 55_000,
    pausePrefetchMs: 15_000,
    remuxLeadSeconds: 12,
    syncYieldMs: 40,
    syncShowlistYieldMs: 120,
    syncIdbBatchSize: 300,
    streamProbeConcurrency: 28,
  },
  balanced: {
    maxQuality: 1080,
    hlsMaxBufferLength: 36,
    hlsLowLatency: false,
    liveHlsMaxBufferLength: 48,
    liveHlsSyncSegments: 6,
    liveHlsLowLatency: false,
    mpegTsEnableStashBuffer: true,
    mpegTsStashInitialSize: 512 * 1024,
    mpegTsLiveLatencyChasing: false,
    mpegTsLiveLatencyMaxLatency: 10,
    enableMediaWorkers: true,
    torrentMaxConns: 64,
    torrentPrefetchPieces: 120,
    torrentCriticalPieces: 16,
    remuxStallMs: 75_000,
    localStallMs: 45_000,
    pausePrefetchMs: 20_000,
    remuxLeadSeconds: 10,
    syncYieldMs: 80,
    syncShowlistYieldMs: 200,
    syncIdbBatchSize: 250,
    streamProbeConcurrency: 20,
  },
  lite: {
    maxQuality: 720,
    hlsMaxBufferLength: 24,
    hlsLowLatency: false,
    // Still hold enough live media — 18s was stalling sports on mid phones.
    liveHlsMaxBufferLength: 40,
    liveHlsSyncSegments: 7,
    liveHlsLowLatency: false,
    mpegTsEnableStashBuffer: true,
    mpegTsStashInitialSize: 768 * 1024,
    mpegTsLiveLatencyChasing: false,
    mpegTsLiveLatencyMaxLatency: 12,
    enableMediaWorkers: false,
    torrentMaxConns: 32,
    torrentPrefetchPieces: 64,
    torrentCriticalPieces: 10,
    remuxStallMs: 90_000,
    localStallMs: 55_000,
    pausePrefetchMs: 25_000,
    remuxLeadSeconds: 6,
    syncYieldMs: 140,
    syncShowlistYieldMs: 280,
    syncIdbBatchSize: 120,
    streamProbeConcurrency: 10,
  },
}

let cachedCaps: DeviceCapabilities | null = null
let cachedKnobs: PerformanceKnobs | null = null
let initPromise: Promise<PerformanceKnobs> | null = null

export function getPerformanceMode(): PerformanceMode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    if (value === 'high' || value === 'balanced' || value === 'lite' || value === 'auto') {
      return value
    }
  } catch {
    /* ignore */
  }
  return 'auto'
}

export function setPerformanceMode(mode: PerformanceMode) {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
  cachedKnobs = null
  void ensurePerformanceProfile().then((knobs) => {
    window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: knobs }))
  })
}

export function performanceModeLabel(mode: PerformanceMode): string {
  if (mode === 'high') return 'High'
  if (mode === 'balanced') return 'Balanced'
  if (mode === 'lite') return 'Lite'
  return 'Auto (detect device)'
}

export function classifyDevice(caps: DeviceCapabilities): DeviceClass {
  const cores = Math.max(1, caps.cpuCount || 1)
  const mem = Math.max(0, caps.totalMemGB || 0)
  const android = caps.platform === 'android'
  let score = 0
  if (cores >= 12 || (cores >= 8 && mem >= 16)) score += 3
  else if (cores >= 6 || (cores >= 4 && mem >= 8)) score += 2
  else score += 1

  if (mem >= 24) score += 2
  else if (mem >= 12) score += 1
  else if (mem > 0 && mem < 6) score -= 1

  if (caps.gpuAccelerated === false) score -= 1
  // Laptops on battery: gentle; phones are always "on battery" so ignore that flag on Android.
  if (caps.onBattery === true && !android) score -= 1

  // Very small machines (tablets / underpowered sticks).
  if (cores <= 2 || (mem > 0 && mem < 4)) return 'lite'

  // Mid Android phones report capped cores / opaque RAM — prefer balanced over lite
  // so live sports keep a usable HLS/TS buffer floor.
  if (android && score <= 2 && cores >= 4) return 'balanced'

  if (score >= 5) return 'high'
  if (score <= 2) return 'lite'
  return 'balanced'
}

function browserCapabilities(): DeviceCapabilities {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean; effectiveType?: string }
  }
  const cpuCount = Math.max(1, nav.hardwareConcurrency || 4)
  const totalMemGB =
    typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : 0
  const saveData = Boolean(nav.connection?.saveData)
  let platform = nav.platform || 'web'
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      platform = 'android'
    }
  } catch {
    /* ignore */
  }
  const android = platform === 'android'
  return {
    platform,
    arch: 'unknown',
    // Keep enough cores visible for classification; old min(4) forced lite on phones.
    cpuCount: android ? Math.min(cpuCount, 8) : cpuCount,
    // Unknown Android RAM: assume mid-range so we don't self-classify as lite.
    totalMemGB: android && totalMemGB <= 0 ? 8 : totalMemGB,
    freeMemGB: 0,
    onBattery: android ? null : saveData ? true : null,
    gpuAccelerated: null,
    source: totalMemGB > 0 || nav.hardwareConcurrency ? 'browser' : 'fallback',
  }
}

function summarize(caps: DeviceCapabilities, deviceClass: DeviceClass): string {
  const platform =
    caps.platform === 'win32'
      ? 'Windows'
      : caps.platform === 'darwin'
        ? 'macOS'
        : caps.platform === 'linux'
          ? 'Linux'
          : caps.platform === 'android'
            ? 'Android'
            : caps.platform || 'Device'
  const parts = [
    platform,
    `${caps.cpuCount} core${caps.cpuCount === 1 ? '' : 's'}`,
  ]
  if (caps.totalMemGB > 0) {
    parts.push(`${caps.totalMemGB.toFixed(caps.totalMemGB >= 10 ? 0 : 1)} GB RAM`)
  }
  if (caps.onBattery === true) parts.push('on battery')
  if (caps.gpuAccelerated === false) parts.push('software GPU')
  const classLabel =
    deviceClass === 'high' ? 'High' : deviceClass === 'lite' ? 'Lite' : 'Balanced'
  return `${parts.join(' · ')} → ${classLabel}`
}

export function knobsForClass(
  deviceClass: DeviceClass,
  mode: PerformanceMode,
  caps: DeviceCapabilities,
): PerformanceKnobs {
  return {
    mode,
    deviceClass,
    ...CLASS_KNOBS[deviceClass],
    summary: summarize(caps, deviceClass),
  }
}

export function getCachedCapabilities(): DeviceCapabilities | null {
  return cachedCaps
}

/** Synchronous knobs for hot paths — uses last resolved profile or balanced defaults. */
export function getPerformanceKnobs(): PerformanceKnobs {
  if (cachedKnobs) return cachedKnobs
  const caps = cachedCaps || browserCapabilities()
  const mode = getPerformanceMode()
  const deviceClass = mode === 'auto' ? classifyDevice(caps) : mode
  cachedKnobs = knobsForClass(deviceClass, mode, caps)
  return cachedKnobs
}

async function loadCapabilities(): Promise<DeviceCapabilities> {
  const api = window.signalDesktop
  if (api?.getSystemCapabilities) {
    try {
      const remote = await api.getSystemCapabilities()
      if (remote && typeof remote.cpuCount === 'number') {
        return {
          platform: String(remote.platform || 'unknown'),
          arch: String(remote.arch || 'unknown'),
          cpuCount: Math.max(1, Number(remote.cpuCount) || 1),
          totalMemGB: Math.max(0, Number(remote.totalMemGB) || 0),
          freeMemGB: Math.max(0, Number(remote.freeMemGB) || 0),
          onBattery: typeof remote.onBattery === 'boolean' ? remote.onBattery : null,
          gpuAccelerated:
            typeof remote.gpuAccelerated === 'boolean' ? remote.gpuAccelerated : null,
          source: 'electron',
        }
      }
    } catch {
      /* fall through */
    }
  }
  return browserCapabilities()
}

async function pushKnobsToMain(knobs: PerformanceKnobs) {
  const api = window.signalDesktop
  if (!api?.setPerformanceKnobs) return
  try {
    await api.setPerformanceKnobs({
      torrentMaxConns: knobs.torrentMaxConns,
      torrentPrefetchPieces: knobs.torrentPrefetchPieces,
      torrentCriticalPieces: knobs.torrentCriticalPieces,
      streamProbeConcurrency: knobs.streamProbeConcurrency,
      deviceClass: knobs.deviceClass,
    })
  } catch {
    /* ignore */
  }
}

/** Detect device once (or after mode change) and publish knobs to main + UI. */
export async function ensurePerformanceProfile(): Promise<PerformanceKnobs> {
  if (!initPromise) {
    initPromise = (async () => {
      cachedCaps = await loadCapabilities()
      const mode = getPerformanceMode()
      const deviceClass = mode === 'auto' ? classifyDevice(cachedCaps) : mode
      cachedKnobs = knobsForClass(deviceClass, mode, cachedCaps)
      await pushKnobsToMain(cachedKnobs)
      initPromise = null
      return cachedKnobs
    })()
  }
  return initPromise
}

export function onPerformanceProfile(
  callback: (knobs: PerformanceKnobs) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PerformanceKnobs>).detail
    if (detail) callback(detail)
  }
  window.addEventListener(PROFILE_EVENT, handler)
  return () => window.removeEventListener(PROFILE_EVENT, handler)
}

/** Clamp a quality target to what this device should attempt. */
export function clampQualityToDevice(quality: number): number {
  const max = getPerformanceKnobs().maxQuality
  if (!Number.isFinite(quality) || quality <= 0) return max
  return Math.min(quality, max)
}
