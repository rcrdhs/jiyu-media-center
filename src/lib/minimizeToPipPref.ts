/**
 * When enabled, the OS minimize button demotes the active stream to PiP
 * instead of hiding the window (taskbar minimize still available via menu).
 */

const PREF_KEY = 'jiyu.pref.minimizeToPip'
const EVENT = 'jiyu:minimize-to-pip-pref'

/** Default on — matches “keep watching small” for a media center. */
export function isMinimizeToPipEnabled(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw === '0') return false
    if (raw === '1') return true
  } catch {
    /* ignore */
  }
  return true
}

export function setMinimizeToPipEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }))
}

export function subscribeMinimizeToPipPref(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}
