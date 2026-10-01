/**
 * Pause / resume / cancel for background catalog sync.
 * Checked between pages (and similar yield points) so in-flight fetches finish
 * first — cancel never mid-wipe of IndexedDB.
 */

import { clearSyncJob, holdBackgroundSync, releaseBackgroundSync } from './backgroundSync'

type Listener = () => void

export type TorrentSyncControlState = {
  /** True while a sync session owns the controller */
  active: boolean
  paused: boolean
  cancelling: boolean
}

export class TorrentSyncCancelledError extends Error {
  constructor(message = 'Catalog sync cancelled') {
    super(message)
    this.name = 'TorrentSyncCancelledError'
  }
}

/** Another sync took the session — not a user cancel; callers should stay quiet. */
export class TorrentSyncSupersededError extends Error {
  constructor(message = 'Catalog sync superseded') {
    super(message)
    this.name = 'TorrentSyncSupersededError'
  }
}

let sessionId = 0
let pauseWaiters: Array<() => void> = []
const listeners = new Set<Listener>()

/** Serialize catalog syncs so auto-refresh cannot cancel an in-flight run. */
let syncQueueTail: Promise<unknown> = Promise.resolve()
/** Bumped on user cancel so queued auto-syncs after Cancel are dropped. */
let syncQueueEpoch = 0

/** Stable snapshot for useSyncExternalStore — never return a fresh object each read. */
let state: TorrentSyncControlState = {
  active: false,
  paused: false,
  cancelling: false,
}

function emit() {
  for (const listener of listeners) listener()
}

function notifyDesktopTmdbControl(action: 'pause' | 'resume' | 'cancel' | 'reset'): void {
  try {
    void window.signalDesktop?.tmdbSyncControl?.(action)
  } catch {
    /* browser / no desktop bridge */
  }
}

function setState(next: TorrentSyncControlState): void {
  if (
    state.active === next.active &&
    state.paused === next.paused &&
    state.cancelling === next.cancelling
  ) {
    return
  }
  state = next
  emit()
}

function wakePauseWaiters() {
  const waiters = pauseWaiters
  pauseWaiters = []
  for (const wake of waiters) wake()
}

export function getTorrentSyncControlState(): TorrentSyncControlState {
  return state
}

export function subscribeTorrentSyncControl(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Start (or take over) a sync session. Returns the session id for checkpoints. */
export function beginTorrentSyncSession(): number {
  sessionId += 1
  wakePauseWaiters()
  notifyDesktopTmdbControl('reset')
  holdBackgroundSync()
  setState({ active: true, paused: false, cancelling: false })
  return sessionId
}

export function endTorrentSyncSession(id: number): void {
  if (id !== sessionId) return
  wakePauseWaiters()
  notifyDesktopTmdbControl('reset')
  releaseBackgroundSync()
  setState({ active: false, paused: false, cancelling: false })
}

export function pauseTorrentSync(): void {
  if (!state.active || state.cancelling || state.paused) return
  notifyDesktopTmdbControl('pause')
  setState({ ...state, paused: true })
}

export function resumeTorrentSync(): void {
  if (!state.active || !state.paused) return
  notifyDesktopTmdbControl('resume')
  setState({ ...state, paused: false })
  wakePauseWaiters()
}

export function cancelTorrentSync(): void {
  syncQueueEpoch += 1
  clearSyncJob()
  if (!state.active) return
  notifyDesktopTmdbControl('cancel')
  setState({ active: true, paused: false, cancelling: true })
  wakePauseWaiters()
  // Unblock sync stuck inside Cloudflare unlock / system Chrome wait.
  try {
    void window.signalDesktop?.closeCfBrowser?.({
      soon: false,
      reason: 'catalog-sync-cancelled',
    })
  } catch {
    /* ignore */
  }
  // Android: dismiss Verify / in-app browser so Cancel isn't stuck behind it.
  try {
    void import('./androidBrowser').then((m) => {
      if (m.isAndroidInAppBrowser()) {
        void m.androidBrowserHide({ blank: false, pause: false })
      }
    })
  } catch {
    /* ignore */
  }
}

/**
 * Run catalog sync work one-at-a-time. Prevents overlapping
 * beginTorrentSyncSession() calls from auto-cancelling each other.
 * Returns null when this task was dropped after a user Cancel.
 */
export function enqueueTorrentSyncTask<T>(task: () => Promise<T>): Promise<T | null> {
  const epoch = syncQueueEpoch
  const run = syncQueueTail.then(
    async () => {
      if (epoch !== syncQueueEpoch) return null
      return task()
    },
    async () => {
      if (epoch !== syncQueueEpoch) return null
      return task()
    },
  )
  syncQueueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Await while paused; throw if this session was cancelled or superseded.
 * Call between pages / feed steps — not during IndexedDB replace.
 */
export async function torrentSyncCheckpoint(id: number): Promise<void> {
  for (;;) {
    if (id !== sessionId) {
      throw new TorrentSyncSupersededError()
    }
    if (state.cancelling) {
      throw new TorrentSyncCancelledError()
    }
    if (!state.paused) return
    await new Promise<void>((resolve) => {
      pauseWaiters.push(resolve)
    })
  }
}

export function isTorrentSyncCancelledError(err: unknown): boolean {
  return (
    err instanceof TorrentSyncCancelledError ||
    (err instanceof Error && err.name === 'TorrentSyncCancelledError')
  )
}

export function isTorrentSyncSupersededError(err: unknown): boolean {
  return (
    err instanceof TorrentSyncSupersededError ||
    (err instanceof Error && err.name === 'TorrentSyncSupersededError')
  )
}
