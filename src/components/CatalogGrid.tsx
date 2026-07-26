import { useEffect, useMemo, useState } from 'react'
import type { StreamItem } from '../types'
import { useCatalog } from '../context/CatalogContext'
import { useStreamHealth } from '../context/StreamHealthContext'
import { MediaCard } from './MediaCard'

interface CatalogGridProps {
  items: StreamItem[]
  emptyHint?: string
  /** Automatically probe streams when they appear in this grid */
  autoCheck?: boolean
  showToolbar?: boolean
  /** Hide offline/timeout as soon as check finishes (default on) */
  autoHideUnresponsive?: boolean
  /** Online only / Auto-hide / Check streams (IPTV health). Off for torrent shelves. */
  showHealthFilters?: boolean
}

export function CatalogGrid({
  items,
  emptyHint,
  autoCheck = false,
  showToolbar = true,
  autoHideUnresponsive = true,
  showHealthFilters = true,
}: CatalogGridProps) {
  const { checkMany, getStatus, checkingCount } = useStreamHealth()
  const { hideDuplicates, setHideDuplicates } = useCatalog()
  const [filterOnline, setFilterOnline] = useState(false)
  const [hideOffline, setHideOffline] = useState(
    showHealthFilters ? autoHideUnresponsive : false,
  )
  // Avoid joining thousands of ids on every render (TV Series shelves got huge).
  const itemKey = `${items.length}:${items[0]?.id ?? ''}:${items[items.length - 1]?.id ?? ''}`

  useEffect(() => {
    setHideOffline(showHealthFilters ? autoHideUnresponsive : false)
  }, [autoHideUnresponsive, showHealthFilters])

  useEffect(() => {
    if (!autoCheck || items.length === 0) return
    const unchecked = items.filter(
      (item) =>
        item.transport !== 'torrent' &&
        item.sourceKind !== 'torrent' &&
        getStatus(item.id) === 'idle',
    )
    if (unchecked.length === 0) return
    void checkMany(unchecked)
  }, [autoCheck, itemKey])

  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (item.transport === 'torrent' || item.sourceKind === 'torrent') return true
      const status = getStatus(item.id)
      if (status === 'checking' || status === 'idle') return !filterOnline
      if (filterOnline && status !== 'online') return false
      if (hideOffline && (status === 'offline' || status === 'timeout')) return false
      return true
    })
  }, [items, filterOnline, hideOffline, getStatus, checkingCount])

  const probeable = items.filter(
    (item) => item.transport !== 'torrent' && item.sourceKind !== 'torrent',
  )

  // Torrents are never HTTP-probed — they stay "idle" forever. Only count IPTV /
  // direct streams in the health summary so Anime (mostly SubsPlease) doesn't
  // show "120 pending · auto-check" for magnet titles.
  const onlineCount = probeable.filter((item) => getStatus(item.id) === 'online').length
  const offlineCount = probeable.filter((item) => {
    const s = getStatus(item.id)
    return s === 'offline' || s === 'timeout'
  }).length
  const pendingCount = probeable.filter((item) => {
    const s = getStatus(item.id)
    return s === 'idle' || s === 'checking'
  }).length

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <p>{emptyHint ?? 'Nothing here yet. Import an M3U playlist to populate this shelf.'}</p>
      </div>
    )
  }

  return (
    <div className="catalog-block">
      {showToolbar && (
        <div className="health-toolbar">
          {showHealthFilters && (
            <>
              <button
                type="button"
                className="primary-btn"
                disabled={checkingCount > 0 || probeable.length === 0}
                onClick={() => void checkMany(probeable)}
              >
                {checkingCount > 0
                  ? `Checking ${checkingCount.toLocaleString()}…`
                  : `Check ${probeable.length.toLocaleString()} stream${probeable.length === 1 ? '' : 's'}`}
              </button>
              <label className="check-toggle">
                <input
                  type="checkbox"
                  checked={filterOnline}
                  onChange={(e) => {
                    setFilterOnline(e.target.checked)
                    if (e.target.checked) setHideOffline(false)
                  }}
                />
                Online only
              </label>
              <label className="check-toggle">
                <input
                  type="checkbox"
                  checked={hideOffline}
                  onChange={(e) => {
                    setHideOffline(e.target.checked)
                    if (e.target.checked) setFilterOnline(false)
                  }}
                />
                Auto-hide unresponsive
              </label>
            </>
          )}
          <label className="check-toggle">
            <input
              type="checkbox"
              checked={hideDuplicates}
              onChange={(e) => setHideDuplicates(e.target.checked)}
            />
            Hide duplicates
          </label>
          {showHealthFilters &&
            (probeable.length > 0 ? (
              <span className="health-summary">
                <em className="online">{onlineCount}</em> up ·{' '}
                <em className="offline">{offlineCount}</em> down
                {pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
                {autoCheck ? ' · auto-check' : ''}
              </span>
            ) : (
              <span className="health-summary">No live streams to check</span>
            ))}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className="empty-state">
          <p>
            {showHealthFilters && checkingCount > 0
              ? 'Checking streams… dead ones disappear as they’re found.'
              : showHealthFilters
                ? 'No reachable streams in this view. Uncheck “Auto-hide unresponsive” or refresh your playlist.'
                : emptyHint ?? 'Nothing matches this view.'}
          </p>
        </div>
      ) : (
        <div className="catalog-grid">
          {visibleItems.map((item) => (
            <MediaCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
