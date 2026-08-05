import { useEffect, useSyncExternalStore } from 'react'
import {
  cancelTorrentSync,
  getTorrentSyncControlState,
  pauseTorrentSync,
  resumeTorrentSync,
  subscribeTorrentSyncControl,
} from '../lib/torrentSyncControl'
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
  const control = useSyncExternalStore(
    subscribeTorrentSyncControl,
    getTorrentSyncControlState,
    getTorrentSyncControlState,
  )

  const done =
    Boolean(status.message) &&
    /^(synced|added)\b/i.test(status.message!.trim())
  const cancelled =
    Boolean(status.message) && /^catalog sync cancelled\b/i.test(status.message!.trim())
  const busy = Boolean(status.message) && !done && !cancelled && control.active

  // Dismiss from the UI layer so the bar cannot stick after completion.
  useEffect(() => {
    if (!done && !cancelled) return
    const timer = window.setTimeout(() => {
      clearTorrentSyncStatus()
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [done, cancelled, status.message])

  if (!status.message) return null

  const pct = done ? 100 : status.percent
  const determinate = pct != null && pct >= 0
  const displayMessage = control.paused
    ? status.message.startsWith('Paused ·')
      ? status.message
      : `Paused · ${status.message}`
    : status.message

  return (
    <div
      className={`catalog-sync-bar${control.paused ? ' is-paused' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={busy && !control.paused}
    >
      <div className="catalog-sync-bar-copy">
        <span className="catalog-sync-bar-message">{displayMessage}</span>
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
        aria-valuetext={determinate ? `${pct}%` : displayMessage}
        aria-label="Catalog sync progress"
      >
        <span
          className={`catalog-sync-bar-fill${determinate ? '' : ' is-indeterminate'}${control.paused ? ' is-paused' : ''}`}
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>
      {busy ? (
        <div className="catalog-sync-bar-actions">
          {control.paused ? (
            <button
              type="button"
              className="catalog-sync-bar-btn"
              onClick={() => resumeTorrentSync()}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="catalog-sync-bar-btn"
              onClick={() => pauseTorrentSync()}
            >
              Pause
            </button>
          )}
          <button
            type="button"
            className="catalog-sync-bar-btn catalog-sync-bar-btn-cancel"
            onClick={() => cancelTorrentSync()}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  )
}
