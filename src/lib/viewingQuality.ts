import { clampQualityToDevice } from './deviceProfile'

export type ViewingQuality = 'auto' | 480 | 720 | 1080 | 2160

const PREF_KEY = 'jiyu.pref.viewingQuality'

type NetworkConnection = {
  downlink?: number
  effectiveType?: string
  saveData?: boolean
}

function networkConnection(): NetworkConnection | undefined {
  return (navigator as unknown as { connection?: NetworkConnection }).connection
}

/** Effective downlink (Mbps) estimate from the browser, 0 if unknown. */
export function getConnectionDownlinkMbps(): number {
  const downlink = networkConnection()?.downlink
  return typeof downlink === 'number' && downlink > 0 ? downlink : 0
}

/**
 * Highest quality a connection can comfortably sustain.
 * Slow / metered links prefer 480p when that release exists.
 */
export function targetQualityForSpeed(downlinkMbps: number): number {
  const conn = networkConnection()
  if (conn?.saveData) return clampQualityToDevice(480)

  const effective = String(conn?.effectiveType || '').toLowerCase()
  if (effective === 'slow-2g' || effective === '2g' || effective === '3g') {
    return clampQualityToDevice(480)
  }

  let network = 720
  if (downlinkMbps <= 0) network = 720 // unknown → start at 720p
  else if (downlinkMbps < 4) network = 480
  else if (downlinkMbps < 10) network = 720
  else if (downlinkMbps < 20) network = 1080
  else network = 2160

  // Device profile caps Auto so weak machines don't attempt 4K remux.
  return clampQualityToDevice(network)
}

export function getViewingQuality(): ViewingQuality {
  try {
    const value = localStorage.getItem(PREF_KEY)
    if (value === '480') return 480
    if (value === '720') return 720
    if (value === '1080') return 1080
    if (value === '2160') return 2160
    if (value === 'auto') return 'auto'
  } catch {
    // Fall through to the default.
  }
  // Default: Auto — pick from internet speed + device cap.
  return 'auto'
}

export function setViewingQuality(value: ViewingQuality) {
  try {
    localStorage.setItem(PREF_KEY, String(value))
  } catch {
    // The in-memory UI selection still applies to this session.
  }
  window.dispatchEvent(new CustomEvent('jiyu:viewing-quality', { detail: value }))
}

export function viewingQualityLabel(value: ViewingQuality): string {
  if (value === 2160) return '4K'
  if (value === 1080) return '1080p'
  if (value === 720) return '720p'
  if (value === 480) return '480p'
  return 'Auto'
}

/**
 * Concrete height target for torrent / HLS picks.
 * Auto uses measured downlink (and Network Information hints).
 */
export function resolveRequestedQuality(
  preference: ViewingQuality = getViewingQuality(),
  downlinkMbps: number = getConnectionDownlinkMbps(),
): number {
  if (preference === 'auto') return targetQualityForSpeed(downlinkMbps)
  return preference
}
