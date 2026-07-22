export type ViewingQuality = 'auto' | 720 | 1080 | 2160

const PREF_KEY = 'jiyu.pref.viewingQuality'

export function getViewingQuality(): ViewingQuality {
  try {
    const value = localStorage.getItem(PREF_KEY)
    if (value === '720') return 720
    if (value === '1080') return 1080
    if (value === '2160') return 2160
  } catch {
    // Use adaptive quality when storage is unavailable.
  }
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
  return 'Auto'
}
