import {
  PROGRESS_SYNC_EVENT,
  PROGRESS_SYNC_META_KEY,
  PROGRESS_SYNC_SESSION_KEY,
  type ProgressSyncSession,
  type ProgressSyncStatus,
} from './types'
import { isProgressSyncConfigured } from './config'

type SyncMeta = {
  lastPullAt?: number
  lastPushAt?: number
  lastError?: string | null
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

export function readProgressSyncSession(): ProgressSyncSession | null {
  const session = readJson<ProgressSyncSession>(PROGRESS_SYNC_SESSION_KEY)
  if (!session?.token || !session.userId) return null
  return session
}

export function writeProgressSyncSession(session: ProgressSyncSession | null) {
  try {
    if (!session) localStorage.removeItem(PROGRESS_SYNC_SESSION_KEY)
    else writeJson(PROGRESS_SYNC_SESSION_KEY, session)
  } catch {
    /* ignore */
  }
  emit()
}

export function readProgressSyncMeta(): SyncMeta {
  return readJson<SyncMeta>(PROGRESS_SYNC_META_KEY) || {}
}

export function patchProgressSyncMeta(patch: SyncMeta) {
  const next = { ...readProgressSyncMeta(), ...patch }
  writeJson(PROGRESS_SYNC_META_KEY, next)
  emit()
}

export function getProgressSyncStatus(): ProgressSyncStatus {
  const session = readProgressSyncSession()
  const meta = readProgressSyncMeta()
  return {
    configured: isProgressSyncConfigured(),
    signedIn: Boolean(session),
    userId: session?.userId ?? null,
    label: session?.label ?? null,
    pairCode: session?.pairCode ?? null,
    lastPullAt: meta.lastPullAt ?? null,
    lastPushAt: meta.lastPushAt ?? null,
    lastError: meta.lastError ?? null,
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
