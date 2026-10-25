/**
 * Sync endpoint for all Jiyu builds (Android WebView, Electron, future TV/Apple).
 *
 * Priority:
 *   1. Runtime override (Library → Sync server URL) — shared key on every build
 *   2. Build-time __JIYU_SYNC_URL__ (VITE_JIYU_SYNC_URL, else config/public-sync.json)
 *
 * HTTPS only. Plain http is accepted for loopback hosts (local sandbox / wrangler dev).
 */

import { PROGRESS_SYNC_EVENT, PROGRESS_SYNC_URL_KEY } from './types'

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** https://… anywhere, or http://localhost / 127.0.0.1 for local testing. */
export function isAllowedSyncUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

function bakedSyncUrl(): string {
  try {
    const fromDefine =
      typeof __JIYU_SYNC_URL__ === 'string' ? normalizeUrl(__JIYU_SYNC_URL__) : ''
    if (fromDefine && isAllowedSyncUrl(fromDefine)) return fromDefine
  } catch {
    /* ignore */
  }
  try {
    const fromEnv = normalizeUrl(String(import.meta.env?.VITE_JIYU_SYNC_URL || ''))
    if (fromEnv && isAllowedSyncUrl(fromEnv)) return fromEnv
  } catch {
    /* ignore */
  }
  return ''
}

export function defaultProgressSyncUrl(): string {
  return bakedSyncUrl()
}

export function progressSyncBaseUrl(): string {
  try {
    const override = normalizeUrl(localStorage.getItem(PROGRESS_SYNC_URL_KEY) || '')
    if (override && isAllowedSyncUrl(override)) return override
  } catch {
    /* ignore */
  }
  return bakedSyncUrl()
}

/**
 * Persist a per-device sync host (empty clears override; the built-in URL still applies).
 * Throws on a non-https URL.
 */
export function setProgressSyncUrlOverride(url: string) {
  const next = normalizeUrl(url)
  if (next && !isAllowedSyncUrl(next)) {
    throw new Error('Sync server must use https:// (http is only allowed for localhost)')
  }
  try {
    const baked = bakedSyncUrl()
    if (!next || next === baked) localStorage.removeItem(PROGRESS_SYNC_URL_KEY)
    else localStorage.setItem(PROGRESS_SYNC_URL_KEY, next)
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(PROGRESS_SYNC_EVENT))
  } catch {
    /* ignore */
  }
}

export function isProgressSyncConfigured(): boolean {
  return Boolean(progressSyncBaseUrl())
}
