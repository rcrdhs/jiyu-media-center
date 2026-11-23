/**
 * Cross-device Continue watching + Saved sync (jiyu-sync Worker).
 * Same module on Android, desktop Electron, and future TV / Apple builds.
 *
 * Efficiency rules
 *  - Uploads only titles marked dirty (persisted queue in jiyu.sync.state.v1), never the whole list.
 *  - While playing: at most one upload every PLAY_PUSH_INTERVAL_MS. Pause / hide / close / PiP /
 *    end / delete push at once (fetch keepalive when the page is going away).
 *  - Pulls are incremental (`since=<server revision>`), at most one per PULL_MIN_INTERVAL_MS on
 *    foreground; failed uploads retry with backoff and survive restarts.
 *  - Conflicts are decided by the server clock: clients send how long ago they edited a row.
 */

import {
  applySyncedContinueEntries,
  FORCE_SAVE_CONTINUE_EVENT,
  listContinueWatching,
  type ContinueWatchingEntry,
} from '../continueWatching'
import {
  applySyncedWatchlistEntries,
  listWatchlistForSync,
  type WatchlistEntry,
} from '../watchlist'
import { continueEntryToSyncRecord, syncFingerprint, syncRecordToContinueEntry } from './bridge'
import { isProgressSyncConfigured } from './config'
import { clearSyncToken, loadSyncToken, saveSyncToken } from './secretStore'
import {
  clearSyncState,
  getProgressSyncStatus,
  patchProgressSyncMeta,
  patchProgressSyncSession,
  readProgressSyncMeta,
  readProgressSyncSession,
  readRawProgressSyncSession,
  readSyncState,
  writeProgressSyncSession,
  writeSyncState,
  type SyncState,
} from './session'
import {
  isRetryableSyncError,
  SyncHttpError,
  syncListDevices,
  syncNewPairCode,
  syncPair,
  syncPull,
  syncPullSaved,
  syncPush,
  syncPushSaved,
  syncRegister,
  syncRevokeDevice,
  syncSignOut,
  type SavedSyncPushRow,
  type SyncAuthResponse,
  type SyncPushRow,
} from './transport'
import type { ProgressSyncDevice, ProgressSyncRecord, SavedSyncRecord } from './types'

export type {
  ProgressSyncStatus,
  ProgressSyncSession,
  ProgressSyncRecord,
  ProgressSyncDevice,
  SavedSyncRecord,
} from './types'
export { PROGRESS_SYNC_EVENT } from './types'
export {
  defaultProgressSyncUrl,
  isAllowedSyncUrl,
  isProgressSyncConfigured,
  progressSyncBaseUrl,
  setProgressSyncUrlOverride,
} from './config'
export { getProgressSyncStatus, subscribeProgressSync, readProgressSyncSession } from './session'
export { secretStoreKind } from './secretStore'

const PLAY_PUSH_INTERVAL_MS = 45_000
const PULL_MIN_INTERVAL_MS = 60_000
const RETRY_STEPS_MS = [5_000, 15_000, 60_000, 300_000]
const MAX_ROWS_PER_PUT = 100

let pushTimer = 0
let retryTimer = 0
let retryStep = 0
let lastPushAttemptAt = 0
let flushing: Promise<void> | null = null
let flushAgain = false
let pullInFlight: Promise<void> | null = null

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function signedIn(): boolean {
  return isProgressSyncConfigured() && Boolean(readProgressSyncSession())
}

function pageHidden(): boolean {
  try {
    return document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

/** Local sign-out after the server says this token is gone (revoked elsewhere). */
async function dropLocalSession(message: string | null) {
  if (pushTimer) window.clearTimeout(pushTimer)
  if (retryTimer) window.clearTimeout(retryTimer)
  pushTimer = 0
  retryTimer = 0
  retryStep = 0
  await clearSyncToken()
  clearSyncState()
  writeProgressSyncSession(null)
  patchProgressSyncMeta({ lastError: message })
}

async function requireToken(): Promise<string | null> {
  if (!signedIn()) return null
  const token = await loadSyncToken()
  if (!token) {
    await dropLocalSession('Sync sign-in is missing on this device — link it again')
    return null
  }
  return token
}

async function handleSyncError(err: unknown) {
  if (err instanceof SyncHttpError && err.status === 401) {
    await dropLocalSession('This device was removed from sync — create an account or pair again')
    return
  }
  patchProgressSyncMeta({ lastError: errorText(err) })
}

function scheduleRetry() {
  if (retryTimer) return
  const delay = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)]
  retryStep += 1
  retryTimer = window.setTimeout(() => {
    retryTimer = 0
    void flushProgressSyncPush()
  }, delay)
}

function hasPending(state: SyncState): boolean {
  return (
    Object.keys(state.dirty).length > 0 ||
    Object.keys(state.deletes).length > 0 ||
    Object.keys(state.savedDirty).length > 0 ||
    Object.keys(state.savedDeletes).length > 0
  )
}

function isVodCategory(
  category: string | undefined,
): category is ProgressSyncRecord['category'] {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
}

function watchlistToSavedRecord(entry: WatchlistEntry): SavedSyncRecord | null {
  if (!entry?.id || !isVodCategory(entry.category)) return null
  const title = String(entry.title || '').trim()
  const href = String(entry.href || '').trim()
  if (!title || !href) return null
  return {
    id: entry.id,
    title,
    poster: entry.poster,
    category: entry.category,
    href,
    updatedAt: Number(entry.savedAt) || Date.now(),
  }
}

function savedFingerprint(record: SavedSyncRecord | null | undefined): string {
  if (!record?.id) return ''
  return JSON.stringify([
    record.title,
    record.poster ?? null,
    record.category,
    record.href,
    record.deleted ? 1 : 0,
  ])
}

function savedRecordToWatchlist(record: SavedSyncRecord): WatchlistEntry | null {
  if (!record?.id || record.deleted || !isVodCategory(record.category)) return null
  const title = String(record.title || '').trim()
  const href = String(record.href || '').trim()
  if (!title || !href) return null
  return {
    id: record.id,
    title,
    poster: record.poster,
    category: record.category,
    href,
    savedAt: Number(record.updatedAt) || Date.now(),
  }
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/**
 * Merge server rows into local Continue watching.
 * `serverNow` converts server timestamps to this device's clock.
 */
function applyRemoteRows(rows: ProgressSyncRecord[], serverNow: number) {
  if (rows.length === 0) return
  const skew = Date.now() - serverNow
  const state = readSyncState()
  const local = new Map(listContinueWatching().map((entry) => [entry.id, entry]))
  let changed = false
  let stateChanged = false
  for (const row of rows) {
    if (!row?.id) continue
    // Our own delete is still queued — the server will accept it or send its newer row back.
    if (state.deletes[row.id]) continue
    const localUpdatedAt = Number(row.updatedAt) + skew
    const mine = local.get(row.id)
    if (state.dirty[row.id] && mine && mine.updatedAt >= localUpdatedAt) continue
    if (state.dirty[row.id]) {
      delete state.dirty[row.id]
      stateChanged = true
    }
    if (row.deleted) {
      if (state.pushed[row.id]) {
        delete state.pushed[row.id]
        stateChanged = true
      }
      if (mine) {
        local.delete(row.id)
        changed = true
      }
      continue
    }
    const incoming = syncRecordToContinueEntry({ ...row, updatedAt: localUpdatedAt })
    if (!incoming) continue
    // The server now holds this row: a later local save of the same values needs no upload.
    const fingerprint = syncFingerprint(continueEntryToSyncRecord(incoming))
    if (fingerprint && state.pushed[row.id] !== fingerprint) {
      state.pushed[row.id] = fingerprint
      stateChanged = true
    }
    // Echo of what this device already has (e.g. our own upload) — skip the rewrite.
    if (
      mine &&
      mine.playlistIndex === incoming.playlistIndex &&
      Math.abs(mine.currentTime - incoming.currentTime) < 1 &&
      (mine.duration || 0) === (incoming.duration || 0)
    ) {
      continue
    }
    local.set(row.id, { ...(mine || {}), ...definedOnly(incoming) } as ContinueWatchingEntry)
    changed = true
  }
  if (stateChanged) writeSyncState(state)
  if (changed) applySyncedContinueEntries([...local.values()])
}

function applyRemoteSavedRows(rows: SavedSyncRecord[], serverNow: number) {
  if (rows.length === 0) return
  const skew = Date.now() - serverNow
  const state = readSyncState()
  const local = new Map(listWatchlistForSync().map((entry) => [entry.id, entry]))
  let changed = false
  let stateChanged = false
  for (const row of rows) {
    if (!row?.id) continue
    if (state.savedDeletes[row.id]) continue
    const localUpdatedAt = Number(row.updatedAt) + skew
    const mine = local.get(row.id)
    if (state.savedDirty[row.id] && mine && mine.savedAt >= localUpdatedAt) continue
    if (state.savedDirty[row.id]) {
      delete state.savedDirty[row.id]
      stateChanged = true
    }
    if (row.deleted) {
      if (state.savedPushed[row.id]) {
        delete state.savedPushed[row.id]
        stateChanged = true
      }
      if (mine) {
        local.delete(row.id)
        changed = true
      }
      continue
    }
    const incoming = savedRecordToWatchlist({ ...row, updatedAt: localUpdatedAt })
    if (!incoming) continue
    const fingerprint = savedFingerprint(watchlistToSavedRecord(incoming))
    if (fingerprint && state.savedPushed[row.id] !== fingerprint) {
      state.savedPushed[row.id] = fingerprint
      stateChanged = true
    }
    if (
      mine &&
      mine.href === incoming.href &&
      mine.title === incoming.title &&
      (mine.poster || '') === (incoming.poster || '') &&
      mine.category === incoming.category
    ) {
      continue
    }
    local.set(row.id, incoming)
    changed = true
  }
  if (stateChanged) writeSyncState(state)
  if (changed) applySyncedWatchlistEntries([...local.values()])
}

function buildPushRows(state: SyncState) {
  const now = Date.now()
  const local = new Map(listContinueWatching().map((entry) => [entry.id, entry]))
  const rows: SyncPushRow[] = []
  /** id → local updatedAt (upsert) or delete time, to detect edits made while uploading. */
  const snapshot = new Map<string, { kind: 'up' | 'del'; at: number; fingerprint?: string }>()
  let pruned = false
  // Forget fingerprints of titles no longer in Continue watching (keeps the state small).
  for (const id of Object.keys(state.pushed)) {
    if (!local.has(id)) {
      delete state.pushed[id]
      pruned = true
    }
  }
  for (const id of Object.keys(state.dirty)) {
    const entry = local.get(id)
    const record = entry ? continueEntryToSyncRecord(entry) : null
    if (!entry || !record) {
      delete state.dirty[id]
      pruned = true
      continue
    }
    const fingerprint = syncFingerprint(record)
    if (fingerprint && state.pushed[id] === fingerprint) {
      // Same row the server already has (only the local save time moved) — skip the PUT.
      delete state.dirty[id]
      pruned = true
      continue
    }
    const { updatedAt: _u, rev: _r, deleted: _d, ...rest } = record
    rows.push({ ...rest, ageMs: Math.max(0, now - (entry.updatedAt || now)) })
    snapshot.set(id, { kind: 'up', at: entry.updatedAt, fingerprint })
  }
  for (const [id, del] of Object.entries(state.deletes)) {
    rows.push({
      id,
      title: id,
      category: (del.category || 'movies') as ProgressSyncRecord['category'],
      playlistIndex: 0,
      currentTime: 0,
      duration: 0,
      deleted: true,
      ageMs: Math.max(0, now - (Number(del.at) || now)),
    })
    snapshot.set(id, { kind: 'del', at: del.at })
  }
  if (pruned) writeSyncState(state)
  return { rows, snapshot }
}

function buildSavedPushRows(state: SyncState) {
  const now = Date.now()
  const local = new Map(listWatchlistForSync().map((entry) => [entry.id, entry]))
  const rows: SavedSyncPushRow[] = []
  const snapshot = new Map<string, { kind: 'up' | 'del'; at: number; fingerprint?: string }>()
  let pruned = false
  for (const id of Object.keys(state.savedPushed)) {
    if (!local.has(id)) {
      delete state.savedPushed[id]
      pruned = true
    }
  }
  for (const id of Object.keys(state.savedDirty)) {
    const entry = local.get(id)
    const record = entry ? watchlistToSavedRecord(entry) : null
    if (!entry || !record) {
      delete state.savedDirty[id]
      pruned = true
      continue
    }
    const fingerprint = savedFingerprint(record)
    if (fingerprint && state.savedPushed[id] === fingerprint) {
      delete state.savedDirty[id]
      pruned = true
      continue
    }
    const { updatedAt: _u, rev: _r, deleted: _d, ...rest } = record
    rows.push({ ...rest, ageMs: Math.max(0, now - (entry.savedAt || now)) })
    snapshot.set(id, { kind: 'up', at: entry.savedAt, fingerprint })
  }
  for (const [id, del] of Object.entries(state.savedDeletes)) {
    rows.push({
      id,
      title: id,
      category: (del.category || 'movies') as SavedSyncRecord['category'],
      href: `/watch/${id}`,
      deleted: true,
      ageMs: Math.max(0, now - (Number(del.at) || now)),
    })
    snapshot.set(id, { kind: 'del', at: del.at })
  }
  if (pruned) writeSyncState(state)
  return { rows, snapshot }
}

async function flushOnce(options?: { keepalive?: boolean }) {
  const token = await requireToken()
  if (!token) return
  const state0 = readSyncState()
  const progress = buildPushRows(state0)
  const saved = buildSavedPushRows(readSyncState())
  if (progress.rows.length === 0 && saved.rows.length === 0) return
  lastPushAttemptAt = Date.now()
  try {
    for (let i = 0; i < progress.rows.length; i += MAX_ROWS_PER_PUT) {
      const chunk = progress.rows.slice(i, i + MAX_ROWS_PER_PUT)
      const res = await syncPush(token, chunk, {
        keepalive: options?.keepalive && progress.rows.length + saved.rows.length <= 40,
      })
      // Re-read: the player may have marked more rows while we were uploading.
      const state = readSyncState()
      const local = new Map(listContinueWatching().map((entry) => [entry.id, entry]))
      const rejected: ProgressSyncRecord[] = []
      for (const result of res.results) {
        const snap = progress.snapshot.get(result.id)
        if (!snap) continue
        if (snap.kind === 'del') {
          if (state.deletes[result.id]?.at === snap.at) delete state.deletes[result.id]
          if (result.accepted) delete state.pushed[result.id]
        } else {
          if (local.get(result.id)?.updatedAt === snap.at || !local.has(result.id)) {
            delete state.dirty[result.id]
          }
          if (result.accepted && snap.fingerprint) state.pushed[result.id] = snap.fingerprint
        }
        if (!result.accepted && result.current) {
          delete state.dirty[result.id]
          delete state.deletes[result.id]
          rejected.push(result.current)
        }
      }
      writeSyncState(state)
      // Another device edited these more recently — take the server's copy.
      if (rejected.length > 0) applyRemoteRows(rejected, res.now)
    }
    try {
      for (let i = 0; i < saved.rows.length; i += MAX_ROWS_PER_PUT) {
        const chunk = saved.rows.slice(i, i + MAX_ROWS_PER_PUT)
        const res = await syncPushSaved(token, chunk, {
          keepalive: options?.keepalive && progress.rows.length + saved.rows.length <= 40,
        })
        const state = readSyncState()
        const local = new Map(listWatchlistForSync().map((entry) => [entry.id, entry]))
        const rejected: SavedSyncRecord[] = []
        for (const result of res.results) {
          const snap = saved.snapshot.get(result.id)
          if (!snap) continue
          if (snap.kind === 'del') {
            if (state.savedDeletes[result.id]?.at === snap.at) delete state.savedDeletes[result.id]
            if (result.accepted) delete state.savedPushed[result.id]
          } else {
            if (local.get(result.id)?.savedAt === snap.at || !local.has(result.id)) {
              delete state.savedDirty[result.id]
            }
            if (result.accepted && snap.fingerprint) state.savedPushed[result.id] = snap.fingerprint
          }
          if (!result.accepted && result.current) {
            delete state.savedDirty[result.id]
            delete state.savedDeletes[result.id]
            rejected.push(result.current)
          }
        }
        writeSyncState(state)
        if (rejected.length > 0) applyRemoteSavedRows(rejected, res.now)
      }
    } catch (savedErr) {
      // Older jiyu-sync builds have no /v1/saved — keep Continue watching working.
      if (!(savedErr instanceof SyncHttpError && savedErr.status === 404)) throw savedErr
    }
    retryStep = 0
    patchProgressSyncMeta({ lastPushAt: Date.now(), lastError: null })
  } catch (err) {
    await handleSyncError(err)
    if (isRetryableSyncError(err) && signedIn()) scheduleRetry()
  }
}

/** Upload every queued change now (coalesces concurrent callers). */
export async function flushProgressSyncPush(options?: { keepalive?: boolean }): Promise<void> {
  if (!signedIn()) return
  if (pushTimer) {
    window.clearTimeout(pushTimer)
    pushTimer = 0
  }
  if (retryTimer) {
    window.clearTimeout(retryTimer)
    retryTimer = 0
  }
  if (flushing) {
    flushAgain = true
    return flushing
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false
        await flushOnce(options)
      } while (flushAgain)
    } finally {
      flushing = null
    }
  })()
  return flushing
}

function schedulePush(urgent: boolean) {
  if (urgent) {
    // Let the player finish its own save first (same pause / hide event).
    window.setTimeout(() => void flushProgressSyncPush({ keepalive: pageHidden() }), 0)
    return
  }
  if (pushTimer || retryTimer || flushing) return
  const wait = Math.max(2_000, lastPushAttemptAt + PLAY_PUSH_INTERVAL_MS - Date.now())
  pushTimer = window.setTimeout(() => {
    pushTimer = 0
    void flushProgressSyncPush()
  }, wait)
}

/** Mark a local Continue row for upload (no-op when signed out). */
export function queueProgressSyncPush(entry: ContinueWatchingEntry, options?: { urgent?: boolean }) {
  if (!signedIn()) return
  if (!continueEntryToSyncRecord(entry)) return
  const state = readSyncState()
  // Only touch storage when the queue actually changes (not on every progress save).
  if (!state.dirty[entry.id] || state.deletes[entry.id]) {
    state.dirty[entry.id] = true
    delete state.deletes[entry.id]
    writeSyncState(state)
  }
  schedulePush(Boolean(options?.urgent))
}

/** Queue removals (one batched PUT for any number of titles). */
export function queueProgressSyncDeletes(rows: { id: string; category?: string }[]) {
  if (!signedIn() || rows.length === 0) return
  const state = readSyncState()
  const at = Date.now()
  for (const row of rows) {
    if (!row?.id) continue
    delete state.dirty[row.id]
    state.deletes[row.id] = { at, category: row.category || 'movies' }
  }
  writeSyncState(state)
  schedulePush(true)
}

/** Mark one title removed and sync the tombstone. */
export function queueProgressSyncDelete(id: string, category?: string) {
  queueProgressSyncDeletes([{ id, category }])
}

/** Mark a local Saved row for upload (no-op when signed out). */
export function queueSavedSyncPush(entry: WatchlistEntry, options?: { urgent?: boolean }) {
  if (!signedIn()) return
  if (!watchlistToSavedRecord(entry)) return
  const state = readSyncState()
  if (!state.savedDirty[entry.id] || state.savedDeletes[entry.id]) {
    state.savedDirty[entry.id] = true
    delete state.savedDeletes[entry.id]
    writeSyncState(state)
  }
  schedulePush(Boolean(options?.urgent))
}

/**
 * Re-queue hearts that never reached the server (e.g. /v1/saved was 404).
 * Safe to call on every launch — skips rows the server already accepted.
 */
function queueUnsyncedLocalSaved(): boolean {
  if (!signedIn()) return false
  const state = readSyncState()
  let changed = false
  for (const entry of listWatchlistForSync()) {
    const record = watchlistToSavedRecord(entry)
    if (!record) continue
    const fingerprint = savedFingerprint(record)
    if (fingerprint && state.savedPushed[entry.id] === fingerprint) continue
    if (!state.savedDirty[entry.id]) {
      state.savedDirty[entry.id] = true
      changed = true
    }
    if (state.savedDeletes[entry.id]) {
      delete state.savedDeletes[entry.id]
      changed = true
    }
  }
  if (changed) writeSyncState(state)
  return changed
}

/** Queue a Saved removal tombstone. */
export function queueSavedSyncDelete(id: string, category?: string) {
  if (!signedIn() || !id) return
  const state = readSyncState()
  delete state.savedDirty[id]
  state.savedDeletes[id] = { at: Date.now(), category: category || 'movies' }
  writeSyncState(state)
  schedulePush(true)
}

/**
 * Pull rows changed since the last applied server revision.
 * `force` skips the 60 s foreground throttle; `pushLocal` uploads queued changes first.
 */
export async function pullProgressSync(options?: { pushLocal?: boolean; force?: boolean }): Promise<void> {
  if (!signedIn()) return
  if (pullInFlight) return pullInFlight
  if (!options?.force && !options?.pushLocal) {
    const last = readProgressSyncMeta().lastPullAt || 0
    if (Date.now() - last < PULL_MIN_INTERVAL_MS) return
  }

  pullInFlight = (async () => {
    try {
      if (options?.pushLocal) await flushProgressSyncPush()
      const token = await requireToken()
      if (!token) return
      let since = readSyncState().lastRev
      let res = await syncPull(token, since)
      if (res.rev < since) {
        // Server history is behind our cursor (account recreated) — start over.
        since = 0
        res = await syncPull(token, 0)
      }
      applyRemoteRows(res.entries, res.now)

      let savedRev = readSyncState().savedLastRev
      try {
        let savedSince = savedRev
        let savedRes = await syncPullSaved(token, savedSince)
        if (savedRes.rev < savedSince) {
          savedSince = 0
          savedRes = await syncPullSaved(token, 0)
        }
        applyRemoteSavedRows(savedRes.entries, savedRes.now)
        savedRev = savedRes.rev
      } catch (savedErr) {
        if (!(savedErr instanceof SyncHttpError && savedErr.status === 404)) throw savedErr
      }

      const state = readSyncState()
      state.lastRev = res.rev
      state.savedLastRev = savedRev
      writeSyncState(state)
      patchProgressSyncMeta({ lastPullAt: Date.now(), lastError: null })
    } catch (err) {
      await handleSyncError(err)
    } finally {
      pullInFlight = null
    }
  })()

  return pullInFlight
}

/** Manual "Sync now": upload queued changes, then pull. */
export function syncProgressNow(): Promise<void> {
  queueUnsyncedLocalSaved()
  return pullProgressSync({ pushLocal: true, force: true })
}

async function adoptAuth(auth: SyncAuthResponse) {
  if (!auth?.token || !auth.userId) throw new Error('Sync server returned an invalid sign-in')
  await saveSyncToken(auth.token)
  writeProgressSyncSession({
    userId: auth.userId,
    deviceId: auth.deviceId,
    label: auth.label,
    pairCode: auth.pairCode,
    pairCodeExpiresAt: auth.pairCodeExpiresAt,
  })
  // First sign-in on this device: offer every local title + Saved once; server ages decide conflicts.
  const dirty: Record<string, true> = {}
  for (const entry of listContinueWatching()) if (continueEntryToSyncRecord(entry)) dirty[entry.id] = true
  const savedDirty: Record<string, true> = {}
  for (const entry of listWatchlistForSync()) if (watchlistToSavedRecord(entry)) savedDirty[entry.id] = true
  writeSyncState({
    lastRev: 0,
    dirty,
    deletes: {},
    pushed: {},
    savedLastRev: 0,
    savedDirty,
    savedDeletes: {},
    savedPushed: {},
  })
  patchProgressSyncMeta({ lastError: null, lastPullAt: 0, lastPushAt: 0 })
  await syncProgressNow()
}

export async function createProgressSyncAccount(label?: string): Promise<void> {
  await adoptAuth(await syncRegister((label || '').trim() || 'Jiyu device'))
}

export async function pairProgressSyncDevice(code: string, label?: string): Promise<void> {
  await adoptAuth(await syncPair(code, (label || '').trim() || 'Jiyu device'))
}

/** Fresh single-use pair code (10 minutes) for linking another device. */
export async function newProgressSyncPairCode(): Promise<void> {
  const token = await requireToken()
  if (!token) throw new Error('Not signed in')
  try {
    const res = await syncNewPairCode(token)
    patchProgressSyncSession({ pairCode: res.pairCode, pairCodeExpiresAt: res.pairCodeExpiresAt })
  } catch (err) {
    await handleSyncError(err)
    throw err
  }
}

export async function listProgressSyncDevices(): Promise<ProgressSyncDevice[]> {
  const token = await requireToken()
  if (!token) return []
  try {
    return await syncListDevices(token)
  } catch (err) {
    await handleSyncError(err)
    throw err
  }
}

/** Revoke a device. Removing this device signs it out locally too. */
export async function removeProgressSyncDevice(deviceId: string): Promise<void> {
  const token = await requireToken()
  if (!token) return
  try {
    const res = await syncRevokeDevice(token, deviceId)
    if (res?.self || deviceId === readProgressSyncSession()?.deviceId) await dropLocalSession(null)
  } catch (err) {
    await handleSyncError(err)
    throw err
  }
}

/** Sign this device out (revokes its token on the server; local progress is kept). */
export async function signOutProgressSync(): Promise<void> {
  const token = await loadSyncToken()
  if (token && isProgressSyncConfigured()) {
    try {
      await flushProgressSyncPush()
      await syncSignOut(token)
    } catch {
      /* offline — the token is still removed from this device */
    }
  }
  await dropLocalSession(null)
}

/** Move a legacy plaintext token out of localStorage into the secure store. */
async function migrateLegacySession() {
  const raw = readRawProgressSyncSession()
  if (!raw?.token) return
  if (/^jys_[A-Za-z0-9_-]{40,128}$/.test(raw.token)) {
    try {
      await saveSyncToken(raw.token)
      writeProgressSyncSession(raw)
      return
    } catch {
      /* fall through */
    }
  }
  // Old sandbox-format tokens can't talk to jiyu-sync — sign out locally.
  writeProgressSyncSession(null)
  clearSyncState()
}

/** Bootstrap hook — safe to call from App on every launch (all platforms). */
export function startProgressSync(): () => void {
  let disposed = false
  const urgentFlush = () => {
    if (signedIn()) window.setTimeout(() => void flushProgressSyncPush({ keepalive: pageHidden() }), 0)
  }
  const onVisible = () => {
    if (!signedIn()) return
    if (document.visibilityState === 'hidden') urgentFlush()
    else void pullProgressSync()
  }
  const onOnline = () => {
    if (signedIn()) void pullProgressSync({ pushLocal: true, force: true })
  }

  void (async () => {
    await migrateLegacySession()
    if (disposed || !signedIn()) return
    await loadSyncToken()
    if (disposed) return
    // Hearts that never uploaded (Saved API was missing) get another try.
    queueUnsyncedLocalSaved()
    // Launch: upload only what changed while closed/offline, then an incremental pull.
    await pullProgressSync({ pushLocal: hasPending(readSyncState()), force: true })
  })()

  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  window.addEventListener('pagehide', urgentFlush)
  window.addEventListener(FORCE_SAVE_CONTINUE_EVENT, urgentFlush)

  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pagehide', urgentFlush)
    window.removeEventListener(FORCE_SAVE_CONTINUE_EVENT, urgentFlush)
    if (pushTimer) window.clearTimeout(pushTimer)
    pushTimer = 0
  }
}

export { getProgressSyncStatus as progressSyncStatus }
