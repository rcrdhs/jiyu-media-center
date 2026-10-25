import {
  PROGRESS_SYNC_EVENT,
  PROGRESS_SYNC_META_KEY,
  PROGRESS_SYNC_SESSION_KEY,
  PROGRESS_SYNC_STATE_KEY,
  type ProgressSyncSession,
  type ProgressSyncStatus,
} from './types'
import { isProgressSyncConfigured } from './config'

type SyncMeta = {
  lastPullAt?: number
  lastPushAt?: number
  lastError?: string | null
}

/** Persisted sync cursor + upload queue (survives restarts / offline). */
export type SyncState = {
  /** Highest server revision this device has applied. */
  lastRev: number
  /** Titles edited locally and not yet accepted by the server. */
  dirty: Record<string, true>
  /** Local deletions not yet accepted: id → { at: local ms, category }. */
  deletes: Record<string, { at: number; category: string }>
  /**
   * Fingerprint of what the server last accepted (or sent) per title. A dirty title whose
   * row still matches is dropped without a PUT (pause → minimise → close saves the same row).
   */
  pushed: Record<string, string>
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(PROGRESS_SYNC_EVENT))
  } catch {
    /* ignore */
  }
}

/** Raw session including a legacy plaintext token (only used for one-time migration). */
export function readRawProgressSyncSession(): ProgressSyncSession | null {
  const session = readJson<ProgressSyncSession>(PROGRESS_SYNC_SESSION_KEY)
  if (!session?.userId) return null
  return session
}

/** Signed-in session metadata (never contains the token). */
export function readProgressSyncSession(): ProgressSyncSession | null {
  const session = readRawProgressSyncSession()
  if (!session) return null
  const { token: _legacy, ...rest } = session
  return rest
}

export function writeProgressSyncSession(session: ProgressSyncSession | null) {
  try {
    if (!session) localStorage.removeItem(PROGRESS_SYNC_SESSION_KEY)
    else {
      const { token: _drop, ...rest } = session
      writeJson(PROGRESS_SYNC_SESSION_KEY, rest)
    }
  } catch {
    /* ignore */
  }
  emit()
}

export function patchProgressSyncSession(patch: Partial<ProgressSyncSession>) {
  const current = readProgressSyncSession()
  if (!current) return
  writeProgressSyncSession({ ...current, ...patch })
}

export function readProgressSyncMeta(): SyncMeta {
  return readJson<SyncMeta>(PROGRESS_SYNC_META_KEY) || {}
}

export function patchProgressSyncMeta(patch: SyncMeta) {
  const next = { ...readProgressSyncMeta(), ...patch }
  writeJson(PROGRESS_SYNC_META_KEY, next)
  emit()
}

export function readSyncState(): SyncState {
  const raw = readJson<Partial<SyncState>>(PROGRESS_SYNC_STATE_KEY) || {}
  return {
    lastRev: Number(raw.lastRev) || 0,
    dirty: raw.dirty && typeof raw.dirty === 'object' ? raw.dirty : {},
    deletes: raw.deletes && typeof raw.deletes === 'object' ? raw.deletes : {},
    pushed: raw.pushed && typeof raw.pushed === 'object' ? raw.pushed : {},
  }
}

export function writeSyncState(state: SyncState) {
  writeJson(PROGRESS_SYNC_STATE_KEY, state)
}

export function clearSyncState() {
  try {
    localStorage.removeItem(PROGRESS_SYNC_STATE_KEY)
  } catch {
    /* ignore */
  }
}

export function getProgressSyncStatus(): ProgressSyncStatus {
  const session = readProgressSyncSession()
  const meta = readProgressSyncMeta()
  const state = session ? readSyncState() : null
  const expires = Number(session?.pairCodeExpiresAt) || 0
  const pairLive = Boolean(session?.pairCode) && expires > Date.now()
  return {
    configured: isProgressSyncConfigured(),
    signedIn: Boolean(session),
    userId: session?.userId ?? null,
    deviceId: session?.deviceId ?? null,
    label: session?.label ?? null,
    pairCode: pairLive ? session!.pairCode! : null,
    pairCodeExpiresAt: pairLive ? expires : null,
    lastPullAt: meta.lastPullAt ?? null,
    lastPushAt: meta.lastPushAt ?? null,
    lastError: meta.lastError ?? null,
    pending: state ? Object.keys(state.dirty).length + Object.keys(state.deletes).length : 0,
  }
}

export function subscribeProgressSync(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(PROGRESS_SYNC_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(PROGRESS_SYNC_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}
