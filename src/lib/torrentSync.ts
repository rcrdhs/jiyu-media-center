import {
  deleteTorrentItemsForSource,
  loadTorrentCatalogMeta,
  saveTorrentCatalogMeta,
  upsertTorrentItems,
} from './torrentCatalogStore'
import {
  catalogFeedsForSource,
  linkToCatalogItem,
  scrapePage,
  type TorrentSource,
} from './torrents'
import type { StreamItem } from '../types'

/**
 * Bump whenever a site adapter changes how titles/posters are extracted, so
 * already-synced shelves are rebuilt automatically on the next launch.
 */
export const TORRENT_SCRAPER_VERSION = 14

export interface TorrentSyncProgress {
  sourceId: string
  label: string
  page: number
  added: number
  message: string
}

export interface TorrentSyncResult {
  sourceId: string
  added: number
  pages: number
  error?: string
}

/**
 * Crawl a torrent website's Movies / TV / Anime feeds and permanently upsert
 * titles into the torrent catalog (merged into section shelves).
 */
export async function syncTorrentSource(
  source: TorrentSource,
  onProgress?: (progress: TorrentSyncProgress) => void,
): Promise<TorrentSyncResult> {
  const feeds = catalogFeedsForSource(source)
  const byId = new Map<string, StreamItem>()
  let pages = 0
  let lastError: string | undefined

  for (const feed of feeds) {
    let url: string | null = feed.url
    let page = 0
    while (url && page < feed.maxPages) {
      page += 1
      pages += 1
      onProgress?.({
        sourceId: source.id,
        label: source.label,
        page: pages,
        added: byId.size,
        message: `Updating catalog · ${feed.category} · page ${page}`,
      })
      const outcome = await scrapePage(url, source.label)
      if (outcome.error && outcome.links.length === 0) {
        lastError = outcome.error
        break
      }
      for (const link of outcome.links) {
        const item = linkToCatalogItem(link, source, feed.category)
        // Prefer newer release dates when the same detail URL appears twice
        const existing = byId.get(item.id)
        if (
          !existing ||
          (item.releasedAt ?? 0) > (existing.releasedAt ?? 0) ||
          (!existing.poster && item.poster)
        ) {
          byId.set(item.id, item)
        }
      }
      url = outcome.nextPage
      // Soft pause so sites aren't hammered (EZTV showlist AJAX can be snappier)
      const pauseMs = /\/showlist\/ajax\//i.test(feed.url) ? 60 : 120
      await new Promise((r) => setTimeout(r, pauseMs))
    }
  }

  const items = [...byId.values()]
  // Replace this source's shelf outright so stale or mislabeled entries
  // (e.g. nav links scraped before a site adapter existed) don't linger.
  if (items.length > 0) {
    await deleteTorrentItemsForSource(source.id)
  }
  await upsertTorrentItems(items)

  const meta = loadTorrentCatalogMeta()
  meta.lastSyncAt = Date.now()
  meta.scraperVersion = TORRENT_SCRAPER_VERSION
  meta.bySource[source.id] = { syncedAt: Date.now(), count: items.length }
  saveTorrentCatalogMeta(meta)

  onProgress?.({
    sourceId: source.id,
    label: source.label,
    page: pages,
    added: items.length,
    message: `Synced ${items.length.toLocaleString()} titles to the catalog`,
  })

  return {
    sourceId: source.id,
    added: items.length,
    pages,
    error: items.length === 0 ? lastError : undefined,
  }
}

export async function syncAllTorrentSources(
  sources: TorrentSource[],
  onProgress?: (progress: TorrentSyncProgress) => void,
): Promise<TorrentSyncResult[]> {
  const results: TorrentSyncResult[] = []
  for (const source of sources) {
    results.push(await syncTorrentSource(source, onProgress))
  }
  return results
}
