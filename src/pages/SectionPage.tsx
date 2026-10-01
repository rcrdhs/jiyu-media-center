import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { NewTitlesDialog } from '../components/NewTitlesDialog'
import { useMainScrollRestore } from '../hooks/useMainScrollRestore'
import { isVodCategory } from '../lib/continueWatching'
import { searchNyaaAnimeForShelf } from '../lib/nyaa'
import { searchMoviesForShelf, type MoviesShelfTarget } from '../lib/movieShelfSearch'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import {
  formatSectionGrowth,
  isGrowthTrackedSection,
  recordSectionTitleCount,
  type NewTitlesKind,
  type SectionGrowth,
} from '../lib/libraryGrowth'
import { sectionNewTitleItems } from '../lib/newTitlesList'
import {
  getSectionSortMode,
  getSectionSourcePrefs,
  setSectionSortMode,
  setSectionSourcePrefs,
  type SectionSortMode,
} from '../lib/sectionPrefs'
import {
  collapseEpisodeRowsToShows,
  isAnimeFullShowItem,
  isAnimeNewReleaseItem,
  isEztvShowUrl,
  isMoviesNewItem,
  isMoviesPopularItem,
  isSeries247Item,
  isSeriesAiringItem,
  isSeriesPopularItem,
  isSeriesTrendingItem,
  isYtsLabel,
} from '../lib/torrents'
import {
  isKidsLiveItem,
  isKidsMovieItem,
  isKidsShowItem,
} from '../lib/kidsCatalog'
import {
  clearSectionFocusItem,
  getMainScroll,
  getMainStage,
  getSectionView,
  setSectionView,
} from '../lib/viewState'
import {
  isStreamedCatalogItem,
  streamedItemSportId,
} from '../lib/streamed'
import { isPpvStCatalogItem, ppvStSportChipsFromItems } from '../lib/ppvSt'
import {
  isLivextvReplayCatalogItem,
  livextvReplaySportChipsFromItems,
  livextvReplaySportId,
} from '../lib/livextvReplays'
import { groupFootballByLeague } from '../lib/sportsLeagues'
import {
  readSelectedSportsFilter,
  writeSelectedSportsFilter,
} from '../lib/favoriteTeams'
import { FavoriteTeamsEditor } from '../components/FavoriteTeamsEditor'
import type { CategoryId, StreamItem } from '../types'

const PAGE = 120
/** First paint after navigation — keep small so TV Series (~20k) opens under ~2s. */
const INITIAL_VISIBLE_CAP = 48
/** Never eagerly remount more than this when entering the section (scroll loads the rest). */
const MAX_EAGER_VISIBLE = 120
/** Cards kept around a focused title when restoring after Back (windowed, not 0…N). */
const FOCUS_WINDOW = 64
const MIXED_SECTIONS = new Set<CategoryId>(['movies', 'series', 'anime', 'kids'])
const SPORTS_PINNED_IDS = ['sports-tnt-uk-youtube', 'sports-tnt-uk-hbomax'] as const

/** Approximate pixel height of N catalog cards as grid rows (for window spacers). */
function estimateCatalogSpacerPx(itemCount: number, widthPx: number): number {
  if (itemCount <= 0) return 0
  const minCol = 175
  const gap = 13.6
  const cols = Math.max(1, Math.floor((widthPx + gap) / (minCol + gap)))
  const colW = Math.max(minCol, (widthPx - gap * (cols - 1)) / cols)
  const rowH = colW * (10 / 16) + 96 + gap
  return Math.ceil(itemCount / cols) * rowH
}

function pinSportsShortcuts(items: StreamItem[], category: CategoryId): StreamItem[] {
  if (category !== 'sports') return items
  const pinned = SPORTS_PINNED_IDS.map((id) => items.find((item) => item.id === id)).filter(
    (item): item is StreamItem => !!item,
  )
  if (pinned.length === 0) return items
  const pinIds = new Set(SPORTS_PINNED_IDS)
  const rest = items.filter((item) => !pinIds.has(item.id as (typeof SPORTS_PINNED_IDS)[number]))
  return [...pinned, ...rest]
}

type ShelfTabId = 'primary' | 'full-shows' | 'live' | 'replay'

function shelfTabStorageKey(category: CategoryId): string {
  return `jiyu.${category}.shelf-tab`
}

function readShelfTab(category: CategoryId, fallback: ShelfTabId): ShelfTabId {
  try {
    const raw = localStorage.getItem(shelfTabStorageKey(category))
    // Sports no longer has a Popular tab — migrate saved preference.
    if (category === 'sports' && raw === 'primary') return 'full-shows'
    if (raw === 'primary' || raw === 'full-shows' || raw === 'live' || raw === 'replay') {
      return raw
    }
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

function titleSortKey(a: StreamItem, b: StreamItem): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
}

/** User Sort menu — applied after each shelf’s natural order. */
function applyUserSort(items: StreamItem[], mode: SectionSortMode): StreamItem[] {
  if (mode === 'default' || items.length < 2) return items
  const next = [...items]
  if (mode === 'title') {
    next.sort(titleSortKey)
    return next
  }
  if (mode === 'newest') {
    next.sort((a, b) => {
      const date = releaseSortKey(b) - releaseSortKey(a)
      if (date !== 0) return date
      return titleSortKey(a, b)
    })
    return next
  }
  // popular — TMDB / YTS encode popularity in releasedAt on curated shelves
  next.sort((a, b) => {
    const rank = (b.releasedAt ?? 0) - (a.releasedAt ?? 0)
    if (rank !== 0) return rank
    return titleSortKey(a, b)
  })
  return next
}

function sortSectionItems(
  items: StreamItem[],
  torrentFirst: boolean,
  newestFirst: boolean,
  category: CategoryId,
  /** Popular Movies: keep YTS download-rank via releasedAt, not theatrical year. */
  sortMode: 'default' | 'rank' = 'default',
) {
  // TV Series can be 10k–20k web-catalog rows. Per-compare year regex +
  // localeCompare was hundreds of ms and made section switches feel frozen.
  if (category === 'series') {
    const keyed = items.map((item) => ({
      item,
      rank: sourceRank(item, torrentFirst),
      date: item.releasedAt ?? 0,
    }))
    keyed.sort((a, b) => {
      // TMDB / curated lists: popularity (or airing order) stored in releasedAt.
      if (sortMode === 'rank') {
        const date = b.date - a.date
        if (date !== 0) return date
        return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
      }
      const rank = a.rank - b.rank
      if (rank !== 0) return rank
      if (newestFirst) {
        const date = b.date - a.date
        if (date !== 0) return date
      }
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
    })
    return keyed.map((row) => row.item)
  }

  return [...items].sort((a, b) => {
    if (category === 'movies' && sortMode === 'rank') {
      const rank = (b.releasedAt ?? 0) - (a.releasedAt ?? 0)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }

    // Anime Full Shows (TMDB): popularity.desc via releasedAt.
    if (category === 'anime' && sortMode === 'rank') {
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
  // Kids Live is IPTV — never strip it when Hide IPTV is on for other shelves.
  // Anime / Movies no longer expose this toggle — don't apply a stale global pref.
  if (
    options.showSourceTools &&
    options.hideIptv &&
    options.categoryId !== 'kids' &&
    options.categoryId !== 'anime' &&
    options.categoryId !== 'movies'
  ) {
    next = next.filter((item) => !isIptvShelfItem(item))
  }
  const collapse = options.collapseEpisodes !== false
  if (collapse && (options.categoryId === 'series' || options.categoryId === 'anime')) {
    // Series web catalog rows are already show-level — skip the O(n) episode scan.
    if (options.categoryId === 'series') {
      /* no collapse */
    } else {
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
  }
  if (options.showSourceTools) {
    // Anime / Movies no longer expose source toggles — keep shelf default order.
    const torrentFirst =
      options.categoryId === 'anime' || options.categoryId === 'movies'
        ? true
        : options.torrentFirst
    next = sortSectionItems(
      next,
      torrentFirst,
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
  const { byCategory, ready, streamedSports, reloadTorrentCatalog } = useCatalog()
  const meta = CATEGORIES.find((c) => c.id === id)
  const saved = id ? getSectionView(id) : undefined
  const sentinelRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const showSourceTools = Boolean(meta && MIXED_SECTIONS.has(meta.id))

  const [query, setQuery] = useState(saved?.query ?? '')
  const [visible, setVisible] = useState(saved?.visible ?? PAGE)
  const [windowStart, setWindowStart] = useState(0)
  const [autoCheck, setAutoCheck] = useState(saved?.autoCheck ?? true)
  const [listReady, setListReady] = useState(false)
  const [focusPending, setFocusPending] = useState(Boolean(saved?.focusItemId))
  const [sourcePrefs, setSourcePrefsState] = useState(getSectionSourcePrefs)
  const [nyaaSearchStatus, setNyaaSearchStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  )
  const [nyaaSearchError, setNyaaSearchError] = useState('')
  const [movieSearchStatus, setMovieSearchStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  )
  const [movieSearchError, setMovieSearchError] = useState('')
  const categoryId = (meta?.id ?? 'series') as CategoryId
  const [shelfTab, setShelfTab] = useState<ShelfTabId>(() =>
    readShelfTab(
      categoryId,
      categoryId === 'sports'
        ? 'full-shows'
        : categoryId === 'anime' || categoryId === 'movies'
          ? 'primary'
          : 'full-shows',
    ),
  )
  const [sportsSportFilter, setSportsSportFilter] = useState(readSelectedSportsFilter)
  const userPickedShelfTabRef = useRef(false)
  const focusItemIdRef = useRef<string | undefined>(saved?.focusItemId)
  const pendingScrollAdjustRef = useRef(0)
  /** After a focused Back restore, skip scrollTop restore (window ≠ full list). */
  const usedFocusRestoreRef = useRef(Boolean(saved?.focusItemId))
  /** Avoid re-hitting Nyaa for the same empty query (failed / no shelf match). */
  const nyaaTriedQueryRef = useRef('')
  /** Avoid re-hitting YTS/Cinetaro for the same empty movie query. */
  const movieTriedQueryRef = useRef('')

  // Memoize — byCategory() returns a new array every call; sync status updates
  // were re-sorting the entire TV Series shelf on every page of EZTV sync.
  const items = useMemo(() => byCategory(categoryId), [byCategory, categoryId])
  const trackGrowth = Boolean(meta && isGrowthTrackedSection(meta.id))

  const targetVisibleRef = useRef(PAGE)

  useEffect(() => {
    // Remounting the same section (click a title → Back) must keep *some* of the
    // saved window for scroll restore — but never thousands of cards. YMovies-scale
    // shelves made Movies → TV Series take 5–7s while React mounted the old depth.
    userPickedShelfTabRef.current = false
    setShelfTab(readShelfTab(categoryId, categoryId === 'sports' ? 'full-shows' : 'primary'))
    setWindowStart(0)
    pendingScrollAdjustRef.current = 0
    const savedView = getSectionView(categoryId)
    const focusId = savedView?.focusItemId
    focusItemIdRef.current = focusId
    usedFocusRestoreRef.current = Boolean(focusId)
    setFocusPending(Boolean(focusId))
    if (focusId) {
      // Windowed restore runs once the shelf list is ready — mount a small slice only.
      targetVisibleRef.current = FOCUS_WINDOW
      setVisible(FOCUS_WINDOW)
    } else {
      const savedVisible = Math.max(savedView?.visible ?? PAGE, PAGE)
      const eager = Math.min(savedVisible, MAX_EAGER_VISIBLE)
      targetVisibleRef.current = eager
      setVisible(Math.min(eager, INITIAL_VISIBLE_CAP))
    }
    setQuery(savedView?.query ?? '')
    setAutoCheck(savedView?.autoCheck ?? true)
  }, [categoryId])

  // Grow only until the saved scroll position fits (capped) — infinite scroll
  // loads anything deeper when the user actually scrolls.
  useEffect(() => {
    if (!listReady || focusPending) return
    const target = targetVisibleRef.current
    const savedScroll = getMainScroll(`/section/${categoryId}`) ?? 0
    if (savedScroll <= 0) return
    let cancelled = false
    let raf = 0

    const bump = () => {
      if (cancelled) return
      setVisible((v) => {
        if (v >= target) return v
        const stage = getMainStage()
        if (stage) {
          const need = savedScroll + stage.clientHeight + 600
          if (stage.scrollHeight >= need) return v
        }
        const next = Math.min(v + INITIAL_VISIBLE_CAP, target)
        if (next < target) raf = window.requestAnimationFrame(bump)
        return next
      })
    }
    raf = window.requestAnimationFrame(bump)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(raf)
    }
  }, [listReady, categoryId, focusPending])

  const shelfOpts = useMemo(
    () => ({
      categoryId,
      showSourceTools,
      hideIptv: sourcePrefs.hideIptv,
      torrentFirst: sourcePrefs.torrentFirst,
      // Shelf natural order; user Sort menu overrides after prepareShelfList.
      newestFirst: true,
    }),
    [categoryId, showSourceTools, sourcePrefs],
  )

  const showSortMenu =
    categoryId === 'anime' || categoryId === 'series' || categoryId === 'movies'
  const [userSortMode, setUserSortMode] = useState<SectionSortMode>(() =>
    getSectionSortMode(categoryId, shelfTab),
  )

  useEffect(() => {
    setUserSortMode(getSectionSortMode(categoryId, shelfTab))
  }, [categoryId, shelfTab])

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
        // Full Shows are show hubs / TMDB — never collapse single-ep magnets here.
        { ...shelfOpts, sortMode: 'rank', collapseEpisodes: false },
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
        liveLabel: undefined as string | undefined,
        primaryBlurb: '',
        fullBlurb: '',
        liveBlurb: undefined as string | undefined,
        primaryEmpty: 'No new releases yet — sync the anime website in Library.',
        fullEmpty: 'No full shows yet — sync TMDB Anime Full Shows or SubsPlease in Library.',
        liveEmpty: undefined as string | undefined,
        primary,
        fullShows,
        live: undefined as StreamItem[] | undefined,
        other,
      }
    }

    // Series: Popular / Airing / Trending / 24/7 (PPV always-on cartoons).
    if (categoryId === 'series') {
      const primary = prepareShelfList(
        items.filter((item) => isSeriesPopularItem(item) && match(item)),
        { ...shelfOpts, sortMode: 'rank' },
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isSeriesAiringItem(item) && match(item)),
        { ...shelfOpts, newestFirst: true },
      )
      const live = prepareShelfList(
        items.filter((item) => isSeriesTrendingItem(item) && match(item)),
        { ...shelfOpts, sortMode: 'rank' },
      )
      const replay = prepareShelfList(
        items.filter((item) => isSeries247Item(item) && match(item)),
        shelfOpts,
      )
      const other = prepareShelfList(
        items.filter(
          (item) =>
            !isSeriesPopularItem(item) &&
            !isSeriesAiringItem(item) &&
            !isSeriesTrendingItem(item) &&
            !isSeries247Item(item) &&
            match(item),
        ),
        shelfOpts,
      )
      return {
        primaryLabel: 'Popular',
        fullLabel: 'Airing',
        liveLabel: 'Trending',
        replayLabel: '24/7',
        primaryBlurb: '',
        fullBlurb: '',
        liveBlurb: '',
        replayBlurb: '',
        primaryEmpty: 'No popular series yet — sync TMDB · TV Series in Library.',
        fullEmpty: 'No airing series yet — sync TMDB · TV Series in Library.',
        liveEmpty: 'No trending series yet — sync TMDB · TV Series in Library.',
        replayEmpty: 'No 24/7 series streams right now.',
        primary,
        fullShows,
        live,
        replay,
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
        liveLabel: undefined as string | undefined,
        primaryBlurb: '',
        fullBlurb: '',
        liveBlurb: undefined as string | undefined,
        primaryEmpty: 'No popular movies yet — sync the movies website in Library.',
        fullEmpty: 'No new movies yet — sync the movies website in Library.',
        liveEmpty: undefined as string | undefined,
        primary,
        fullShows,
        live: undefined as StreamItem[] | undefined,
        other,
      }
    }

    if (categoryId === 'kids') {
      const primary = prepareShelfList(
        items.filter((item) => isKidsMovieItem(item) && match(item)),
        { ...shelfOpts, newestFirst: true },
      )
      const fullShows = prepareShelfList(
        items.filter((item) => isKidsShowItem(item) && match(item)),
        shelfOpts,
      )
      const live = prepareShelfList(
        items.filter((item) => isKidsLiveItem(item) && match(item)),
        shelfOpts,
      )
      const other = prepareShelfList(
        items.filter(
          (item) =>
            !isKidsMovieItem(item) &&
            !isKidsShowItem(item) &&
            !isKidsLiveItem(item) &&
            match(item),
        ),
        shelfOpts,
      )
      return {
        primaryLabel: 'Movies',
        fullLabel: 'Shows',
        liveLabel: 'Live',
        primaryBlurb: '',
        fullBlurb: '',
        liveBlurb: '',
        primaryEmpty: 'No Kids movies yet — sync YTS in Library (Family / Animation).',
        fullEmpty: 'No Kids shows yet — sync TMDB · Kids Shows in Library (or wait for auto-sync).',
        liveEmpty: 'No Kids live channels yet — IPTV-Org Kids imports on first launch.',
        primary,
        fullShows,
        live,
        other,
      }
    }

    if (categoryId === 'sports') {
      const sportOk = (item: StreamItem) => {
        if (sportsSportFilter === 'all') return true
        if (isLivextvReplayCatalogItem(item)) {
          return livextvReplaySportId(item) === sportsSportFilter
        }
        if (isStreamedCatalogItem(item)) {
          return streamedItemSportId(item) === sportsSportFilter
        }
        if (isPpvStCatalogItem(item)) {
          const needle = sportsSportFilter.toLowerCase()
          return Boolean(
            item.tags?.some((t) => {
              const tag = String(t || '').toLowerCase()
              return (
                tag === needle ||
                tag.replace(/-/g, '') === needle.replace(/-/g, '') ||
                tag.includes(needle)
              )
            }),
          )
        }
        return true
      }
      const liveAll = prepareShelfList(
        items.filter(
          (item) =>
            (isStreamedCatalogItem(item) || isPpvStCatalogItem(item)) &&
            sportOk(item) &&
            match(item),
        ),
        shelfOpts,
      )
      const replay = prepareShelfList(
        items.filter(
          (item) => isLivextvReplayCatalogItem(item) && sportOk(item) && match(item),
        ),
        { ...shelfOpts, newestFirst: true, collapseEpisodes: false },
      )
      const channels = pinSportsShortcuts(
        prepareShelfList(
          items.filter(
            (item) =>
              !isStreamedCatalogItem(item) &&
              !isPpvStCatalogItem(item) &&
              !isLivextvReplayCatalogItem(item) &&
              match(item),
          ),
          shelfOpts,
        ),
        'sports',
      )
      return {
        // Popular tab removed — primary stays empty so Live is the first sports shelf.
        primaryLabel: 'Popular',
        fullLabel: 'Live',
        liveLabel: 'Channels',
        replayLabel: 'Replay',
        primaryBlurb: '',
        fullBlurb: '',
        liveBlurb: '',
        replayBlurb: '',
        primaryEmpty: '',
        fullEmpty: 'No live matches right now — Streamed / PPV.st refresh automatically.',
        liveEmpty: 'No sports channels yet — IPTV sports playlist imports on first launch.',
        replayEmpty:
          'No recent football, boxing, cricket, or motorsport replays (last 3 days).',
        primary: [] as StreamItem[],
        fullShows: liveAll,
        live: channels,
        replay,
        other: [] as StreamItem[],
      }
    }

    return null
  }, [items, query, categoryId, shelfOpts, sportsSportFilter])

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
          { ...shelfOpts, sortMode: 'rank' },
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
          items.filter((item) => isSeriesPopularItem(item)),
          { ...shelfOpts, sortMode: 'rank' },
        ),
        ...prepareShelfList(
          items.filter((item) => isSeriesAiringItem(item)),
          { ...shelfOpts, newestFirst: true },
        ),
        ...prepareShelfList(
          items.filter((item) => isSeriesTrendingItem(item)),
          { ...shelfOpts, sortMode: 'rank' },
        ),
        ...prepareShelfList(
          items.filter((item) => isSeries247Item(item)),
          shelfOpts,
        ),
        ...prepareShelfList(
          items.filter(
            (item) =>
              !isSeriesPopularItem(item) &&
              !isSeriesAiringItem(item) &&
              !isSeriesTrendingItem(item) &&
              !isSeries247Item(item),
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
    if (categoryId === 'kids') {
      return [
        ...prepareShelfList(
          items.filter((item) => isKidsMovieItem(item)),
          { ...shelfOpts, newestFirst: true },
        ),
        ...prepareShelfList(
          items.filter((item) => isKidsShowItem(item)),
          shelfOpts,
        ),
        ...prepareShelfList(
          items.filter((item) => isKidsLiveItem(item)),
          shelfOpts,
        ),
        ...prepareShelfList(
          items.filter(
            (item) =>
              !isKidsMovieItem(item) && !isKidsShowItem(item) && !isKidsLiveItem(item),
          ),
          shelfOpts,
        ),
      ]
    }
    if (categoryId === 'sports') {
      return [
        ...prepareShelfList(
          items.filter((item) => isStreamedCatalogItem(item) || isPpvStCatalogItem(item)),
          shelfOpts,
        ),
        ...pinSportsShortcuts(
          prepareShelfList(
            items.filter(
              (item) => !isStreamedCatalogItem(item) && !isPpvStCatalogItem(item),
            ),
            shelfOpts,
          ),
          'sports',
        ),
      ]
    }
    return pinSportsShortcuts(prepareShelfList(items, shelfOpts), categoryId)
  }, [items, categoryId, shelfOpts])

  const filtered = useMemo(() => {
    if (splitShelves) {
      return [...splitShelves.primary, ...splitShelves.fullShows, ...splitShelves.other]
    }
    const q = query.trim().toLowerCase()
    if (!q) return shelfItems
    return shelfItems.filter((item) => matchesSectionQuery(item, q))
  }, [shelfItems, query, splitShelves])

  /** Anime shelf search found nothing in the local catalog — try Nyaa. */
  const animeCatalogSearchEmpty = useMemo(() => {
    if (categoryId !== 'anime') return false
    if (!query.trim()) return false
    if (!splitShelves) return false
    return (
      splitShelves.primary.length === 0 &&
      splitShelves.fullShows.length === 0 &&
      splitShelves.other.length === 0
    )
  }, [categoryId, query, splitShelves])

  useEffect(() => {
    if (categoryId !== 'anime') {
      setNyaaSearchStatus('idle')
      setNyaaSearchError('')
      nyaaTriedQueryRef.current = ''
      return
    }
    const q = query.trim()
    if (!q || !animeCatalogSearchEmpty) {
      if (!q) nyaaTriedQueryRef.current = ''
      setNyaaSearchStatus('idle')
      setNyaaSearchError('')
      return
    }
    if (nyaaTriedQueryRef.current === q) return

    let cancelled = false
    setNyaaSearchStatus('loading')
    setNyaaSearchError('')
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await searchNyaaAnimeForShelf(q)
        if (cancelled) return
        if (!result.ok) {
          nyaaTriedQueryRef.current = q
          setNyaaSearchStatus('error')
          setNyaaSearchError(result.error || 'Nyaa search failed')
          return
        }
        try {
          await upsertTorrentItems([...result.episodes, ...result.shows])
          await reloadTorrentCatalog()
          if (cancelled) return
          setNyaaSearchStatus('done')
          // Show hubs land on Full Shows — switch so the user sees them.
          userPickedShelfTabRef.current = true
          setShelfTab('full-shows')
          setWindowStart(0)
          targetVisibleRef.current = PAGE
          setVisible(PAGE)
          // If catalog still doesn't surface matches, don't hammer Nyaa.
          nyaaTriedQueryRef.current = q
        } catch (err) {
          if (cancelled) return
          nyaaTriedQueryRef.current = q
          setNyaaSearchStatus('error')
          setNyaaSearchError(err instanceof Error ? err.message : 'Could not save Nyaa results')
        }
      })()
    }, 420)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [categoryId, query, animeCatalogSearchEmpty, reloadTorrentCatalog])

  /** Live movie search when the active tab has no title that contains the query. */
  const moviesCatalogSearchEmpty = useMemo(() => {
    if (categoryId !== 'movies') return false
    const q = query.trim().toLowerCase()
    if (!q || !splitShelves) return false
    const onTab =
      shelfTab === 'primary'
        ? splitShelves.primary
        : [...splitShelves.fullShows, ...splitShelves.other]
    return !onTab.some((item) => item.title.toLowerCase().includes(q))
  }, [categoryId, query, splitShelves, shelfTab])

  const moviesSearchTarget: MoviesShelfTarget =
    shelfTab === 'primary' ? 'popular' : 'new'

  useEffect(() => {
    if (categoryId !== 'movies') {
      setMovieSearchStatus('idle')
      setMovieSearchError('')
      movieTriedQueryRef.current = ''
      return
    }
    const q = query.trim()
    if (!q || !moviesCatalogSearchEmpty) {
      if (!q) {
        movieTriedQueryRef.current = ''
      }
      if (!moviesCatalogSearchEmpty) {
        setMovieSearchStatus('idle')
        setMovieSearchError('')
      }
      return
    }
    // Re-run when the user switches tabs with the same query (Popular vs New).
    const tryKey = `${q}::${moviesSearchTarget}`
    if (movieTriedQueryRef.current === tryKey) return

    let cancelled = false
    setMovieSearchStatus('loading')
    setMovieSearchError('')
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await searchMoviesForShelf(q, moviesSearchTarget)
        if (cancelled) return
        if (!result.ok) {
          movieTriedQueryRef.current = tryKey
          setMovieSearchStatus('error')
          setMovieSearchError(result.error || 'Movie search failed')
          return
        }
        try {
          await upsertTorrentItems(result.movies)
          await reloadTorrentCatalog()
          if (cancelled) return
          setMovieSearchStatus('done')
          // Keep the tab the user searched on — hits are tagged for that shelf.
          setWindowStart(0)
          targetVisibleRef.current = PAGE
          setVisible(PAGE)
          movieTriedQueryRef.current = tryKey
        } catch (err) {
          if (cancelled) return
          movieTriedQueryRef.current = tryKey
          setMovieSearchStatus('error')
          setMovieSearchError(
            err instanceof Error ? err.message : 'Could not save movie search results',
          )
        }
      })()
    }, 420)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    categoryId,
    query,
    moviesCatalogSearchEmpty,
    moviesSearchTarget,
    reloadTorrentCatalog,
  ])
  const [growth, setGrowth] = useState<SectionGrowth | null>(null)
  const [newTitlesKind, setNewTitlesKind] = useState<NewTitlesKind | null>(null)

  useEffect(() => {
    if (!ready || !trackGrowth) {
      setGrowth(null)
      return
    }
    setGrowth(
      recordSectionTitleCount(
        categoryId,
        shelfItems.length,
        shelfItems.map((i) => ({ id: i.id, releasedAt: i.releasedAt })),
      ),
    )
  }, [ready, trackGrowth, categoryId, shelfItems.length, shelfItems])

  const newTitleItems = useMemo(() => {
    if (!newTitlesKind || !growth) return []
    const limit =
      newTitlesKind === 'sinceYesterday'
        ? Math.max(0, growth.delta ?? 0)
        : Math.max(0, growth.newToday)
    return sectionNewTitleItems(categoryId, shelfItems, newTitlesKind, limit > 0 ? limit : undefined)
  }, [newTitlesKind, categoryId, shelfItems, growth])

  const growthLine = growth ? formatSectionGrowth(growth) : null

  const hasShelfTabs = Boolean(
    splitShelves &&
      (splitShelves.primary.length > 0 ||
        splitShelves.fullShows.length > 0 ||
        (splitShelves.live?.length ?? 0) > 0 ||
        (splitShelves.replay?.length ?? 0) > 0 ||
        splitShelves.other.length > 0),
  )

  // On first load only: if the saved primary tab is empty, land on Full Shows.
  // Never bounce after the user explicitly picks a tab.
  useEffect(() => {
    if (!splitShelves || userPickedShelfTabRef.current) return
    if (shelfTab === 'primary' && splitShelves.primary.length === 0) {
      if (splitShelves.fullShows.length > 0) {
        setShelfTab('full-shows')
      } else if ((splitShelves.live?.length ?? 0) > 0) {
        setShelfTab('live')
      } else if (splitShelves.other.length > 0) {
        setShelfTab('full-shows')
      }
    }
  }, [splitShelves, shelfTab])

  function selectShelfTab(tab: ShelfTabId) {
    userPickedShelfTabRef.current = true
    setShelfTab(tab)
    // Replay sport chips differ from Live — always land on All sports.
    if (categoryId === 'sports' && tab === 'replay') {
      setSportsSportFilter('all')
      writeSelectedSportsFilter('all')
    }
    setWindowStart(0)
    targetVisibleRef.current = PAGE
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
    if (shelfTab === 'live') return splitShelves.live ?? []
    if (shelfTab === 'replay') return splitShelves.replay ?? []
    if (categoryId === 'kids' || categoryId === 'sports') return splitShelves.fullShows
    return [...splitShelves.fullShows, ...splitShelves.other]
  }, [splitShelves, shelfTab, categoryId])

  const sportsFilterChips = useMemo(() => {
    if (categoryId !== 'sports') return []
    if (shelfTab === 'replay') {
      return livextvReplaySportChipsFromItems(items)
    }
    const byId = new Map<string, string>()
    const liveSportIds = new Set(
      items
        .filter((item) => isStreamedCatalogItem(item))
        .map((item) => streamedItemSportId(item))
        .filter((id): id is string => Boolean(id)),
    )
    for (const sport of streamedSports) {
      if (!liveSportIds.has(sport.id)) continue
      byId.set(sport.id, sport.name)
    }
    for (const chip of ppvStSportChipsFromItems(items)) {
      if (!byId.has(chip.id)) byId.set(chip.id, chip.name)
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [categoryId, items, streamedSports, shelfTab])

  function selectSportsSportFilter(sportId: string) {
    setSportsSportFilter(sportId)
    writeSelectedSportsFilter(sportId)
    setWindowStart(0)
    targetVisibleRef.current = PAGE
    setVisible(PAGE)
  }

  const pagedList = useMemo(() => {
    const base = activeShelfList ?? filtered
    if (!showSortMenu) return base
    return applyUserSort(base, userSortMode)
  }, [activeShelfList, filtered, showSortMenu, userSortMode])

  /** Football chip → group Live / Replay into EPL, Bundesliga, … */
  const footballLeagueShelves = useMemo(() => {
    if (categoryId !== 'sports') return null
    if (sportsSportFilter !== 'football') return null
    if (shelfTab !== 'full-shows' && shelfTab !== 'replay') {
      return null
    }
    const shelves = groupFootballByLeague(pagedList)
    return shelves.length > 0 ? shelves : null
  }, [categoryId, sportsSportFilter, shelfTab, pagedList])

  function updateUserSortMode(mode: SectionSortMode) {
    setUserSortMode(mode)
    setSectionSortMode(categoryId, shelfTab, mode)
    setWindowStart(0)
    targetVisibleRef.current = PAGE
    setVisible(PAGE)
  }

  // Place a focused card in a small window instead of remounting 0…index.
  useEffect(() => {
    if (!focusPending || !listReady) return
    const focusId = focusItemIdRef.current
    if (!focusId) {
      setFocusPending(false)
      return
    }
    const index = pagedList.findIndex((item) => item.id === focusId)
    if (index < 0) {
      clearSectionFocusItem(categoryId)
      focusItemIdRef.current = undefined
      usedFocusRestoreRef.current = false
      setFocusPending(false)
      return
    }
    const start = Math.max(0, index - 16)
    setWindowStart(start)
    const windowSize = Math.min(FOCUS_WINDOW, Math.max(pagedList.length - start, 1))
    targetVisibleRef.current = windowSize
    setVisible(windowSize)
  }, [focusPending, listReady, pagedList.length, categoryId, shelfTab])

  useLayoutEffect(() => {
    if (!focusPending || !listReady) return
    const focusId = focusItemIdRef.current
    if (!focusId) return
    const el = document.querySelector(
      `.media-card-wrap[data-item-id="${CSS.escape(focusId)}"]`,
    ) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    clearSectionFocusItem(categoryId)
    focusItemIdRef.current = undefined
    setFocusPending(false)
  }, [focusPending, listReady, windowStart, visible, categoryId])

  useLayoutEffect(() => {
    const delta = pendingScrollAdjustRef.current
    if (!delta) return
    pendingScrollAdjustRef.current = 0
    const stage = getMainStage()
    if (stage) stage.scrollTop += delta
  }, [windowStart])

  const effectiveVisible = Math.min(
    Math.max(visible, focusPending ? FOCUS_WINDOW : PAGE),
    Math.max(pagedList.length - windowStart, focusPending ? FOCUS_WINDOW : PAGE),
  )
  const shown = pagedList.slice(windowStart, windowStart + effectiveVisible)
  const remaining = pagedList.length - windowStart - shown.length
  const stageWidth = getMainStage()?.clientWidth ?? 960
  const topSpacerPx = estimateCatalogSpacerPx(windowStart, Math.max(320, stageWidth - 48))

  useEffect(() => {
    if (!id) return
    const prev = getSectionView(id)
    setSectionView(id, {
      query,
      visible: windowStart + effectiveVisible,
      autoCheck,
      focusItemId: prev?.focusItemId,
    })
  }, [id, query, effectiveVisible, autoCheck, windowStart])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || remaining <= 0) return

    const root = getMainStage()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setVisible((v) => Math.min(v + PAGE, pagedList.length - windowStart))
      },
      {
        root: root ?? null,
        rootMargin: '400px 0px',
        threshold: 0,
      },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [remaining, pagedList.length, shown.length, id, windowStart])

  // When the list was windowed for focus restore, scroll-up loads earlier titles.
  useEffect(() => {
    const top = topSentinelRef.current
    if (!top || windowStart <= 0) return
    const root = getMainStage()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setWindowStart((start) => {
          if (start <= 0) return start
          const next = Math.max(0, start - PAGE)
          const width = Math.max(320, (getMainStage()?.clientWidth ?? 960) - 48)
          pendingScrollAdjustRef.current =
            estimateCatalogSpacerPx(start, width) - estimateCatalogSpacerPx(next, width)
          setVisible((v) => v + (start - next))
          return next
        })
      },
      {
        root: root ?? null,
        rootMargin: '200px 0px',
        threshold: 0,
      },
    )
    observer.observe(top)
    return () => observer.disconnect()
  }, [windowStart, id])

  useEffect(() => {
    if (!ready || !meta) {
      setListReady(false)
      return
    }
    const frame = requestAnimationFrame(() => setListReady(true))
    return () => cancelAnimationFrame(frame)
  }, [ready, meta, shown.length, id])

  useMainScrollRestore(
    id ? `/section/${id}` : '',
    listReady && !focusPending && !usedFocusRestoreRef.current,
  )

  function updateSourcePrefs(patch: Partial<typeof sourcePrefs>) {
    const next = { ...sourcePrefs, ...patch }
    setSourcePrefsState(next)
    setSectionSourcePrefs(next)
    setWindowStart(0)
    targetVisibleRef.current = PAGE
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
                <button
                  type="button"
                  className={`growth-hit section-growth-up${growth.delta <= 0 ? ' is-disabled' : ''}`}
                  disabled={growth.delta <= 0}
                  onClick={() => (growth.delta ?? 0) > 0 && setNewTitlesKind('sinceYesterday')}
                >
                  {' '}
                  ({growth.delta > 0 ? '+' : ''}
                  {growth.delta.toLocaleString()} since yesterday)
                </button>
              ) : (
                <span className="section-growth-flat"> (no new titles since yesterday)</span>
              )
            ) : growth.newToday > 0 ? (
              <button
                type="button"
                className="growth-hit section-growth-up"
                onClick={() => setNewTitlesKind('today')}
              >
                {' '}
                (+{growth.newToday.toLocaleString()} new today)
              </button>
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

      {newTitlesKind ? (
        <NewTitlesDialog
          title={
            newTitlesKind === 'sinceYesterday'
              ? `New in ${meta.label} since yesterday`
              : `New in ${meta.label} today`
          }
          items={newTitleItems}
          onClose={() => setNewTitlesKind(null)}
        />
      ) : null}

      {isVodCategory(meta.id) && (
        <ContinueWatching category={meta.id} variant="section" />
      )}

      {meta.id === 'sports' ? <FavoriteTeamsEditor /> : null}

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
        {(meta.id === 'sports'
          ? shelfTab === 'live'
          : !showSourceTools || (meta.id === 'kids' && shelfTab === 'live')) && (
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
            {meta.id !== 'kids' &&
              meta.id !== 'series' &&
              meta.id !== 'anime' &&
              meta.id !== 'movies' && (
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.hideIptv}
                  onChange={(e) => updateSourcePrefs({ hideIptv: e.target.checked })}
                />
                Hide IPTV
              </label>
            )}
            {meta.id !== 'series' && meta.id !== 'anime' && meta.id !== 'movies' && (
            <label className="check-toggle tool-toggle">
              <input
                type="checkbox"
                checked={sourcePrefs.torrentFirst}
                onChange={(e) => updateSourcePrefs({ torrentFirst: e.target.checked })}
              />
              Websites first
            </label>
            )}
          </>
        )}
        {showSortMenu && (
          <label className="sort-select tool-toggle">
            <span>Sort</span>
            <select
              value={userSortMode}
              onChange={(e) => updateUserSortMode(e.target.value as SectionSortMode)}
              aria-label="Sort titles"
            >
              <option value="default">Shelf default</option>
              <option value="newest">Newest</option>
              <option value="title">A–Z</option>
              <option value="popular">Popular</option>
            </select>
          </label>
        )}
      </div>
      {categoryId === 'movies' && query.trim() && movieSearchStatus === 'loading' ? (
        <p className="fine-print section-search-status">Searching for “{query.trim()}”…</p>
      ) : null}
      {categoryId === 'movies' && query.trim() && movieSearchStatus === 'error' ? (
        <p className="fine-print section-search-status">{movieSearchError}</p>
      ) : null}

      {hasShelfTabs && splitShelves ? (
        <section className="section-block anime-shelf-block">
          <div className="section-head anime-shelf-head">
            <div
              className="anime-shelf-tabs"
              role="tablist"
              aria-label={`${meta.label} shelves`}
            >
              {categoryId !== 'sports' ? (
                <button
                  type="button"
                  role="tab"
                  className={`anime-shelf-tab${shelfTab === 'primary' ? ' is-active' : ''}`}
                  aria-selected={shelfTab === 'primary'}
                  onClick={() => selectShelfTab('primary')}
                >
                  {splitShelves.primaryLabel}
                </button>
              ) : null}
              <button
                type="button"
                role="tab"
                className={`anime-shelf-tab${shelfTab === 'full-shows' ? ' is-active' : ''}`}
                aria-selected={shelfTab === 'full-shows'}
                onClick={() => selectShelfTab('full-shows')}
              >
                {splitShelves.fullLabel}
              </button>
              {splitShelves.liveLabel ? (
                <button
                  type="button"
                  role="tab"
                  className={`anime-shelf-tab${shelfTab === 'live' ? ' is-active' : ''}`}
                  aria-selected={shelfTab === 'live'}
                  onClick={() => selectShelfTab('live')}
                >
                  {splitShelves.liveLabel}
                </button>
              ) : null}
              {splitShelves.replayLabel ? (
                <button
                  type="button"
                  role="tab"
                  className={`anime-shelf-tab${shelfTab === 'replay' ? ' is-active' : ''}`}
                  aria-selected={shelfTab === 'replay'}
                  onClick={() => selectShelfTab('replay')}
                >
                  {splitShelves.replayLabel}
                </button>
              ) : null}
            </div>
            {categoryId === 'sports' &&
            sportsFilterChips.length > 0 &&
            (shelfTab === 'full-shows' || shelfTab === 'replay') ? (
              <div
                className="anime-shelf-tabs sports-sport-filters"
                role="toolbar"
                aria-label="Filter by sport"
              >
                <button
                  type="button"
                  className={`anime-shelf-tab${sportsSportFilter === 'all' ? ' is-active' : ''}`}
                  aria-pressed={sportsSportFilter === 'all'}
                  onClick={() => selectSportsSportFilter('all')}
                >
                  All sports
                </button>
                {sportsFilterChips.map((sport) => (
                  <button
                    key={sport.id}
                    type="button"
                    className={`anime-shelf-tab${
                      sportsSportFilter === sport.id ? ' is-active' : ''
                    }`}
                    aria-pressed={sportsSportFilter === sport.id}
                    onClick={() => selectSportsSportFilter(sport.id)}
                  >
                    {sport.name}
                  </button>
                ))}
              </div>
            ) : null}
            {((shelfTab === 'primary'
              ? splitShelves.primaryBlurb
              : shelfTab === 'live'
                ? splitShelves.liveBlurb
                : splitShelves.fullBlurb) || ''
            ).trim() ? (
              <p>
                {shelfTab === 'primary'
                  ? splitShelves.primaryBlurb
                  : shelfTab === 'live'
                    ? splitShelves.liveBlurb
                    : splitShelves.fullBlurb}
                <span className="count-chip">{pagedList.length.toLocaleString()}</span>
              </p>
            ) : null}
          </div>
          {windowStart > 0 && !footballLeagueShelves ? (
            <div
              ref={topSentinelRef}
              className="catalog-window-spacer"
              style={{ height: topSpacerPx }}
              aria-hidden
            />
          ) : null}
          {footballLeagueShelves ? (
            <div className="football-league-shelves">
              {footballLeagueShelves.map((shelf) => (
                <section key={shelf.id} className="football-league-shelf" aria-label={shelf.label}>
                  <h2 className="football-league-heading">
                    {shelf.label}
                    <span className="count-chip">{shelf.items.length.toLocaleString()}</span>
                  </h2>
                  <CatalogGrid
                    items={shelf.items}
                    autoCheck={false}
                    showHealthFilters={false}
                    autoHideUnresponsive={false}
                    emptyHint={`No ${shelf.label} matches right now.`}
                  />
                </section>
              ))}
            </div>
          ) : (
            <CatalogGrid
              items={shown}
              autoCheck={
                (categoryId === 'kids' || categoryId === 'sports') && shelfTab === 'live'
                  ? autoCheck
                  : false
              }
              showHealthFilters={
                (categoryId === 'kids' || categoryId === 'sports') && shelfTab === 'live'
              }
              autoHideUnresponsive={false}
              emptyHint={
                categoryId === 'anime' && query.trim() && animeCatalogSearchEmpty
                  ? nyaaSearchStatus === 'loading'
                    ? `Searching for “${query.trim()}”…`
                    : nyaaSearchStatus === 'error'
                      ? nyaaSearchError || 'No results for this search.'
                      : 'No matching titles — try another search.'
                  : categoryId === 'movies' && query.trim()
                    ? movieSearchStatus === 'loading'
                      ? `Searching for “${query.trim()}”…`
                      : movieSearchStatus === 'error'
                        ? movieSearchError || 'No movie results for this search.'
                        : moviesCatalogSearchEmpty
                          ? 'No movie results for this search.'
                          : shelfTab === 'primary'
                            ? splitShelves.primaryEmpty
                            : splitShelves.fullEmpty
                    : shelfTab === 'primary'
                      ? splitShelves.primaryEmpty
                      : shelfTab === 'live'
                        ? (splitShelves.liveEmpty ?? splitShelves.fullEmpty)
                        : shelfTab === 'replay'
                          ? (splitShelves.replayEmpty ?? splitShelves.fullEmpty)
                          : splitShelves.fullEmpty
              }
            />
          )}
        </section>
      ) : (
        <>
          {windowStart > 0 ? (
            <div
              ref={topSentinelRef}
              className="catalog-window-spacer"
              style={{ height: topSpacerPx }}
              aria-hidden
            />
          ) : null}
          <CatalogGrid
            items={shown}
            autoCheck={showSourceTools ? false : autoCheck}
            showHealthFilters={!showSourceTools}
            autoHideUnresponsive={!showSourceTools}
            emptyHint={
              categoryId === 'series'
                ? 'No shows yet. Import a playlist in Library to fill this shelf.'
                : `No ${meta.label.toLowerCase()} titles yet. Import a playlist in Library to fill this shelf.`
            }
          />
        </>
      )}
      {remaining > 0 && !footballLeagueShelves && (
        <div ref={sentinelRef} className="infinite-scroll-sentinel" aria-hidden>
          <p className="fine-print">
            Showing {(windowStart + shown.length).toLocaleString()} of{' '}
            {pagedList.length.toLocaleString()} — scroll for more
          </p>
        </div>
      )}
    </div>
  )
}
