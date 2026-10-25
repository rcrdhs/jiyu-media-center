/**
 * Cross-device progress sync protocol (jiyu-sync Worker, workers/jiyu-sync).
 * Same contract for Android, desktop, future TV / Apple builds.
 */

import type { CategoryId, StreamSourceKind, StreamTransport } from '../../types'

/** Wire format stored in the sync API. */
export type ProgressSyncRecord = {
  id: string
  title: string
  poster?: string
  category: CategoryId
  playlistIndex: number
  episodeTitle?: string
  currentTime: number
  duration: number
  runtimeSeconds?: number
  /** Local clock when building a push; server clock on rows returned by the API. */
  updatedAt: number
  torrentUri?: string
  detailUrl?: string
  playUrl?: string
  transport?: StreamTransport
  sourceKind?: StreamSourceKind
  source?: string
  /** Tombstone — device deleted Continue watching for this title. */
  deleted?: boolean
  /** Server revision (pull responses only). */
  rev?: number
}

/** Non-secret session metadata (localStorage). The device token lives in secretStore. */
export type ProgressSyncSession = {
  userId: string
  deviceId?: string
  label?: string
  /** Last pair code this device issued, and when it stops working. */
  pairCode?: string
  pairCodeExpiresAt?: number
  /** Legacy (pre-1.0 sandbox) sessions kept the token here; migrated on start. */
  token?: string
}

export type ProgressSyncDevice = {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
  current: boolean
}

export type ProgressSyncStatus = {
  configured: boolean
  signedIn: boolean
  userId: string | null
  deviceId: string | null
  label: string | null
  pairCode: string | null
  pairCodeExpiresAt: number | null
  lastPullAt: number | null
  lastPushAt: number | null
  lastError: string | null
  /** Rows waiting to upload (persisted across restarts). */
  pending: number
}

export const PROGRESS_SYNC_EVENT = 'jiyu:progress-sync'
export const PROGRESS_SYNC_SESSION_KEY = 'jiyu.sync.session.v1'
export const PROGRESS_SYNC_META_KEY = 'jiyu.sync.meta.v1'
/** Persisted sync cursor + pending upload queue. */
export const PROGRESS_SYNC_STATE_KEY = 'jiyu.sync.state.v1'
/** Plain-browser fallback only (no Electron / Android secure store). */
export const PROGRESS_SYNC_TOKEN_FALLBACK_KEY = 'jiyu.sync.token.v1'
/** Optional per-device override of the sync host (same key on every platform). */
export const PROGRESS_SYNC_URL_KEY = 'jiyu.sync.url.v1'

/** Ignore remote rows that are only slightly behind local (clock skew / pause jitter). */
export const PROGRESS_SYNC_EPSILON_SEC = 20
