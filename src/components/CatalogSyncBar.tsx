import { useEffect, useSyncExternalStore } from 'react'
import {
  clearTorrentSyncStatus,
  getTorrentSyncStatus,
  subscribeTorrentSyncMessage,
} from '../lib/torrentSyncStatus'

/** Catalog sync progress — shown above the sidebar Library tile. */
export function CatalogSyncBar() {
  const status = useSyncExternalStore(
    subscribeTorrentSyncMessage,
    getTorrentSyncStatus,
    getTorrentSyncStatus,
  )

  const done =
    Boolean(status.message) &&
    /^(synced|added)\b/i.test(status.message!.trim())

  // Dismiss from the UI layer so the bar cannot stick after completion.
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => {
      clearTorrentSyncStatus()
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [done, status.message])

  if (!status.message) return null

  const pct = done ? 100 : status.percent
  const determinate = pct != null && pct >= 0

  return (
    <div
      className="catalog-sync-bar"
      role="status"
      aria-live="polite"
      aria-busy={!done && (pct == null || pct < 100)}
    >
      <div className="catalog-sync-bar-copy">
        <span className="catalog-sync-bar-message">{status.message}</span>
        {determinate ? (
          <span className="catalog-sync-bar-percent">{pct}%</span>
        ) : null}
      </div>
      <div
        className="catalog-sync-bar-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct : undefined}
        aria-valuetext={determinate ? `${pct}%` : status.message}
        aria-label="Catalog sync progress"
      >
        <span
          className={`catalog-sync-bar-fill${determinate ? '' : ' is-indeterminate'}`}
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  )
}
