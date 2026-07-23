import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { BUILTIN_CATALOG } from '../data/catalog'
import { normalizeIptvPlaylistUrl } from '../lib/iptv'
import {
  getEnglishOnlyPref,
  isLikelyEnglish,
  setEnglishOnlyPref,
  shouldApplyEnglishFilter,
} from '../lib/language'
import { dedupeStreams, getHideDuplicatesPref, setHideDuplicatesPref } from '../lib/dedupe'
import { countM3UEntries, parseM3U } from '../lib/m3u'
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
import { listTorrentCatalog, loadTorrentCatalogMeta } from '../lib/torrentCatalogStore'
import { isSubsPleaseUrl, loadTorrentSources } from '../lib/torrents'
import {
  TORRENT_SCRAPER_VERSION,
  syncAllTorrentSources,
  syncTorrentSource,
} from '../lib/torrentSync'
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
  torrentSyncMessage: string | null
}

const CatalogContext = createContext<CatalogContextValue | null>(null)

async function fetchPlaylistContent(url: string): Promise<string> {
  const trimmed = normalizeIptvPlaylistUrl(url.trim())
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Playlist URL must start with http:// or https://')
  }

  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(trimmed)
    if (!result.ok) throw new Error(result.error || `Fetch failed (${result.status})`)
    return result.content
  }

  const response = await fetch(trimmed, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Fetch failed (${response.status})`)
  return await response.text()
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [sources, setSources] = useState<PlaylistSource[]>([])
  const [torrentItems, setTorrentItems] = useState<StreamItem[]>([])
  const [torrentSyncMessage, setTorrentSyncMessage] = useState<string | null>(null)
  const [englishOnly, setEnglishOnlyState] = useState(() => getEnglishOnlyPref())
  const [hideDuplicates, setHideDuplicatesState] = useState(() => getHideDuplicatesPref())

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
    const rows = await listTorrentCatalog()
    setTorrentItems(rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await migrateLegacyPlaylist(countM3UEntries)
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

  const imported = useMemo(() => {
    const all: StreamItem[] = []
    for (const source of sources) {
      all.push(
        ...parseM3U(source.content, {
          sourceId: source.id,
          sourceLabel: source.label,
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
    const merged = [...builtins, ...torrentItems, ...imported]
    return hideDuplicates ? dedupeStreams(merged) : merged
  }, [imported, torrentItems, hideDuplicates])

  const byCategory = useCallback(
    (id: CategoryId) => {
      const base = items.filter((item) => item.category === id)
      if (!englishOnly || !shouldApplyEnglishFilter(id)) return base
      return base.filter(isLikelyEnglish)
    },
    [items, englishOnly],
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
      const source = loadTorrentSources().find((s) => s.id === sourceId)
      if (!source) return { added: 0, error: 'Website not found' }
      setTorrentSyncMessage(`Updating ${source.label}…`)
      try {
        const result = await syncTorrentSource(source, (p) => setTorrentSyncMessage(p.message))
        await reloadTorrentCatalog()
        setTorrentSyncMessage(
          result.error
            ? result.error
            : `Added ${result.added.toLocaleString()} titles from ${source.label}`,
        )
        return { added: result.added, error: result.error }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Catalog update failed'
        setTorrentSyncMessage(message)
        return { added: 0, error: message }
      }
    },
    [reloadTorrentCatalog],
  )

  const syncAllTorrentWebsites = useCallback(async () => {
    const list = loadTorrentSources()
    if (list.length === 0) return { added: 0, sources: 0 }
    setTorrentSyncMessage('Updating website catalogs…')
    const results = await syncAllTorrentSources(list, (p) => setTorrentSyncMessage(p.message))
    await reloadTorrentCatalog()
    const added = results.reduce((sum, r) => sum + r.added, 0)
    setTorrentSyncMessage(`Synced ${added.toLocaleString()} titles from websites`)
    return { added, sources: list.length }
  }, [reloadTorrentCatalog])

  // Background sync once when ready if websites exist but the catalog is
  // empty, or if it was built by an older scraper (bad titles/posters).
  // Also sync any individual site that never made it onto the shelves
  // (e.g. YTS added while Cloudflare blocked HTML, after other sites synced).
  useEffect(() => {
    if (!ready) return
    const websites = loadTorrentSources()
    if (websites.length === 0) return
    const meta = loadTorrentCatalogMeta()
    const versionStale = meta.scraperVersion !== TORRENT_SCRAPER_VERSION
    if (torrentItems.length === 0 || versionStale) {
      void syncAllTorrentWebsites()
      return
    }
    const unsynced = websites.filter((source) => (meta.bySource[source.id]?.count ?? 0) === 0)
    if (unsynced.length === 0) return
    void (async () => {
      for (const source of unsynced) {
        await syncTorrentWebsite(source.id)
      }
    })()
    // Intentionally run once after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

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
      torrentSyncMessage,
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
      torrentSyncMessage,
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
