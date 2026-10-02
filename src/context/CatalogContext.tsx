import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { BUILTIN_CATALOG } from '../data/catalog'
import { DEFAULT_PLAYLISTS } from '../data/defaultPlaylists'
import { normalizeIptvPlaylistUrl } from '../lib/iptv'
import { fetchRemotePlaylistContent } from '../lib/playlistFetch'
import {
  getEnglishOnlyPref,
  isLikelyEnglish,
  setEnglishOnlyPref,
  shouldApplyEnglishFilter,
} from '../lib/language'
import { dedupeStreams, getHideDuplicatesPref, setHideDuplicatesPref } from '../lib/dedupe'
import { countM3UEntries, parseM3U } from '../lib/m3u'
import { POPULAR_NEWS_LIMIT, preparePlaylistContent } from '../lib/popularNews'
import {
  clearPlaylistSources,
  deletePlaylistSource,
  listPlaylistSources,
  migrateLegacyPlaylist,
  newSourceId,
  putPlaylistSource,
  type PlaylistKind,
  type PlaylistSource,
} from '../lib/playlistStore'
import { appendActivity } from '../lib/activityLog'
import { maskActivityMessage } from '../lib/sourceMask'
import { listTorrentCatalog, loadTorrentCatalogMeta } from '../lib/torrentCatalogStore'
import {
  filterShelfVisibleItems,
  isEztvSource,
  isM2BoxUrl,
  isCinetaroUrl,
  isSeriesWebCatalogItem,
  isSubsPleaseUrl,
  isZenoxUrl,
  isYtsSource,
  loadTorrentSources,
  TORRENT_SOURCES_CHANGED,
} from '../lib/torrents'
import {
  isTmdbAnimeFullFeedUrl,
  isTmdbKidsShowsFeedUrl,
  isTmdbTvFeedUrl,
  TMDB_ANIME_SOURCE_ID,
  TMDB_KIDS_SOURCE_ID,
  TMDB_TV_SOURCE_ID,
} from '../lib/tmdbTv'
import { ZENOX_SOURCE_ID } from '../lib/zenox'
import {
  TORRENT_SCRAPER_VERSION,
  syncAllTorrentSources,
  syncTorrentSource,
  type TorrentSyncProgress,
} from '../lib/torrentSync'
import {
  enqueueTorrentSyncTask,
  getTorrentSyncControlState,
} from '../lib/torrentSyncControl'
import {
  bindBackgroundSyncResume,
  clearSyncJob,
  onCatalogSyncResumeRequested,
  pendingSyncSourceIds,
} from '../lib/backgroundSync'
import { clearTorrentSyncStatus, setTorrentSyncMessage } from '../lib/torrentSyncStatus'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import {
  fetchStreamedLiveMatches,
  fetchStreamedSports,
  mergeStreamedLiveCatalog,
  type StreamedSport,
} from '../lib/streamed'
import { fetchPpvStLiveCatalog } from '../lib/ppvSt'
import { fetchLivextvReplayCatalog, isLivextvReplayCatalogItem } from '../lib/livextvReplays'
import {
  fetchFullmatchShowsReplayCatalog,
  isFullmatchShowsCatalogItem,
} from '../lib/fullmatchShows'

function setSyncProgressMessage(message: string, percent: number | null): void {
  // Keep the frozen "Paused · …" line — don't advance counts while parked.
  if (getTorrentSyncControlState().paused) return
  setTorrentSyncMessage(message, percent)
}
import type { CategoryId, StreamItem } from '../types'

export interface AddPlaylistInput {
  kind: PlaylistKind
  label: string
  content: string
  url?: string
  /** If true, replace an existing source with the same URL instead of skipping */
  replaceExisting?: boolean
}

interface CatalogContextValue {
  ready: boolean
  items: StreamItem[]
  importedCount: number
  torrentCount: number
  sources: PlaylistSource[]
  englishOnly: boolean
  setEnglishOnly: (value: boolean) => void
  hideDuplicates: boolean
  setHideDuplicates: (value: boolean) => void
  byCategory: (id: CategoryId) => StreamItem[]
  getById: (id: string) => StreamItem | undefined
  addPlaylist: (input: AddPlaylistInput) => Promise<number>
  removeSource: (id: string) => Promise<void>
  clearImported: () => Promise<void>
  refreshSource: (id: string) => Promise<number>
  refreshAllRemote: () => Promise<{ refreshed: number; failed: number; totalStreams: number }>
  hasUrl: (url: string) => boolean
  /** Reload persisted torrent catalog into shelves */
  reloadTorrentCatalog: () => Promise<void>
  /** Crawl a torrent website into Movies / Series / Anime */
  syncTorrentWebsite: (sourceId: string) => Promise<{ added: number; error?: string }>
  syncAllTorrentWebsites: () => Promise<{ added: number; sources: number }>
  /** Streamed.pk sport list from /api/sports (for Sports shelf filters) */
  streamedSports: StreamedSport[]
}

const CatalogContext = createContext<CatalogContextValue | null>(null)

async function fetchPlaylistContent(url: string): Promise<string> {
  return fetchRemotePlaylistContent(url)
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [sources, setSources] = useState<PlaylistSource[]>([])
  const [torrentItems, setTorrentItems] = useState<StreamItem[]>([])
  const [streamedItems, setStreamedItems] = useState<StreamItem[]>([])
  const [ppvStItems, setPpvStItems] = useState<StreamItem[]>([])
  const [livextvReplayItems, setLivextvReplayItems] = useState<StreamItem[]>([])
  const [fullmatchShowsItems, setFullmatchShowsItems] = useState<StreamItem[]>([])
  const [streamedSports, setStreamedSports] = useState<StreamedSport[]>([])
  const [englishOnly, setEnglishOnlyState] = useState(() => getEnglishOnlyPref())
  const [hideDuplicates, setHideDuplicatesState] = useState(() => getHideDuplicatesPref())
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [torrentSourceRevision, setTorrentSourceRevision] = useState(0)

  useEffect(() => {
    const bump = () => setTorrentSourceRevision((n) => n + 1)
    window.addEventListener(TORRENT_SOURCES_CHANGED, bump)
    return () => window.removeEventListener(TORRENT_SOURCES_CHANGED, bump)
  }, [])

  const setEnglishOnly = useCallback((value: boolean) => {
    setEnglishOnlyPref(value)
    setEnglishOnlyState(value)
  }, [])

  const setHideDuplicates = useCallback((value: boolean) => {
    setHideDuplicatesPref(value)
    setHideDuplicatesState(value)
  }, [])

  const reload = useCallback(async () => {
    const rows = await listPlaylistSources()
    setSources(rows)
  }, [])

  const reloadTorrentCatalog = useCallback(async () => {
    try {
      const rows = await listTorrentCatalog()
      startTransition(() => {
        setTorrentItems(rows)
      })
    } catch (err) {
      // IndexedDB can throw UnknownError when Chromium's QuotaManager is corrupted
      console.error('Torrent catalog unavailable (storage may need a reset):', err)
      startTransition(() => {
        setTorrentItems([])
      })
    }
  }, [])

  /** Progress bar + first-time sync: paint shelves as batches land in IndexedDB. */
  const applySyncProgress = useCallback((p: TorrentSyncProgress) => {
    setSyncProgressMessage(maskActivityMessage(p.message), p.percent ?? null)
    if (!p.flush) return
    const batch = p.items
    if (batch && batch.length > 0) {
      startTransition(() => {
        setTorrentItems((prev) => {
          if (prev.length === 0) return batch
          const byId = new Map(prev.map((item) => [item.id, item]))
          for (const item of batch) byId.set(item.id, item)
          return [...byId.values()]
        })
      })
      return
    }
    void reloadTorrentCatalog()
  }, [reloadTorrentCatalog])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await migrateLegacyPlaylist(countM3UEntries)
        // Seed curated public playlists (e.g. IPTV-Org Sports / News) if missing
        const existing = await listPlaylistSources()

        // Shrink a previously imported full news list down to the popular cap
        for (const row of existing) {
          if (cancelled) break
          if (row.id !== 'builtin-iptv-org-news' && !/categories\/news\.m3u/i.test(row.url || '')) {
            continue
          }
          if (row.itemCount <= POPULAR_NEWS_LIMIT) continue
          const content = preparePlaylistContent(row.url, row.content)
          const itemCount = countM3UEntries(content)
          if (itemCount === 0 || itemCount === row.itemCount) continue
          const next = { ...row, content, itemCount, addedAt: Date.now() }
          await putPlaylistSource(next)
          const idx = existing.findIndex((r) => r.id === row.id)
          if (idx >= 0) existing[idx] = next
        }

        for (const seed of DEFAULT_PLAYLISTS) {
          if (cancelled) break
          const already = existing.some(
            (row) =>
              row.id === seed.id ||
              (row.url &&
                normalizeIptvPlaylistUrl(row.url) === normalizeIptvPlaylistUrl(seed.url)),
          )
          if (already) continue
          try {
            let content = ''
            let lastErr: unknown
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                content = await fetchPlaylistContent(seed.url)
                lastErr = null
                break
              } catch (err) {
                lastErr = err
                if (attempt === 0) {
                  await new Promise((r) => setTimeout(r, 1500))
                }
              }
            }
            if (lastErr) throw lastErr
            const itemCount = countM3UEntries(content)
            if (itemCount === 0) continue
            await putPlaylistSource({
              id: seed.id,
              kind: 'url',
              label: seed.label,
              url: seed.url,
              content,
              addedAt: Date.now(),
              itemCount,
            })
            existing.push({
              id: seed.id,
              kind: 'url',
              label: seed.label,
              url: seed.url,
              content,
              addedAt: Date.now(),
              itemCount,
            })
          } catch (err) {
            console.error(`Default playlist failed (${seed.label}):`, err)
          }
        }
        if (!cancelled) {
          await reload()
          await reloadTorrentCatalog()
        }
      } catch (err) {
        console.error(err)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload, reloadTorrentCatalog])

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  const imported = useMemo(() => {
    const all: StreamItem[] = []
    for (const source of sources) {
      all.push(
        ...parseM3U(source.content, {
          sourceId: source.id,
          sourceLabel: source.label,
          fallbackCategory:
            source.id === 'builtin-iptv-org-kids' ||
            /categories\/kids\.m3u/i.test(source.url || '')
              ? 'kids'
              : undefined,
        }),
      )
    }
    return all
  }, [sources])

  const items = useMemo(() => {
    const builtins = BUILTIN_CATALOG.map((item) => ({
      ...item,
      sourceKind: item.sourceKind ?? ('builtin' as const),
      transport: item.transport ?? ('direct' as const),
    }))
    const merged = [
      ...builtins,
      ...streamedItems,
      ...ppvStItems,
      ...livextvReplayItems,
      ...fullmatchShowsItems,
      ...torrentItems,
      ...imported,
    ]
    const deduped = hideDuplicates ? dedupeStreams(merged) : merged
    if (!kidsMode) return deduped
    return deduped.filter((item) => item.category === 'kids')
  }, [
    imported,
    torrentItems,
    streamedItems,
    ppvStItems,
    livextvReplayItems,
    fullmatchShowsItems,
    hideDuplicates,
    kidsMode,
  ])

  // Precompute TV Series shelf once — switching Movies → Series was re-filtering
  // and re-sorting ~20k YMovies rows on every visit.
  const seriesShelfItems = useMemo(() => {
    void torrentSourceRevision
    let base = items.filter((item) => item.category === 'series')
    base = filterShelfVisibleItems(base)
    return base.filter(isSeriesWebCatalogItem)
  }, [items, torrentSourceRevision])

  const byCategory = useCallback(
    (id: CategoryId) => {
      void torrentSourceRevision
      if (id === 'series') {
        if (!englishOnly || !shouldApplyEnglishFilter(id)) return seriesShelfItems
        return seriesShelfItems.filter(isLikelyEnglish)
      }
      let base = items.filter((item) => item.category === id)
      base = filterShelfVisibleItems(base)
      if (!englishOnly || !shouldApplyEnglishFilter(id)) return base
      // Match titles / leagues aren't "English streams" — don't hide LiveXTV Replay.
      return base.filter(
        (item) =>
          isLivextvReplayCatalogItem(item) ||
          isFullmatchShowsCatalogItem(item) ||
          isLikelyEnglish(item),
      )
    },
    [items, englishOnly, torrentSourceRevision, seriesShelfItems],
  )

  const getById = useCallback(
    (id: string) => items.find((item) => item.id === id),
    [items],
  )

  const hasUrl = useCallback(
    (url: string) => {
      const normalized = normalizeIptvPlaylistUrl(url.trim())
      return sources.some((s) => s.url && normalizeIptvPlaylistUrl(s.url) === normalized)
    },
    [sources],
  )

  const addPlaylist = useCallback(
    async (input: AddPlaylistInput) => {
      const count = countM3UEntries(input.content)
      if (count === 0) throw new Error('No playable entries found in that playlist')

      const normalizedUrl = input.url ? normalizeIptvPlaylistUrl(input.url) : undefined
      const existing = normalizedUrl
        ? sources.find((s) => s.url && normalizeIptvPlaylistUrl(s.url) === normalizedUrl)
        : undefined

      if (existing && !input.replaceExisting) {
        await putPlaylistSource({
          ...existing,
          label: input.label || existing.label,
          kind: input.kind,
          content: input.content,
          itemCount: count,
          addedAt: Date.now(),
        })
        await reload()
        return count
      }

      const source: PlaylistSource = {
        id: existing && input.replaceExisting ? existing.id : newSourceId(),
        kind: input.kind,
        label: input.label,
        url: normalizedUrl,
        content: input.content,
        addedAt: Date.now(),
        itemCount: count,
      }
      await putPlaylistSource(source)
      await reload()
      return count
    },
    [reload, sources],
  )

  const removeSource = useCallback(
    async (id: string) => {
      await deletePlaylistSource(id)
      await reload()
    },
    [reload],
  )

  const clearImported = useCallback(async () => {
    await clearPlaylistSources()
    await reload()
  }, [reload])

  const refreshSource = useCallback(
    async (id: string) => {
      const current = sources.find((s) => s.id === id)
      if (!current?.url) throw new Error('Only remote URL playlists can be refreshed')
      const content = await fetchPlaylistContent(current.url)
      const count = countM3UEntries(content)
      if (count === 0) throw new Error('Refreshed playlist had no entries')
      await putPlaylistSource({
        ...current,
        content,
        itemCount: count,
        addedAt: Date.now(),
      })
      await reload()
      return count
    },
    [reload, sources],
  )

  const refreshAllRemote = useCallback(async () => {
    const remote = sources.filter((s) => s.url)
    let refreshed = 0
    let failed = 0
    let totalStreams = 0
    for (const source of remote) {
      try {
        const content = await fetchPlaylistContent(source.url!)
        const count = countM3UEntries(content)
        if (count === 0) {
          failed++
          continue
        }
        await putPlaylistSource({
          ...source,
          content,
          itemCount: count,
          addedAt: Date.now(),
        })
        refreshed++
        totalStreams += count
      } catch {
        failed++
      }
    }
    await reload()
    return { refreshed, failed, totalStreams }
  }, [reload, sources])

  const syncTorrentWebsite = useCallback(
    async (sourceId: string) => {
      const queued = await enqueueTorrentSyncTask(async () => {
        const source = loadTorrentSources().find((s) => s.id === sourceId)
        if (!source) return { added: 0, error: 'Website not found' }
        setTorrentSyncMessage('Starting catalog update…', 1)
        try {
          const result = await syncTorrentSource(source, applySyncProgress)
          if (result.superseded) {
            return { added: 0 }
          }
          if (result.cancelled) {
            setTorrentSyncMessage('Catalog sync cancelled', null)
            appendActivity('sync', 'Catalog sync cancelled')
            window.setTimeout(() => clearTorrentSyncStatus(), 2500)
            if (isEztvSource(source.url, source.label)) {
              void window.signalDesktop?.closeCfBrowser?.({
                soon: true,
                reason: 'eztv-sync-cancelled',
              })
            }
            return { added: 0, error: 'Catalog sync cancelled' }
          }
          // Only reload shelves once at the end — mid-sync reloads froze TV Series.
          if (result.added > 0 || result.error) {
            await reloadTorrentCatalog()
          }
          const summary = result.error
            ? maskActivityMessage(result.error)
            : `Added ${result.added.toLocaleString()} titles to the catalog`
          setTorrentSyncMessage(summary, result.error ? null : 100)
          appendActivity(result.error ? 'error' : 'sync', summary)
          window.setTimeout(() => clearTorrentSyncStatus(), result.error ? 6000 : 2500)
          if (isEztvSource(source.url, source.label)) {
            void window.signalDesktop?.closeCfBrowser?.({
              soon: true,
              reason: 'eztv-sync-done',
            })
          }
          return { added: result.added, error: result.error }
        } catch (err) {
          const message = maskActivityMessage(
            err instanceof Error ? err.message : 'Catalog update failed',
          )
          setTorrentSyncMessage(message, null)
          appendActivity('error', message)
          window.setTimeout(() => clearTorrentSyncStatus(), 6000)
          if (isEztvSource(source.url, source.label)) {
            void window.signalDesktop?.closeCfBrowser?.({
              soon: true,
              reason: 'eztv-sync-error',
            })
          }
          return { added: 0, error: message }
        }
      })
      return queued ?? { added: 0 }
    },
    [applySyncProgress, reloadTorrentCatalog],
  )

  const syncAllTorrentWebsites = useCallback(async () => {
    const queued = await enqueueTorrentSyncTask(async () => {
      const list = loadTorrentSources().filter((source) => !source.hiddenFromShelves)
      if (list.length === 0) return { added: 0, sources: 0 }
      setTorrentSyncMessage('Starting catalog update…', 1)
      const results = await syncAllTorrentSources(list, applySyncProgress)
      const userCancelled = results.some((r) => r.cancelled && !r.superseded)
      const supersededOnly =
        !userCancelled && results.some((r) => r.cancelled && r.superseded)
      if (supersededOnly) {
        return { added: 0, sources: list.length }
      }
      if (userCancelled) {
        const added = results.reduce((sum, r) => sum + r.added, 0)
        if (added > 0) await reloadTorrentCatalog()
        setTorrentSyncMessage('Catalog sync cancelled', null)
        appendActivity('sync', 'Catalog sync cancelled')
        window.setTimeout(() => clearTorrentSyncStatus(), 2500)
        if (list.some((source) => isEztvSource(source.url, source.label))) {
          void window.signalDesktop?.closeCfBrowser?.({
            soon: true,
            reason: 'eztv-sync-all-cancelled',
          })
        }
        return { added, sources: list.length }
      }
      const added = results.reduce((sum, r) => sum + r.added, 0)
      if (added > 0) await reloadTorrentCatalog()
      const summary = `Synced ${added.toLocaleString()} titles to the catalog`
      setTorrentSyncMessage(summary, 100)
      appendActivity('sync', summary)
      window.setTimeout(() => clearTorrentSyncStatus(), 2500)
      if (list.some((source) => isEztvSource(source.url, source.label))) {
        void window.signalDesktop?.closeCfBrowser?.({
          soon: true,
          reason: 'eztv-sync-all-done',
        })
      }
      return { added, sources: list.length }
    })
    return queued ?? { added: 0, sources: 0 }
  }, [applySyncProgress, reloadTorrentCatalog])

  // Background sync once when ready if websites exist but the catalog is
  // empty, or if it was built by an older scraper (bad titles/posters).
  // Also sync any individual site that never made it onto the shelves
  // (e.g. YTS added while Cloudflare blocked HTML, after other sites synced).
  useEffect(() => {
    if (!ready) return
    let alive = true
    void (async () => {
      // Let React Strict Mode's immediate cleanup win so we don't start two
      // overlapping sync sessions that cancel each other.
      await Promise.resolve()
      if (!alive) return

      const websites = loadTorrentSources()
      if (websites.length === 0) return
      if (pendingSyncSourceIds().length > 0) return
      const meta = loadTorrentCatalogMeta()
      const versionStale = meta.scraperVersion !== TORRENT_SCRAPER_VERSION
      if (torrentItems.length === 0) {
        void syncAllTorrentWebsites()
        return
      }
      if (versionStale) {
        // Scraper bumps re-sync web catalogs + TMDB anime (Ended / complete filter).
        const seriesWeb = websites.filter(
          (source) =>
            isM2BoxUrl(source.url) ||
            // YMovies skipped: ~20k titles already, and CF Verify is disruptive.
            isCinetaroUrl(source.url) ||
            source.id === TMDB_TV_SOURCE_ID ||
            isTmdbTvFeedUrl(source.url) ||
            source.id === TMDB_ANIME_SOURCE_ID ||
            isTmdbAnimeFullFeedUrl(source.url) ||
            source.id === TMDB_KIDS_SOURCE_ID ||
            isTmdbKidsShowsFeedUrl(source.url) ||
            source.id === ZENOX_SOURCE_ID ||
            isZenoxUrl(source.url),
        )
        if (seriesWeb.length > 0) {
          // One shared session for the whole batch (same as sync-all).
          void enqueueTorrentSyncTask(async () => {
            if (!alive) return
            setTorrentSyncMessage('Starting catalog update…', 1)
            const results = await syncAllTorrentSources(seriesWeb, applySyncProgress)
            const userCancelled = results.some((r) => r.cancelled && !r.superseded)
            if (userCancelled) {
              const added = results.reduce((sum, r) => sum + r.added, 0)
              if (added > 0) await reloadTorrentCatalog()
              setTorrentSyncMessage('Catalog sync cancelled', null)
              appendActivity('sync', 'Catalog sync cancelled')
              window.setTimeout(() => clearTorrentSyncStatus(), 2500)
              return
            }
            if (results.some((r) => r.superseded)) return
            const added = results.reduce((sum, r) => sum + r.added, 0)
            if (added > 0) await reloadTorrentCatalog()
            const summary = `Synced ${added.toLocaleString()} titles to the catalog`
            setTorrentSyncMessage(summary, 100)
            appendActivity('sync', summary)
            window.setTimeout(() => clearTorrentSyncStatus(), 2500)
          })
          return
        }
        void syncAllTorrentWebsites()
        return
      }
      const unsynced = websites.filter(
        (source) =>
          !source.hiddenFromShelves && (meta.bySource[source.id]?.count ?? 0) === 0,
      )
      // Series shelves truncated on older Android builds (Popular hardCap ~400).
      // Re-pull when TMDB TV / Cinetaro look severely underfilled vs desktop.
      const SERIES_MIN_COUNT: Record<string, number> = {
        [TMDB_TV_SOURCE_ID]: 1500,
        'builtin-cinetaro': 1500,
      }
      const underfilled = websites.filter((source) => {
        if (source.hiddenFromShelves) return false
        const min = SERIES_MIN_COUNT[source.id]
        if (!min) return false
        return (meta.bySource[source.id]?.count ?? 0) < min
      })
      const needSync = [...unsynced, ...underfilled].filter(
        (source, index, all) => all.findIndex((s) => s.id === source.id) === index,
      )
      if (needSync.length === 0) return
      void enqueueTorrentSyncTask(async () => {
        if (!alive) return
        setTorrentSyncMessage('Starting catalog update…', 1)
        const results = await syncAllTorrentSources(needSync, applySyncProgress)
        const userCancelled = results.some((r) => r.cancelled && !r.superseded)
        if (userCancelled) {
          const added = results.reduce((sum, r) => sum + r.added, 0)
          if (added > 0) await reloadTorrentCatalog()
          setTorrentSyncMessage('Catalog sync cancelled', null)
          appendActivity('sync', 'Catalog sync cancelled')
          window.setTimeout(() => clearTorrentSyncStatus(), 2500)
          return
        }
        if (results.some((r) => r.superseded)) return
        const added = results.reduce((sum, r) => sum + r.added, 0)
        if (added > 0) await reloadTorrentCatalog()
        const summary = `Synced ${added.toLocaleString()} titles to the catalog`
        setTorrentSyncMessage(summary, 100)
        appendActivity('sync', summary)
        window.setTimeout(() => clearTorrentSyncStatus(), 2500)
      })
    })()
    return () => {
      alive = false
    }
    // Intentionally run once after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Finish a sync that was still going when Jiyu was closed or the process was killed.
  useEffect(() => {
    if (!ready) return
    bindBackgroundSyncResume()
    const resume = () => {
      if (getTorrentSyncControlState().active) return
      const ids = pendingSyncSourceIds()
      if (ids.length === 0) return
      const websites = loadTorrentSources()
      const list = ids
        .map((id) => websites.find((source) => source.id === id))
        .filter((source): source is NonNullable<typeof source> => Boolean(source))
      if (list.length === 0) {
        clearSyncJob()
        return
      }
      void enqueueTorrentSyncTask(async () => {
        const stillPending = pendingSyncSourceIds()
        const fresh = list.filter((source) => stillPending.includes(source.id))
        if (fresh.length === 0 || getTorrentSyncControlState().active) return
        setTorrentSyncMessage('Starting catalog update…', 1)
        const results = await syncAllTorrentSources(fresh, applySyncProgress)
        const userCancelled = results.some((r) => r.cancelled && !r.superseded)
        if (userCancelled) {
          const added = results.reduce((sum, r) => sum + r.added, 0)
          if (added > 0) await reloadTorrentCatalog()
          setTorrentSyncMessage('Catalog sync cancelled', null)
          appendActivity('sync', 'Catalog sync cancelled')
          window.setTimeout(() => clearTorrentSyncStatus(), 2500)
          return
        }
        if (results.some((r) => r.superseded)) return
        const added = results.reduce((sum, r) => sum + r.added, 0)
        if (added > 0) await reloadTorrentCatalog()
        const summary = `Synced ${added.toLocaleString()} titles to the catalog`
        setTorrentSyncMessage(summary, 100)
        appendActivity('sync', summary)
        window.setTimeout(() => clearTorrentSyncStatus(), 2500)
      })
    }
    const stop = onCatalogSyncResumeRequested(resume)
    resume()
    return stop
  }, [ready, reloadTorrentCatalog])

  // SubsPlease publishes new anime throughout the day. Refresh its all-shows
  // catalog at startup when stale, then every six hours while Jiyu is open.
  useEffect(() => {
    if (!ready) return
    const refreshSubsPlease = () => {
      const source = loadTorrentSources().find((entry) => isSubsPleaseUrl(entry.url))
      if (!source) return
      const syncedAt = loadTorrentCatalogMeta().bySource[source.id]?.syncedAt ?? 0
      if (Date.now() - syncedAt >= 6 * 60 * 60 * 1000) {
        void syncTorrentWebsite(source.id)
      }
    }
    const startup = window.setTimeout(refreshSubsPlease, 60_000)
    const timer = window.setInterval(refreshSubsPlease, 6 * 60 * 60 * 1000)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(timer)
    }
  }, [ready, syncTorrentWebsite])

  // YTS Popular grows via merge; refresh every 12h so newly popular titles are pulled in.
  useEffect(() => {
    if (!ready) return
    const refreshYts = () => {
      const source = loadTorrentSources().find((entry) => isYtsSource(entry.url, entry.label))
      if (!source) return
      const syncedAt = loadTorrentCatalogMeta().bySource[source.id]?.syncedAt ?? 0
      if (Date.now() - syncedAt >= 12 * 60 * 60 * 1000) {
        void syncTorrentWebsite(source.id)
      }
    }
    const startup = window.setTimeout(refreshYts, 90_000)
    const timer = window.setInterval(refreshYts, 12 * 60 * 60 * 1000)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(timer)
    }
  }, [ready, syncTorrentWebsite])

  // TMDB Series + Anime + Kids Shows — daily only (skip if synced within 24h).
  useEffect(() => {
    if (!ready) return
    const DAY_MS = 24 * 60 * 60 * 1000
    const isTmdbSource = (entry: { id: string; url: string }) =>
      entry.id === TMDB_TV_SOURCE_ID ||
      entry.id === TMDB_ANIME_SOURCE_ID ||
      entry.id === TMDB_KIDS_SOURCE_ID ||
      entry.id === ZENOX_SOURCE_ID ||
      isTmdbTvFeedUrl(entry.url) ||
      isZenoxUrl(entry.url)

    const refreshTmdb = (opts?: { forceKidsIfEmpty?: boolean }) => {
      const sources = loadTorrentSources().filter(isTmdbSource)
      if (sources.length === 0) return
      const meta = loadTorrentCatalogMeta()
      const kidsShelfEmpty =
        opts?.forceKidsIfEmpty &&
        !torrentItems.some(
          (item) =>
            item.category === 'kids' &&
            (item.torrentSourceId === TMDB_KIDS_SOURCE_ID ||
              item.tags?.some((t) => t.toLowerCase() === 'kids-shows')),
        )
      void (async () => {
        for (const source of sources) {
          const isKids =
            source.id === TMDB_KIDS_SOURCE_ID || isTmdbKidsShowsFeedUrl(source.url)
          const syncedAt = meta.bySource[source.id]?.syncedAt ?? 0
          if (isKids && kidsShelfEmpty) {
            await syncTorrentWebsite(source.id)
            continue
          }
          if (Date.now() - syncedAt < DAY_MS) continue
          await syncTorrentWebsite(source.id)
        }
      })()
    }
    // Kids Shows empty → sync soon; other TMDB feeds wait so startup isn’t a pile-up.
    const kidsStartup = window.setTimeout(() => refreshTmdb({ forceKidsIfEmpty: true }), 8_000)
    const startup = window.setTimeout(() => refreshTmdb(), 150_000)
    const timer = window.setInterval(() => refreshTmdb(), DAY_MS)
    return () => {
      window.clearTimeout(kidsStartup)
      window.clearTimeout(startup)
      window.clearInterval(timer)
    }
    // torrentItems only used for the one-shot empty Kids check at schedule time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, syncTorrentWebsite])

  // Streamed.pk + PPV.st — live sports catalogs; refresh as games start/end.
  useEffect(() => {
    if (!ready || kidsMode) return
    let cancelled = false
    let failStreak = 0
    let retryTimer: number | undefined
    const refresh = async () => {
      const [sportsResult, liveResult, popularResult, ppvResult] = await Promise.all([
        fetchStreamedSports(),
        fetchStreamedLiveMatches(false),
        fetchStreamedLiveMatches(true),
        fetchPpvStLiveCatalog(),
      ])
      if (cancelled) return
      const streamedOk = liveResult.ok || popularResult.ok
      const ppvOk = ppvResult.ok
      if (!streamedOk) {
        console.warn(
          'Streamed live matches unavailable:',
          liveResult.ok ? popularResult.error : liveResult.error,
        )
      }
      if (!ppvOk) {
        console.warn('PPV.st streams unavailable:', ppvResult.error)
      }
      const live = liveResult.ok ? liveResult.matches : []
      const popular = popularResult.ok ? popularResult.matches : []
      startTransition(() => {
        if (sportsResult.ok) setStreamedSports(sportsResult.sports)
        if (streamedOk) setStreamedItems(mergeStreamedLiveCatalog(live, popular))
        if (ppvOk) setPpvStItems(ppvResult.items)
      })
      // Startup / brief outages: retry soon instead of waiting for the 90s poll.
      if (!streamedOk || !ppvOk) {
        failStreak += 1
        const delay = Math.min(30_000, 2_000 * failStreak)
        window.clearTimeout(retryTimer)
        retryTimer = window.setTimeout(() => {
          void refresh()
        }, delay)
      } else {
        failStreak = 0
      }
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 90_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(retryTimer)
    }
  }, [ready, kidsMode])

  // LiveXTV + FullMatchShows full-match replays — heavier payload; refresh less often than live.
  useEffect(() => {
    if (!ready || kidsMode) return
    let cancelled = false
    let failStreak = 0
    let retryTimer: number | undefined
    const refresh = async () => {
      const [livextv, fms] = await Promise.all([
        fetchLivextvReplayCatalog(),
        fetchFullmatchShowsReplayCatalog(),
      ])
      if (cancelled) return
      if (!livextv.ok && !fms.ok) {
        console.warn('Sports replays unavailable:', livextv.error || fms.error)
        failStreak += 1
        const delay = Math.min(45_000, 3_000 * failStreak)
        window.clearTimeout(retryTimer)
        retryTimer = window.setTimeout(() => {
          void refresh()
        }, delay)
        return
      }
      failStreak = 0
      startTransition(() => {
        if (livextv.ok) setLivextvReplayItems(livextv.items)
        if (fms.ok) setFullmatchShowsItems(fms.items)
        else if (!fms.ok) console.warn('FullMatchShows replays unavailable:', fms.error)
        if (!livextv.ok) console.warn('LiveXTV replays unavailable:', livextv.error)
      })
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 15 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(retryTimer)
    }
  }, [ready, kidsMode])

  const value = useMemo(
    () => ({
      ready,
      items,
      importedCount: imported.length,
      torrentCount: torrentItems.length,
      sources,
      englishOnly,
      setEnglishOnly,
      hideDuplicates,
      setHideDuplicates,
      byCategory,
      getById,
      addPlaylist,
      removeSource,
      clearImported,
      refreshSource,
      refreshAllRemote,
      hasUrl,
      reloadTorrentCatalog,
      syncTorrentWebsite,
      syncAllTorrentWebsites,
      streamedSports,
    }),
    [
      ready,
      items,
      imported.length,
      torrentItems.length,
      sources,
      englishOnly,
      setEnglishOnly,
      hideDuplicates,
      setHideDuplicates,
      byCategory,
      getById,
      addPlaylist,
      removeSource,
      clearImported,
      refreshSource,
      refreshAllRemote,
      hasUrl,
      reloadTorrentCatalog,
      syncTorrentWebsite,
      syncAllTorrentWebsites,
      streamedSports,
    ],
  )

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}

export function useCatalog() {
  const ctx = useContext(CatalogContext)
  if (!ctx) throw new Error('useCatalog must be used inside CatalogProvider')
  return ctx
}

export { fetchPlaylistContent }
