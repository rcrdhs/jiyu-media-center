/**
 * Sync status lives outside CatalogContext so progress updates do not rebuild
 * the whole catalog value (and re-render every shelf) on every page.
 */
type Listener = () => void

export type TorrentSyncStatus = {
  message: string | null
  /** 0–100 while syncing; null when idle / unknown */
  percent: number | null
}

let status: TorrentSyncStatus = { message: null, percent: null }
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

export function getTorrentSyncStatus(): TorrentSyncStatus {
  return status
}

export function getTorrentSyncMessage(): string | null {
  return status.message
}

export function getTorrentSyncPercent(): number | null {
  return status.percent
}

export function setTorrentSyncMessage(next: string | null, percent: number | null = null): void {
  let pct =
    percent == null || !Number.isFinite(percent)
      ? null
      : Math.max(0, Math.min(100, Math.round(percent)))
  // Completion lines are always 100% so the bar never sticks mid-fill.
  if (next && /^(synced|added)\b/i.test(next.trim())) pct = 100
  if (status.message === next && status.percent === pct) return
  status = { message: next, percent: next ? pct : null }
  emit()
}

export function clearTorrentSyncStatus(): void {
  if (status.message == null && status.percent == null) return
  status = { message: null, percent: null }
  emit()
}

export function subscribeTorrentSyncMessage(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
