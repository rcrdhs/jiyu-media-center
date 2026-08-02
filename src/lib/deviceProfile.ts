/**
 * Device-aware performance profiles for Jiyu.
 * Detects CPU/RAM/battery (Electron) or browser hints, then resolves knobs
 * for playback, torrents, and catalog sync — ready for phones/TVs later.
 */

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
    hlsMaxBufferLength: 30,
    hlsLowLatency: true,
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
    hlsMaxBufferLength: 18,
    hlsLowLatency: false,
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
  let score = 0
  if (cores >= 12 || (cores >= 8 && mem >= 16)) score += 3
  else if (cores >= 6 || (cores >= 4 && mem >= 8)) score += 2
  else score += 1

  if (mem >= 24) score += 2
  else if (mem >= 12) score += 1
  else if (mem > 0 && mem < 6) score -= 1

  if (caps.gpuAccelerated === false) score -= 1
  if (caps.onBattery === true) score -= 1

  // Very small machines (tablets / underpowered sticks).
  if (cores <= 2 || (mem > 0 && mem < 4)) return 'lite'

  if (score >= 5) return 'high'
  if (score <= 2) return 'lite'
  return 'balanced'
}

function browserCapabilities(): DeviceCapabilities {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean }
  }
  const cpuCount = Math.max(1, nav.hardwareConcurrency || 4)
  const totalMemGB =
    typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : 0
  const saveData = Boolean(nav.connection?.saveData)
  return {
    platform: nav.platform || 'web',
    arch: 'unknown',
    cpuCount,
    totalMemGB,
    freeMemGB: 0,
    onBattery: saveData ? true : null,
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
