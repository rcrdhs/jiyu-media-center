/**
 * Cross-device progress sync protocol.
 * Same contract for Android, desktop, future TV / Apple builds.
 * Backend can be the local sandbox, Supabase edge functions, or any host
 * that implements these routes.
 */

import type { CategoryId, StreamSourceKind, StreamTransport } from '../../types'

/** Wire format stored in the sync API / BaaS. */
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
  updatedAt: number
  torrentUri?: string
  detailUrl?: string
  playUrl?: string
  transport?: StreamTransport
  sourceKind?: StreamSourceKind
  source?: string
  /** Tombstone — device deleted Continue watching for this title. */
  deleted?: boolean
}

export type ProgressSyncSession = {
  token: string
  userId: string
  /** Short code other devices can enter to join this account. */
  pairCode?: string
  /** Display hint (email / “Device account”). */
  label?: string
}

export type ProgressSyncStatus = {
  configured: boolean
  signedIn: boolean
  userId: string | null
  label: string | null
  pairCode: string | null
  lastPullAt: number | null
  lastPushAt: number | null
  lastError: string | null
}

export const PROGRESS_SYNC_EVENT = 'jiyu:progress-sync'
export const PROGRESS_SYNC_SESSION_KEY = 'jiyu.sync.session.v1'
export const PROGRESS_SYNC_META_KEY = 'jiyu.sync.meta.v1'
/** Optional per-device override of the sync host (same key on every platform). */
export const PROGRESS_SYNC_URL_KEY = 'jiyu.sync.url.v1'

/** Ignore remote rows that are only slightly behind local (clock skew / pause jitter). */
export const PROGRESS_SYNC_EPSILON_SEC = 20
