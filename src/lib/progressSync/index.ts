/**
 * Cross-device Continue watching sync.
 * Same module on Android, desktop Electron, and future TV / Apple builds.
 */

import {
  applySyncedContinueEntries,
  FORCE_SAVE_CONTINUE_EVENT,
  listContinueWatching,
  type ContinueWatchingEntry,
} from '../continueWatching'
import { continueEntryToSyncRecord, syncRecordToContinueEntry } from './bridge'
import { isProgressSyncConfigured } from './config'
import { mergeProgressRecords } from './merge'
import {
  getProgressSyncStatus,
  patchProgressSyncMeta,
  readProgressSyncSession,
  writeProgressSyncSession,
} from './session'
import { syncDelete, syncPair, syncPull, syncPush, syncRegister } from './transport'
import type { ProgressSyncRecord } from './types'

export type { ProgressSyncStatus, ProgressSyncSession, ProgressSyncRecord } from './types'
export { PROGRESS_SYNC_EVENT } from './types'
export {
  isProgressSyncConfigured,
  progressSyncBaseUrl,
  setProgressSyncUrlOverride,
} from './config'
export {
  getProgressSyncStatus,
  subscribeProgressSync,
  readProgressSyncSession,
} from './session'

let pushTimer = 0
let pullInFlight: Promise<void> | null = null
const pendingPush = new Map<string, ProgressSyncRecord>()

function localAsSyncRecords(): ProgressSyncRecord[] {
  return listContinueWatching()
    .map((entry) => continueEntryToSyncRecord(entry))
    .filter((row): row is ProgressSyncRecord => Boolean(row))
}

export async function createProgressSyncAccount(label?: string): Promise<void> {
  const session = await syncRegister(label)
  writeProgressSyncSession(session)
  patchProgressSyncMeta({ lastError: null })
  await pullProgressSync({ pushLocal: true })
}

export async function pairProgressSyncDevice(code: string): Promise<void> {
  const session = await syncPair(code)
  writeProgressSyncSession(session)
  patchProgressSyncMeta({ lastError: null })
  await pullProgressSync({ pushLocal: true })
}

export function signOutProgressSync() {
  writeProgressSyncSession(null)
  pendingPush.clear()
  if (pushTimer) {
    window.clearTimeout(pushTimer)
    pushTimer = 0
  }
  patchProgressSyncMeta({ lastError: null })
}

/** Queue a local continue row for cloud upload (no-op when signed out). */
export function queueProgressSyncPush(entry: ContinueWatchingEntry) {
  if (!isProgressSyncConfigured()) return
  const session = readProgressSyncSession()
  if (!session) return
  const record = continueEntryToSyncRecord(entry)
  if (!record) return
  pendingPush.set(record.id, record)
  if (pushTimer) window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => {
    pushTimer = 0
    void flushProgressSyncPush()
  }, 12_000)
}

/** Immediately push pending rows + optional explicit records. */
export async function flushProgressSyncPush(
  extra: ProgressSyncRecord[] = [],
): Promise<void> {
  if (!isProgressSyncConfigured()) return
  const session = readProgressSyncSession()
  if (!session) return

  for (const row of extra) pendingPush.set(row.id, row)
  const entries = [...pendingPush.values()]
  if (entries.length === 0) return

  try {
    await syncPush(session.token, entries)
    pendingPush.clear()
    patchProgressSyncMeta({ lastPushAt: Date.now(), lastError: null })
  } catch (err) {
    patchProgressSyncMeta({
      lastError: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Mark a title removed and sync the tombstone. */
export function queueProgressSyncDelete(id: string) {
  if (!isProgressSyncConfigured()) return
  const session = readProgressSyncSession()
  if (!session) return
  const existing = listContinueWatching().find((row) => row.id === id)
  const record =
    continueEntryToSyncRecord(
      existing || {
        id,
        title: id,
        category: 'movies',
        playlistIndex: 0,
        currentTime: 0,
        duration: 0,
        updatedAt: Date.now(),
      },
      { deleted: true },
    ) || null
  if (!record) return
  record.deleted = true
  record.updatedAt = Date.now()
  pendingPush.set(record.id, record)
  void flushProgressSyncPush().catch(() => undefined)
  void syncDelete(session.token, id).catch(() => undefined)
}

/**
 * Pull remote progress and merge into local Continue watching.
 * Used on sign-in, app start, and resume.
 */
export async function pullProgressSync(options?: {
  pushLocal?: boolean
}): Promise<void> {
  if (!isProgressSyncConfigured()) return
  const session = readProgressSyncSession()
  if (!session) return
  if (pullInFlight) return pullInFlight

  pullInFlight = (async () => {
    try {
      if (options?.pushLocal) {
        await flushProgressSyncPush(localAsSyncRecords())
      }
      const remote = await syncPull(session.token)
      const local = localAsSyncRecords()
      const merged = mergeProgressRecords(local, remote)
      const nextLocal = merged
        .map((row) => syncRecordToContinueEntry(row))
        .filter((row): row is ContinueWatchingEntry => Boolean(row))
      applySyncedContinueEntries(nextLocal)
      patchProgressSyncMeta({ lastPullAt: Date.now(), lastError: null })
    } catch (err) {
      patchProgressSyncMeta({
        lastError: err instanceof Error ? err.message : String(err),
      })
    } finally {
      pullInFlight = null
    }
  })()

  return pullInFlight
}

/** Bootstrap hook — safe to call from App on every launch (all platforms). */
export function startProgressSync(): () => void {
  const onVisible = () => {
    if (
      document.visibilityState === 'visible' &&
      isProgressSyncConfigured() &&
      readProgressSyncSession()
    ) {
      void pullProgressSync()
    }
  }
  const onOnline = () => {
    if (isProgressSyncConfigured() && readProgressSyncSession()) {
      void flushProgressSyncPush()
      void pullProgressSync()
    }
  }
  const onForceSave = () => {
    if (isProgressSyncConfigured() && readProgressSyncSession()) {
      void flushProgressSyncPush()
    }
  }

  if (isProgressSyncConfigured() && readProgressSyncSession()) {
    void pullProgressSync({ pushLocal: true })
  }

  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  window.addEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', onOnline)
    window.removeEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
    if (pushTimer) window.clearTimeout(pushTimer)
  }
}

export { getProgressSyncStatus as progressSyncStatus }
