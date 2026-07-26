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
  collapseEpisodeRowsToShows,
  isAnimeFullShowItem,
  isAnimeNewReleaseItem,
  isEztvShowUrl,
  isEztvSource,
  isYtsLabel,
  linkToCatalogItem,
  loadTorrentSources,
  lookupEztvShowCard,
} from '../lib/torrents'
import { getMainStage, getSectionView, setSectionView } from '../lib/viewState'
import type { CategoryId, StreamItem } from '../types'

const PAGE = 120
const MIXED_SECTIONS = new Set<CategoryId>(['movies', 'series', 'anime'])
const ANIME_TAB_KEY = 'jiyu.anime.shelf-tab'
type AnimeShelfTab = 'new-releases' | 'full-shows'

function readAnimeShelfTab(): AnimeShelfTab {
  try {
    const raw = localStorage.getItem(ANIME_TAB_KEY)
    if (raw === 'new-releases' || raw === 'full-shows') return raw
  } catch {
    /* ignore */
  }
  return 'new-releases'
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
) {
  return [...items].sort((a, b) => {
    // Movies: always newest release → earliest (theatrical year / added date).
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
  const [animeTab, setAnimeTab] = useState<AnimeShelfTab>(readAnimeShelfTab)

  const categoryId = (meta?.id ?? 'series') as CategoryId
  // Memoize — byCategory() returns a new array every call; sync status updates
  // were re-sorting the entire TV Series shelf on every page of EZTV sync.
  const items = useMemo(() => byCategory(categoryId), [byCategory, categoryId])
  const trackGrowth = Boolean(meta && isGrowthTrackedSection(meta.id))

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

  /** Shelf size without search — used for today/yesterday title counts. */
  const shelfItems = useMemo(() => {
    if (categoryId === 'anime') {
      const newReleases = prepareShelfList(
        items.filter((item) => isAnimeNewReleaseItem(item)),
        { ...shelfOpts, newestFirst: true, collapseEpisodes: false },
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isAnimeFullShowItem(item)),
        shelfOpts,
      )
      const other = prepareShelfList(
        items.filter(
          (item) => !isAnimeNewReleaseItem(item) && !isAnimeFullShowItem(item),
        ),
        shelfOpts,
      )
      return [...newReleases, ...fullShows, ...other]
    }
    return prepareShelfList(items, shelfOpts)
  }, [items, categoryId, shelfOpts])

  const animeShelves = useMemo(() => {
    if (categoryId !== 'anime') return null
    const q = query.trim().toLowerCase()
    const newReleases = prepareShelfList(
      items.filter((item) => isAnimeNewReleaseItem(item) && matchesSectionQuery(item, q)),
      { ...shelfOpts, newestFirst: true, collapseEpisodes: false },
    )
    const fullShows = prepareShelfList(
      items.filter((item) => isAnimeFullShowItem(item) && matchesSectionQuery(item, q)),
      shelfOpts,
    )
    const other = prepareShelfList(
      items.filter(
        (item) =>
          !isAnimeNewReleaseItem(item) &&
          !isAnimeFullShowItem(item) &&
          matchesSectionQuery(item, q),
      ),
      shelfOpts,
    )
    return { newReleases, fullShows, other }
  }, [items, query, categoryId, shelfOpts])

  const filtered = useMemo(() => {
    if (animeShelves) {
      return [
        ...animeShelves.newReleases,
        ...animeShelves.fullShows,
        ...animeShelves.other,
      ]
    }
    const q = query.trim().toLowerCase()
    if (!q) return shelfItems
    return shelfItems.filter((item) => matchesSectionQuery(item, q))
  }, [shelfItems, query, animeShelves])

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
          await upsertTorrentItems([linkToCatalogItem(link, source, 'series')])
          await reloadTorrentCatalog()
          break
        }
      })()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [ready, categoryId, query, reloadTorrentCatalog])

  const growthLine = growth ? formatSectionGrowth(growth) : null

  const hasAnimeTabs = Boolean(
    animeShelves &&
      (animeShelves.newReleases.length > 0 ||
        animeShelves.fullShows.length > 0 ||
        animeShelves.other.length > 0),
  )

  // Prefer New Releases when that shelf has items; otherwise land on Full Shows.
  useEffect(() => {
    if (!animeShelves) return
    if (animeTab === 'new-releases' && animeShelves.newReleases.length === 0) {
      if (animeShelves.fullShows.length > 0 || animeShelves.other.length > 0) {
        setAnimeTab('full-shows')
      }
    }
  }, [animeShelves, animeTab])

  function selectAnimeTab(tab: AnimeShelfTab) {
    setAnimeTab(tab)
    setVisible(PAGE)
    try {
      localStorage.setItem(ANIME_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }

  const activeAnimeList = useMemo(() => {
    if (!animeShelves) return null
    if (animeTab === 'new-releases') return animeShelves.newReleases
    return [...animeShelves.fullShows, ...animeShelves.other]
  }, [animeShelves, animeTab])

  const pagedList = activeAnimeList ?? filtered
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

      {hasAnimeTabs && animeShelves ? (
        <section className="section-block anime-shelf-block">
          <div className="section-head anime-shelf-head">
            <div className="anime-shelf-tabs" role="tablist" aria-label="Anime shelves">
              <button
                type="button"
                role="tab"
                className={`anime-shelf-tab${animeTab === 'new-releases' ? ' is-active' : ''}`}
                aria-selected={animeTab === 'new-releases'}
                onClick={() => selectAnimeTab('new-releases')}
              >
                New Releases
              </button>
              <button
                type="button"
                role="tab"
                className={`anime-shelf-tab${animeTab === 'full-shows' ? ' is-active' : ''}`}
                aria-selected={animeTab === 'full-shows'}
                onClick={() => selectAnimeTab('full-shows')}
              >
                Full Shows
              </button>
            </div>
            <p>
              {animeTab === 'new-releases'
                ? 'Latest single-episode drops from SubsPlease'
                : 'Complete SubsPlease catalog'}
              <span className="count-chip">{pagedList.length.toLocaleString()}</span>
            </p>
          </div>
          <CatalogGrid
            items={shown}
            autoCheck={false}
            showHealthFilters={false}
            autoHideUnresponsive={false}
            emptyHint={
              animeTab === 'new-releases'
                ? 'No new releases yet — sync the SubsPlease homepage in Library.'
                : 'No full shows yet — sync SubsPlease /shows/ in Library.'
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
