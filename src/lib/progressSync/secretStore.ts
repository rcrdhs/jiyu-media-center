/**
 * Device token storage for progress sync.
 *  - Desktop (Electron): main-process file encrypted with safeStorage (electron/syncSecret.cjs).
 *  - Android: SyncSecret plugin, AES-GCM with an Android Keystore key.
 *  - Plain browser (dev only): localStorage fallback.
 * The token is cached in memory after the first load and never logged.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { PROGRESS_SYNC_TOKEN_FALLBACK_KEY } from './types'

interface SyncSecretPlugin {
  get(): Promise<{ token?: string | null; encrypted?: boolean }>
  set(options: { token: string }): Promise<{ ok: boolean; encrypted: boolean }>
  clear(): Promise<{ ok: boolean }>
}

const AndroidSyncSecret = registerPlugin<SyncSecretPlugin>('SyncSecret')

export type SecretStoreKind = 'electron' | 'android' | 'browser'

export function secretStoreKind(): SecretStoreKind {
  try {
    if (typeof window !== 'undefined' && window.signalDesktop?.syncSecretGet) return 'electron'
  } catch {
    /* ignore */
  }
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return 'android'
  } catch {
    /* ignore */
  }
  return 'browser'
}

let cached: string | null | undefined
let loading: Promise<string | null> | null = null

export function cachedSyncToken(): string | null {
  return cached ?? null
}

export async function loadSyncToken(): Promise<string | null> {
  if (cached !== undefined) return cached
  if (loading) return loading
  loading = (async () => {
    let token: string | null = null
    try {
      const kind = secretStoreKind()
      if (kind === 'electron') token = (await window.signalDesktop!.syncSecretGet!())?.token || null
      else if (kind === 'android') token = (await AndroidSyncSecret.get())?.token || null
      else token = localStorage.getItem(PROGRESS_SYNC_TOKEN_FALLBACK_KEY)
    } catch {
      token = null
    }
    cached = token && /^jys_/.test(token) ? token : null
    loading = null
    return cached
  })()
  return loading
}

export async function saveSyncToken(token: string): Promise<void> {
  const kind = secretStoreKind()
  if (kind === 'electron') {
    const res = await window.signalDesktop!.syncSecretSet!(token)
    if (!res?.ok) throw new Error('Could not store the sync sign-in securely')
  } else if (kind === 'android') {
    const res = await AndroidSyncSecret.set({ token })
    if (!res?.ok) throw new Error('Could not store the sync sign-in securely')
  } else {
    localStorage.setItem(PROGRESS_SYNC_TOKEN_FALLBACK_KEY, token)
  }
  cached = token
}

export async function clearSyncToken(): Promise<void> {
  cached = null
  try {
    const kind = secretStoreKind()
    if (kind === 'electron') await window.signalDesktop!.syncSecretClear!()
    else if (kind === 'android') await AndroidSyncSecret.clear()
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(PROGRESS_SYNC_TOKEN_FALLBACK_KEY)
  } catch {
    /* ignore */
  }
}
