/**
 * Kids mode — locks Browse to the Kids section until a PIN unlocks the full app.
 */

const ENABLED_KEY = 'jiyu.kidsMode.enabled'
const PIN_KEY = 'jiyu.kidsMode.pin'

export function isKidsModeEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function setKidsModeEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1')
    else localStorage.removeItem(ENABLED_KEY)
    window.dispatchEvent(new CustomEvent('jiyu:kids-mode'))
  } catch {
    /* ignore */
  }
}

export function hasKidsModePin(): boolean {
  try {
    return Boolean(localStorage.getItem(PIN_KEY)?.trim())
  } catch {
    return false
  }
}

/** Store a simple 4–8 digit PIN (home media; not cryptographic security). */
export function setKidsModePin(pin: string) {
  const clean = pin.replace(/\D/g, '').slice(0, 8)
  try {
    if (clean.length < 4) localStorage.removeItem(PIN_KEY)
    else localStorage.setItem(PIN_KEY, clean)
  } catch {
    /* ignore */
  }
}

export function verifyKidsModePin(pin: string): boolean {
  try {
    const stored = localStorage.getItem(PIN_KEY) || ''
    if (!stored) return true
    return pin.replace(/\D/g, '') === stored
  } catch {
    return false
  }
}

export function subscribeKidsMode(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener('jiyu:kids-mode', handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener('jiyu:kids-mode', handler)
    window.removeEventListener('storage', handler)
  }
}
