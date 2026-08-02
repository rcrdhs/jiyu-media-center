import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { useMainScrollRestore } from '../hooks/useMainScrollRestore'
import { isVodCategory } from '../lib/continueWatching'
import {
  formatSectionGrowth,
  isGrowthTrackedSection,
  recordSectionTitleCount,
  type SectionGrowth,
} from '../lib/libraryGrowth'
import { getSectionSourcePrefs, setSectionSourcePrefs } from '../lib/sectionPrefs'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import {
  ANIME_SHELF_FULL_SHOWS,
  collapseEpisodeRowsToShows,
  isAnimeFullShowItem,
  isAnimeNewReleaseItem,
  isEztvShowUrl,
  isEztvSource,
  isMoviesNewItem,
  isMoviesPopularItem,
  isSeriesFullShowItem,
  isSeriesTrendingItem,
  isYtsLabel,
  linkToCatalogItem,
  loadTorrentSources,
  lookupEztvShowCard,
} from '../lib/torrents'
import { getMainStage, getSectionView, setSectionView } from '../lib/viewState'
import type { CategoryId, StreamItem } from '../types'

const PAGE = 120
const MIXED_SECTIONS = new Set<CategoryId>(['movies', 'series', 'anime'])
type ShelfTabId = 'primary' | 'full-shows'

function shelfTabStorageKey(category: CategoryId): string {
  return `jiyu.${category}.shelf-tab`
}

function readShelfTab(category: CategoryId, fallback: ShelfTabId): ShelfTabId {
  try {
    const raw = localStorage.getItem(shelfTabStorageKey(category))
    if (raw === 'primary' || raw === 'full-shows') return raw
    // Migrate older anime key values.
    if (category === 'anime' && (raw === 'new-releases' || raw === 'full-shows')) {
      return raw === 'new-releases' ? 'primary' : 'full-shows'
    }
  } catch {
    /* ignore */
  }
  return fallback
}

function isIptvShelfItem(item: StreamItem): boolean {
  if (item.sourceKind === 'torrent' || item.transport === 'torrent') return false
  if (item.sourceKind === 'iptv') return true
  if (item.tags?.some((t) => /^iptv$/i.test(t))) return true
  // Playlist imports are direct streams and not builtins.
  if (item.sourceKind !== 'builtin' && item.transport === 'direct') {
    if (item.tags?.some((t) => /^imported$/i.test(t))) return true
  }
  return false
}

function sourceRank(item: StreamItem, torrentFirst: boolean): number {
  const kind = item.sourceKind ?? (item.transport === 'torrent' ? 'torrent' : 'iptv')
  if (!torrentFirst) {
    if (kind === 'iptv') return 0
    if (kind === 'torrent') return 1
    return 2
  }
  if (kind === 'torrent') return 0
  if (kind === 'builtin') return 1
  return 2
}

function isYtsItem(item: StreamItem): boolean {
  const source = `${item.source ?? ''} ${(item.tags ?? []).join(' ')}`
  return isYtsLabel(source)
}

/**
 * Sort key for newest → earliest. Prefer a year in the title (theatrical
 * release) over torrent upload timestamps that may be stored in releasedAt.
 */
function releaseSortKey(item: StreamItem): number {
  const yearMatch = /\b((?:19|20)\d{2})\b/.exec(item.title)
  if (yearMatch) {
    const year = Number(yearMatch[1])
    if (item.releasedAt && item.releasedAt > 0) {
      const releasedYear = new Date(item.releasedAt).getUTCFullYear()
      if (releasedYear === year) return item.releasedAt
    }
    return Date.UTC(year, 0, 1)
  }
  if (item.releasedAt && item.releasedAt > 0) return item.releasedAt
  return 0
}

function sortSectionItems(
  items: StreamItem[],
  torrentFirst: boolean,
  newestFirst: boolean,
  category: CategoryId,
  /** Popular Movies: keep YTS download-rank via releasedAt, not theatrical year. */
  sortMode: 'default' | 'rank' = 'default',
) {
  return [...items].sort((a, b) => {
    if (category === 'movies' && sortMode === 'rank') {
      const rank = (b.releasedAt ?? 0) - (a.releasedAt ?? 0)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }

    // Movies (New): newest release → earliest (theatrical year / added date).
    if (category === 'movies') {
      const date = releaseSortKey(b) - releaseSortKey(a)
      if (date !== 0) return date
      const ytsRank = Number(isYtsItem(b)) - Number(isYtsItem(a))
      if (ytsRank !== 0) return ytsRank
      const rank = sourceRank(a, torrentFirst) - sourceRank(b, torrentFirst)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }

    const rank = sourceRank(a, torrentFirst) - sourceRank(b, torrentFirst)
    if (rank !== 0) return rank
    if (newestFirst) {
      const date = releaseSortKey(b) - releaseSortKey(a)
      if (date !== 0) return date
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })
}

function prepareShelfList(
  list: StreamItem[],
  options: {
    categoryId: CategoryId
    showSourceTools: boolean
    hideIptv: boolean
    torrentFirst: boolean
    newestFirst: boolean
    collapseEpisodes?: boolean
    sortMode?: 'default' | 'rank'
  },
) {
  let next = list
  if (options.showSourceTools && options.hideIptv) {
    next = next.filter((item) => !isIptvShelfItem(item))
  }
  const collapse = options.collapseEpisodes !== false
  if (collapse && (options.categoryId === 'series' || options.categoryId === 'anime')) {
    let needsCollapse = false
    for (const item of next) {
      if (item.transport !== 'torrent' && item.sourceKind !== 'torrent') continue
      if (isEztvShowUrl(item.url)) continue
      if (isAnimeNewReleaseItem(item)) continue
      if (
        /\bS\d{1,2}E\d{1,3}\b/i.test(item.title) ||
        /\b(?:Episode|Ep\.?)\s*#?\s*\d+/i.test(item.title)
      ) {
        needsCollapse = true
        break
      }
    }
    if (needsCollapse) next = collapseEpisodeRowsToShows(next)
  }
  if (options.showSourceTools) {
    next = sortSectionItems(
      next,
      options.torrentFirst,
      options.newestFirst,
      options.categoryId,
      options.sortMode ?? 'default',
    )
  }
  return next
}

function matchesSectionQuery(item: StreamItem, q: string): boolean {
  if (!q) return true
  return (
    item.title.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    Boolean(item.tags?.some((t) => t.toLowerCase().includes(q))) ||
    Boolean(item.source?.toLowerCase().includes(q))
  )
}

export function SectionPage() {
  const { id } = useParams<{ id: string }>()
  const { byCategory, ready, reloadTorrentCatalog } = useCatalog()
  const meta = CATEGORIES.find((c) => c.id === id)
  const saved = id ? getSectionView(id) : undefined
  const sentinelRef = useRef<HTMLDivElement>(null)
  const showSourceTools = Boolean(meta && MIXED_SECTIONS.has(meta.id))
  const eztvLookupRef = useRef<string>('')

  const [query, setQuery] = useState(saved?.query ?? '')
  const [visible, setVisible] = useState(saved?.visible ?? PAGE)
  const [autoCheck, setAutoCheck] = useState(saved?.autoCheck ?? true)
  const [listReady, setListReady] = useState(false)
  const [sourcePrefs, setSourcePrefsState] = useState(getSectionSourcePrefs)
  const categoryId = (meta?.id ?? 'series') as CategoryId
  const [shelfTab, setShelfTab] = useState<ShelfTabId>(() =>
    readShelfTab(
      categoryId,
      categoryId === 'series' || categoryId === 'anime' || categoryId === 'movies'
        ? 'primary'
        : 'full-shows',
    ),
  )
  const userPickedShelfTabRef = useRef(false)

  // Memoize — byCategory() returns a new array every call; sync status updates
  // were re-sorting the entire TV Series shelf on every page of EZTV sync.
  const items = useMemo(() => byCategory(categoryId), [byCategory, categoryId])
  const trackGrowth = Boolean(meta && isGrowthTrackedSection(meta.id))

  useEffect(() => {
    // Remounting the same section (click a title → Back) must keep the saved
    // infinite-scroll window. Resetting to PAGE here made scroll restore clamp
    // to the top after deep scrolls (e.g. titles starting with "P").
    userPickedShelfTabRef.current = false
    setShelfTab(readShelfTab(categoryId, 'primary'))
    const savedView = getSectionView(categoryId)
    setVisible(savedView?.visible ?? PAGE)
    setQuery(savedView?.query ?? '')
    setAutoCheck(savedView?.autoCheck ?? true)
  }, [categoryId])

  const shelfOpts = useMemo(
    () => ({
      categoryId,
      showSourceTools,
      hideIptv: sourcePrefs.hideIptv,
      torrentFirst: sourcePrefs.torrentFirst,
      newestFirst: sourcePrefs.newestFirst,
    }),
    [categoryId, showSourceTools, sourcePrefs],
  )

  const splitShelves = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (item: StreamItem) => matchesSectionQuery(item, q)

    if (categoryId === 'anime') {
      const primary = prepareShelfList(
        items.filter((item) => isAnimeNewReleaseItem(item) && match(item)),
        { ...shelfOpts, newestFirst: true, collapseEpisodes: false },
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isAnimeFullShowItem(item) && match(item)),
        shelfOpts,
      )
      const other = prepareShelfList(
        items.filter(
          (item) =>
            !isAnimeNewReleaseItem(item) && !isAnimeFullShowItem(item) && match(item),
        ),
        shelfOpts,
      )
      return {
        primaryLabel: 'New Releases',
        fullLabel: 'Full Shows',
        primaryBlurb: '',
        fullBlurb: '',
        primaryEmpty: 'No new releases yet — sync the anime website in Library.',
        fullEmpty: 'No full shows yet — sync the anime website in Library.',
        primary,
        fullShows,
        other,
      }
    }

    if (categoryId === 'series') {
      // Full Shows = TMDB popular on EZTV; Now Airing = EZTV trending/landing.
      const primary = prepareShelfList(
        items.filter((item) => isSeriesFullShowItem(item) && match(item)),
        shelfOpts,
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isSeriesTrendingItem(item) && match(item)),
        { ...shelfOpts, newestFirst: true },
      )
      const other = prepareShelfList(
        items.filter(
          (item) =>
            !isSeriesFullShowItem(item) && !isSeriesTrendingItem(item) && match(item),
        ),
        shelfOpts,
      )
      return {
        primaryLabel: 'Full Shows',
        fullLabel: 'Now Airing',
        primaryBlurb: '',
        fullBlurb: '',
        primaryEmpty: 'No full shows yet — sync the TV website in Library.',
        fullEmpty: 'No airing titles yet — sync the TV website in Library.',
        primary,
        fullShows,
        other,
      }
    }

    if (categoryId === 'movies') {
      const primary = prepareShelfList(
        items.filter((item) => isMoviesPopularItem(item) && match(item)),
        { ...shelfOpts, sortMode: 'rank' },
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isMoviesNewItem(item) && match(item)),
        { ...shelfOpts, newestFirst: true },
      )
      const other = prepareShelfList(
        items.filter(
          (item) => !isMoviesPopularItem(item) && !isMoviesNewItem(item) && match(item),
        ),
        shelfOpts,
      )
      return {
        primaryLabel: 'Popular Movies',
        fullLabel: 'New Movies',
        primaryBlurb: '',
        fullBlurb: '',
        primaryEmpty: 'No popular movies yet — sync the movies website in Library.',
        fullEmpty: 'No new movies yet — sync the movies website in Library.',
        primary,
        fullShows,
        other,
      }
    }

    return null
  }, [items, query, categoryId, shelfOpts])

  /** Shelf size without search — used for today/yesterday title counts. */
  const shelfItems = useMemo(() => {
    if (categoryId === 'anime') {
      return [
        ...prepareShelfList(
          items.filter((item) => isAnimeNewReleaseItem(item)),
          { ...shelfOpts, newestFirst: true, collapseEpisodes: false },
        ),
        ...prepareShelfList(
          items.filter((item) => isAnimeFullShowItem(item)),
          shelfOpts,
        ),
        ...prepareShelfList(
          items.filter(
            (item) => !isAnimeNewReleaseItem(item) && !isAnimeFullShowItem(item),
          ),
          shelfOpts,
        ),
      ]
    }
    if (categoryId === 'series') {
      return [
        ...prepareShelfList(
          items.filter((item) => isSeriesFullShowItem(item)),
          shelfOpts,
        ),
        ...prepareShelfList(
          items.filter((item) => isSeriesTrendingItem(item)),
          { ...shelfOpts, newestFirst: true },
        ),
        ...prepareShelfList(
          items.filter(
            (item) => !isSeriesFullShowItem(item) && !isSeriesTrendingItem(item),
          ),
          shelfOpts,
        ),
      ]
    }
    if (categoryId === 'movies') {
      return [
        ...prepareShelfList(
          items.filter((item) => isMoviesPopularItem(item)),
          { ...shelfOpts, sortMode: 'rank' },
        ),
        ...prepareShelfList(
          items.filter((item) => isMoviesNewItem(item)),
          { ...shelfOpts, newestFirst: true },
        ),
        ...prepareShelfList(
          items.filter((item) => !isMoviesPopularItem(item) && !isMoviesNewItem(item)),
          shelfOpts,
        ),
      ]
    }
    return prepareShelfList(items, shelfOpts)
  }, [items, categoryId, shelfOpts])

  const filtered = useMemo(() => {
    if (splitShelves) {
      return [...splitShelves.primary, ...splitShelves.fullShows, ...splitShelves.other]
    }
    const q = query.trim().toLowerCase()
    if (!q) return shelfItems
    return shelfItems.filter((item) => matchesSectionQuery(item, q))
  }, [shelfItems, query, splitShelves])

  const [growth, setGrowth] = useState<SectionGrowth | null>(null)

  useEffect(() => {
    if (!ready || !trackGrowth) {
      setGrowth(null)
      return
    }
    setGrowth(recordSectionTitleCount(categoryId, shelfItems.length))
  }, [ready, trackGrowth, categoryId, shelfItems.length])

  // Older EZTV titles aren't in the recent-API shelf — resolve by name on search.
  useEffect(() => {
    if (!ready || categoryId !== 'series') return
    const q = query.trim()
    if (q.length < 3) return
    const qLower = q.toLowerCase()
    if (eztvLookupRef.current === qLower) return
    // Avoid scanning the full shelf on every catalog mutation during sync.
    const timer = window.setTimeout(() => {
      void (async () => {
        const sources = loadTorrentSources().filter((source) =>
          isEztvSource(source.url, source.label),
        )
        if (sources.length === 0) return
        for (const source of sources) {
          const link = await lookupEztvShowCard(q, source)
          if (!link) continue
          eztvLookupRef.current = qLower
          await upsertTorrentItems([
            linkToCatalogItem(link, source, 'series', ANIME_SHELF_FULL_SHOWS),
          ])
          await reloadTorrentCatalog()
          break
        }
      })()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [ready, categoryId, query, reloadTorrentCatalog])

  const growthLine = growth ? formatSectionGrowth(growth) : null

  const hasShelfTabs = Boolean(
    splitShelves &&
      (splitShelves.primary.length > 0 ||
        splitShelves.fullShows.length > 0 ||
        splitShelves.other.length > 0),
  )

  // On first load only: if the saved primary tab is empty, land on Full Shows.
  // Never bounce after the user explicitly picks a tab.
  useEffect(() => {
    if (!splitShelves || userPickedShelfTabRef.current) return
    if (shelfTab === 'primary' && splitShelves.primary.length === 0) {
      if (splitShelves.fullShows.length > 0 || splitShelves.other.length > 0) {
        setShelfTab('full-shows')
      }
    }
  }, [splitShelves, shelfTab])

  function selectShelfTab(tab: ShelfTabId) {
    userPickedShelfTabRef.current = true
    setShelfTab(tab)
    setVisible(PAGE)
    try {
      localStorage.setItem(shelfTabStorageKey(categoryId), tab)
    } catch {
      /* ignore */
    }
  }

  const activeShelfList = useMemo(() => {
    if (!splitShelves) return null
    if (shelfTab === 'primary') return splitShelves.primary
    return [...splitShelves.fullShows, ...splitShelves.other]
  }, [splitShelves, shelfTab])

  const pagedList = activeShelfList ?? filtered
  const effectiveVisible = Math.min(
    Math.max(visible, PAGE),
    Math.max(pagedList.length, PAGE),
  )
  const shown = pagedList.slice(
    0,
    Math.min(effectiveVisible, pagedList.length || effectiveVisible),
  )
  const remaining = pagedList.length - shown.length

  useEffect(() => {
    if (!id) return
    setSectionView(id, {
      query,
      visible: effectiveVisible,
      autoCheck,
    })
  }, [id, query, effectiveVisible, autoCheck])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || remaining <= 0) return

    const root = getMainStage()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setVisible((v) => Math.min(v + PAGE, pagedList.length))
      },
      {
        root: root ?? null,
        rootMargin: '400px 0px',
        threshold: 0,
      },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [remaining, pagedList.length, shown.length, id])

  useEffect(() => {
    if (!ready || !meta) {
      setListReady(false)
      return
    }
    const frame = requestAnimationFrame(() => setListReady(true))
    return () => cancelAnimationFrame(frame)
  }, [ready, meta, shown.length, id])

  useMainScrollRestore(id ? `/section/${id}` : '', listReady)

  function updateSourcePrefs(patch: Partial<typeof sourcePrefs>) {
    const next = { ...sourcePrefs, ...patch }
    setSourcePrefsState(next)
    setSectionSourcePrefs(next)
    setVisible(PAGE)
  }

  if (!meta) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>Unknown section.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header" style={{ ['--accent' as string]: meta.accent }}>
        <p className="eyebrow">Section</p>
        <h1>{meta.label}</h1>
        <p className="lede">
          {meta.blurb}{' '}
          <span className="count-chip">
            {(query.trim() ? filtered.length : shelfItems.length).toLocaleString()} title
            {(query.trim() ? filtered.length : shelfItems.length) === 1 ? '' : 's'}
          </span>
        </p>
        {trackGrowth && growth && growthLine && (
          <p className="section-growth">
            {growthLine}
            {growth.delta != null ? (
              growth.delta !== 0 ? (
                <span className={growth.delta > 0 ? 'section-growth-up' : 'section-growth-down'}>
                  {' '}
                  ({growth.delta > 0 ? '+' : ''}
                  {growth.delta.toLocaleString()} since yesterday)
                </span>
              ) : (
                <span className="section-growth-flat"> (no new titles since yesterday)</span>
              )
            ) : growth.newToday > 0 ? (
              <span className="section-growth-up">
                {' '}
                (+{growth.newToday.toLocaleString()} new today)
              </span>
            ) : growth.newToday < 0 ? (
              <span className="section-growth-down">
                {' '}
                ({growth.newToday.toLocaleString()} today)
              </span>
            ) : (
              <span className="section-growth-flat"> (no new titles yet today)</span>
            )}
          </p>
        )}
      </header>

      {isVodCategory(meta.id) && (
        <ContinueWatching category={meta.id} variant="section" />
      )}

      <div className="section-tools">
        <input
          className="search-input"
          type="search"
          placeholder={`Search ${meta.label.toLowerCase()}…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setVisible(PAGE)
          }}
        />
        {!showSourceTools && (
          <label className="check-toggle tool-toggle">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => setAutoCheck(e.target.checked)}
            />
            Auto-check visible streams
          </label>
        )}
        {showSourceTools && (
          <>
            <label className="check-toggle tool-toggle">
              <input
                type="checkbox"
                checked={sourcePrefs.hideIptv}
                onChange={(e) => updateSourcePrefs({ hideIptv: e.target.checked })}
              />
              Hide IPTV
            </label>
            <label className="check-toggle tool-toggle">
              <input
                type="checkbox"
                checked={sourcePrefs.torrentFirst}
                onChange={(e) => updateSourcePrefs({ torrentFirst: e.target.checked })}
              />
              Websites first
            </label>
            {meta.id !== 'movies' && (
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.newestFirst}
                  onChange={(e) => updateSourcePrefs({ newestFirst: e.target.checked })}
                />
                Newest first
              </label>
            )}
          </>
        )}
      </div>

      {hasShelfTabs && splitShelves ? (
        <section className="section-block anime-shelf-block">
          <div className="section-head anime-shelf-head">
            <div
              className="anime-shelf-tabs"
              role="tablist"
              aria-label={`${meta.label} shelves`}
            >
              <button
                type="button"
                role="tab"
                className={`anime-shelf-tab${shelfTab === 'primary' ? ' is-active' : ''}`}
                aria-selected={shelfTab === 'primary'}
                onClick={() => selectShelfTab('primary')}
              >
                {splitShelves.primaryLabel}
              </button>
              <button
                type="button"
                role="tab"
                className={`anime-shelf-tab${shelfTab === 'full-shows' ? ' is-active' : ''}`}
                aria-selected={shelfTab === 'full-shows'}
                onClick={() => selectShelfTab('full-shows')}
              >
                {splitShelves.fullLabel}
              </button>
            </div>
            {((shelfTab === 'primary'
              ? splitShelves.primaryBlurb
              : splitShelves.fullBlurb) || ''
            ).trim() ? (
              <p>
                {shelfTab === 'primary' ? splitShelves.primaryBlurb : splitShelves.fullBlurb}
                <span className="count-chip">{pagedList.length.toLocaleString()}</span>
              </p>
            ) : null}
          </div>
          <CatalogGrid
            items={shown}
            autoCheck={false}
            showHealthFilters={false}
            autoHideUnresponsive={false}
            emptyHint={
              shelfTab === 'primary' ? splitShelves.primaryEmpty : splitShelves.fullEmpty
            }
          />
        </section>
      ) : (
        <CatalogGrid
          items={shown}
          autoCheck={showSourceTools ? false : autoCheck}
          showHealthFilters={!showSourceTools}
          autoHideUnresponsive={!showSourceTools}
          emptyHint={`No ${meta.label.toLowerCase()} titles yet. Import a playlist or add a website in Library to fill this shelf.`}
        />
      )}
      {remaining > 0 && (
        <div ref={sentinelRef} className="infinite-scroll-sentinel" aria-hidden>
          <p className="fine-print">
            Showing {shown.length.toLocaleString()} of {pagedList.length.toLocaleString()} — scroll for
            more
          </p>
        </div>
      )}
    </div>
  )
}
