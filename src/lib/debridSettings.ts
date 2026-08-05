/**
 * Optional Real-Debrid API key for Torrentio HTTP streams.
 * Stored only on this device (localStorage).
 */

const KEY = 'jiyu.debrid.realdebridToken'

export type DebridProviderId = 'realdebrid'

export function getRealDebridToken(): string {
  try {
    return (localStorage.getItem(KEY) || '').trim()
  } catch {
    return ''
  }
}

export function setRealDebridToken(token: string) {
  const next = token.trim()
  try {
    if (!next) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('jiyu:debrid-settings'))
  } catch {
    /* ignore */
  }
}

export function hasRealDebridToken(): boolean {
  return getRealDebridToken().length >= 8
}

/** Real-Debrid account page that shows the API token. */
export const REAL_DEBRID_TOKEN_URL = 'https://real-debrid.com/apitoken'
