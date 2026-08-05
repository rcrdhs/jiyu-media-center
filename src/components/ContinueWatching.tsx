import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCatalog } from '../context/CatalogContext'
import {
  CONTINUE_WATCHING_EVENT,
  formatResumeLabel,
  isTrustedDuration,
  isVodCategory,
  listContinueWatching,
  progressPercent,
  removeContinueEntry,
  repairContinueWithRuntime,
  vodCategoryLabel,
  type ContinueWatchingEntry,
} from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'

function ContinueCard({
  entry,
  onRemove,
  fromPath,
  showCategory,
}: {
  entry: ContinueWatchingEntry
  onRemove: (id: string) => void
  fromPath: string
  showCategory: boolean
}) {
  const { getById } = useCatalog()
  const item = getById(entry.id)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const rawPoster = item?.poster || entry.poster || ''
  const catalogPoster = isWeakPosterUrl(rawPoster) ? '' : rawPoster
  const poster = catalogPoster || fallbackPoster || rawPoster
  const title = item?.title || entry.title
  const percent = progressPercent(entry)
  const posterCategory = item?.category || entry.category

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
      <Link to={`/watch/${entry.id}`} className="continue-card" state={{ from: fromPath }}>
        <div className="continue-card-art" aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="media-card-fallback">{title.slice(0, 1)}</span>
          )}
          {showCategory && isVodCategory(entry.category) && (
            <span className="continue-category-chip">{vodCategoryLabel(entry.category)}</span>
          )}
          <div className="continue-progress" aria-hidden>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="continue-card-body">
          <h3>{title}</h3>
          <p>{formatResumeLabel(entry)}</p>
        </div>
      </Link>
      <button
        type="button"
        className="continue-remove"
        aria-label={`Remove ${title} from continue watching`}
        onClick={() => onRemove(entry.id)}
      >
        ×
      </button>
    </div>
  )
}

export function ContinueWatching({
  category,
  /** Section shelves use a short gold title; Home labels the shelf name. */
  variant = 'home',
}: {
  /** When set, only show titles from this shelf. */
  category?: ContinueWatchingEntry['category']
  variant?: 'home' | 'section'
}) {
  const location = useLocation()
  const { getById } = useCatalog()
  const [entries, setEntries] = useState(() => listContinueWatching())
  const fromPath = `${location.pathname}${location.search}` || '/'

  useEffect(() => {
    const refresh = () => {
      // Fold bloated resume times once catalog/YTS runtime is known.
      for (const entry of listContinueWatching()) {
        const runtime = getById(entry.id)?.runtimeSeconds || entry.runtimeSeconds
        if (isTrustedDuration(runtime || 0) && entry.currentTime > (runtime as number)) {
          repairContinueWithRuntime(entry.id, runtime as number)
        }
      }
      setEntries(listContinueWatching())
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(CONTINUE_WATCHING_EVENT, refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener(CONTINUE_WATCHING_EVENT, refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [location.pathname, location.key, getById])

  const shown = category
    ? entries.filter((entry) => entry.category === category)
    : entries.filter((entry) => isVodCategory(entry.category))
  if (shown.length === 0) return null

  function remove(id: string) {
    removeContinueEntry(id)
    setEntries(listContinueWatching())
  }

  const heading =
    variant === 'section'
      ? 'Continue watching ·'
      : category === 'movies'
        ? 'Continue watching · Movies'
        : category === 'series'
          ? 'Continue watching · Series'
          : category === 'anime'
            ? 'Continue watching · Anime'
            : category === 'kids'
              ? 'Continue watching · Kids'
              : 'Continue watching'

  return (
    <section className="section-block continue-watching">
      <div className="section-head">
        <h2 className="continue-watching-title">{heading}</h2>
        {variant === 'home' && (
          <p>
            {category
              ? `Pick up where you left off in ${
                  category === 'movies' ? 'movies' : category === 'series' ? 'TV series' : category
                }.`
              : 'Pick up where you left off.'}
          </p>
        )}
      </div>
      <div className="continue-row">
        {shown.map((entry) => (
          <ContinueCard
            key={`${entry.category}:${entry.id}`}
            entry={entry}
            onRemove={remove}
            fromPath={fromPath}
            showCategory={false}
          />
        ))}
      </div>
    </section>
  )
}
