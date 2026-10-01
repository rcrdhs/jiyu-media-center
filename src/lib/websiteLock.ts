/**
 * Library → Websites is owner-only. IPTV / M3U import stays open.
 * Unlock lasts for this app session.
 */

const UNLOCK_KEY = 'jiyu.websites.unlocked'
const CHANGE_EVENT = 'jiyu-website-lock'

/** Change this if you want a different owner passphrase. */
const PASSPHRASE = 'jiyu-owner'

export function isWebsiteAdminUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === '1'
  } catch {
    return false
  }
}

export function unlockWebsiteAdmin(passphrase: string): boolean {
  if (passphrase.trim() !== PASSPHRASE) return false
  try {
    sessionStorage.setItem(UNLOCK_KEY, '1')
  } catch {
    return false
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
  return true
}

export function lockWebsiteAdmin() {
  try {
    sessionStorage.removeItem(UNLOCK_KEY)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeWebsiteAdmin(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(CHANGE_EVENT, handler)
  return () => window.removeEventListener(CHANGE_EVENT, handler)
}
