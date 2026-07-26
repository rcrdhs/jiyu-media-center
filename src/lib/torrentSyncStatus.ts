/**
 * Sync status lives outside CatalogContext so progress text does not rebuild
 * the whole catalog value (and re-render every shelf) on every page.
 */
type Listener = () => void

let message: string | null = null
const listeners = new Set<Listener>()

export function getTorrentSyncMessage(): string | null {
  return message
}

export function setTorrentSyncMessage(next: string | null): void {
  if (message === next) return
  message = next
  for (const listener of listeners) listener()
}

export function subscribeTorrentSyncMessage(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
