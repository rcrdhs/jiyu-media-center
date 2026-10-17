/**
 * Sync endpoint for all Jiyu builds (Android WebView, Electron, future TV/Apple).
 *
 * Priority:
 *   1. Runtime override (Library → Sync server URL) — shared key on every build
 *   2. Build-time __JIYU_SYNC_URL__ / VITE_JIYU_SYNC_URL
 *
 * Local sandbox:
 *   npm run test:progress-sync
 *   set Sync server URL to http://127.0.0.1:8787 (or keep the sandbox server running)
 */

import { PROGRESS_SYNC_EVENT, PROGRESS_SYNC_URL_KEY } from './types'

declare const __JIYU_SYNC_URL__: string | undefined

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/$/, '')
}

function bakedSyncUrl(): string {
  try {
    const fromDefine =
      typeof __JIYU_SYNC_URL__ === 'string' ? normalizeUrl(__JIYU_SYNC_URL__) : ''
    if (fromDefine) return fromDefine
  } catch {
    /* ignore */
  }
  try {
    const fromEnv = normalizeUrl(String(import.meta.env?.VITE_JIYU_SYNC_URL || ''))
    if (fromEnv) return fromEnv
  } catch {
    /* ignore */
  }
  return ''
}

export function progressSyncBaseUrl(): string {
  try {
    const override = normalizeUrl(localStorage.getItem(PROGRESS_SYNC_URL_KEY) || '')
    if (override) return override
  } catch {
    /* ignore */
  }
  return bakedSyncUrl()
}

/** Persist a per-device sync host (empty clears override; baked URL still applies). */
export function setProgressSyncUrlOverride(url: string) {
  try {
    const next = normalizeUrl(url)
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
