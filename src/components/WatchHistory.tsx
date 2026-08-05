import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCatalog } from '../context/CatalogContext'
import { isVodCategory } from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import {
  formatHistoryLabel,
  listWatchHistory,
  removeWatchHistoryEntry,
  WATCH_HISTORY_EVENT,
  WATCH_HISTORY_FILTERS,
  watchHistoryFilterLabel,
  type WatchHistoryEntry,
  type WatchHistoryFilter,
} from '../lib/watchHistory'

const HISTORY_EXPANDED_KEY = 'jiyu.watchHistory.expanded'

function readHistoryExpanded(): boolean {
  try {
    const raw = localStorage.getItem(HISTORY_EXPANDED_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return true
}

function writeHistoryExpanded(expanded: boolean) {
  try {
    localStorage.setItem(HISTORY_EXPANDED_KEY, expanded ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function HistoryCard({
  entry,
  onRemove,
  fromPath,
}: {
  entry: WatchHistoryEntry
  onRemove: (id: string) => void
  fromPath: string
}) {
  const { getById } = useCatalog()
  const item = getById(entry.id)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const rawPoster = item?.poster || entry.poster || ''
  const catalogPoster = isWeakPosterUrl(rawPoster) ? '' : rawPoster
  const poster = catalogPoster || fallbackPoster || rawPoster
  const title = item?.title || entry.title
  const posterCategory = item?.category || entry.category
  const href =
    entry.category === 'series' || entry.category === 'anime'
      ? `/show/${entry.id}`
      : `/watch/${entry.id}`

  useEffect(() => {
    if (catalogPoster || !isVodCategory(posterCategory)) {
      setFallbackPoster('')
      return
    }
    let cancelled = false
    void resolveCatalogPoster(title, posterCategory).then((url) => {
      if (!cancelled && url) setFallbackPoster(url)
    })
    return () => {
      cancelled = true
    }
  }, [title, posterCategory, catalogPoster])

  return (
    <div className="continue-card-wrap">
      <Link to={href} className="continue-card" state={{ from: fromPath }}>
        <div className="continue-card-art" aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="media-card-fallback">{title.slice(0, 1)}</span>
          )}
          {entry.finished && <span className="history-finished-chip">Finished</span>}
          {!entry.finished && entry.duration > 0 && (
            <div className="continue-progress" aria-hidden>
              <span
                style={{
                  width: `${Math.min(
                    99,
                    Math.max(1, Math.round((entry.currentTime / entry.duration) * 100)),
                  )}%`,
                }}
              />
            </div>
          )}
        </div>
        <div className="continue-card-body">
          <h3>{title}</h3>
          <p>{formatHistoryLabel(entry)}</p>
        </div>
      </Link>
      <button
        type="button"
        className="continue-remove"
        aria-label={`Remove ${title} from history`}
        onClick={() => onRemove(entry.id)}
      >
        ×
      </button>
    </div>
  )
}

export function WatchHistory() {
  const location = useLocation()
  const [filter, setFilter] = useState<WatchHistoryFilter>('all')
  const [expanded, setExpanded] = useState(readHistoryExpanded)
  const [entries, setEntries] = useState(() => listWatchHistory('all'))
  const fromPath = `${location.pathname}${location.search}` || '/'

  useEffect(() => {
    const refresh = () => setEntries(listWatchHistory('all'))
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(WATCH_HISTORY_EVENT, refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener(WATCH_HISTORY_EVENT, refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [location.pathname, location.key])

  const shown =
    filter === 'all' ? entries : entries.filter((entry) => entry.category === filter)

  if (entries.length === 0) return null

  function remove(id: string) {
    removeWatchHistoryEntry(id)
    setEntries(listWatchHistory('all'))
  }

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev
      writeHistoryExpanded(next)
      return next
    })
  }

  return (
    <section
      className={`section-block continue-watching watch-history${expanded ? '' : ' is-collapsed'}`}
    >
      <div className="section-head watch-history-head">
        <div className="watch-history-heading">
          <button
            type="button"
            className="watch-history-toggle"
            aria-expanded={expanded}
            aria-controls="watch-history-body"
            onClick={toggleExpanded}
          >
            <span className="watch-history-chevron" aria-hidden>
              {expanded ? '▾' : '▸'}
            </span>
            <h2 className="continue-watching-title">History</h2>
            {!expanded ? (
              <span className="watch-history-count">{entries.length}</span>
            ) : null}
          </button>
          {expanded ? (
            <p>Titles you’ve watched — including ones that left Continue watching.</p>
          ) : null}
        </div>
        {expanded ? (
          <div className="watch-history-filters" role="tablist" aria-label="History filter">
            {WATCH_HISTORY_FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={`watch-history-filter${filter === id ? ' is-active' : ''}`}
                onClick={() => setFilter(id)}
              >
                {watchHistoryFilterLabel(id)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div id="watch-history-body">
          {shown.length === 0 ? (
            <p className="watch-history-empty">
              Nothing in {watchHistoryFilterLabel(filter)} yet.
            </p>
          ) : (
            <div className="continue-row">
              {shown.map((entry) => (
                <HistoryCard
                  key={`${entry.category}:${entry.id}`}
                  entry={entry}
                  onRemove={remove}
                  fromPath={fromPath}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}
