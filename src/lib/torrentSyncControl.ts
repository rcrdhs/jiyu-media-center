/**
 * Pause / resume / cancel for background catalog sync.
 * Checked between pages (and similar yield points) so in-flight fetches finish
 * first — cancel never mid-wipe of IndexedDB.
 */

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

let sessionId = 0
let pauseWaiters: Array<() => void> = []
const listeners = new Set<Listener>()

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
  setState({ active: true, paused: false, cancelling: false })
  return sessionId
}

export function endTorrentSyncSession(id: number): void {
  if (id !== sessionId) return
  wakePauseWaiters()
  notifyDesktopTmdbControl('reset')
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
  if (!state.active) return
  notifyDesktopTmdbControl('cancel')
  setState({ active: true, paused: false, cancelling: true })
  wakePauseWaiters()
}

/**
 * Await while paused; throw if this session was cancelled or superseded.
 * Call between pages / feed steps — not during IndexedDB replace.
 */
export async function torrentSyncCheckpoint(id: number): Promise<void> {
  for (;;) {
    if (id !== sessionId || state.cancelling) {
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
