import {
  deleteTorrentItemsForSource,
  loadTorrentCatalogMeta,
  saveTorrentCatalogMeta,
  upsertTorrentItems,
} from './torrentCatalogStore'
import {
  catalogFeedsForSource,
  isEztvSource,
  isEztvShowUrl,
  linkToCatalogItem,
  scrapePage,
  type TorrentSource,
} from './torrents'
import type { StreamItem } from '../types'

/**
 * Bump whenever a site adapter changes how titles/posters are extracted, so
 * already-synced shelves are rebuilt automatically on the next launch.
 */
export const TORRENT_SCRAPER_VERSION = 20

export interface TorrentSyncProgress {
  sourceId: string
  label: string
  page: number
  added: number
  message: string
  /** True when shelves should reload (use sparingly — large catalogs are expensive) */
  flush?: boolean
}

export interface TorrentSyncResult {
  sourceId: string
  added: number
  pages: number
  error?: string
}

function yieldToUi(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function upsertInBatches(items: StreamItem[], batchSize = 250): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await upsertTorrentItems(items.slice(i, i + batchSize))
    // Let React paint between large IndexedDB writes.
    await yieldToUi(0)
  }
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
  const eztvShowlist = isEztvSource(source.url, source.label)
  let lastProgressAt = 0

  for (const feed of feeds) {
    let url: string | null = feed.url
    let page = 0
    const isShowlist = /\/showlist\/ajax\//i.test(feed.url)
    while (url && page < feed.maxPages) {
      page += 1
      pages += 1
      const outcome = await scrapePage(url, source.label)
      if (outcome.error && outcome.links.length === 0) {
        lastError = outcome.error
        break
      }
      // EZTV shelf sync must be Show List cards (/shows/…), not a tiny API sample.
      if (
        eztvShowlist &&
        /\/showlist\b/i.test(feed.url) &&
        outcome.links.length > 0 &&
        !outcome.links.some((link) => isEztvShowUrl(link.url))
      ) {
        lastError = `${source.label}: Show List unavailable (not full ALL catalogue)`
        break
      }
      for (const link of outcome.links) {
        const item = linkToCatalogItem(link, source, feed.category, feed.shelfTag)
        const existing = byId.get(item.id)
        if (
          !existing ||
          (item.releasedAt ?? 0) > (existing.releasedAt ?? 0) ||
          (!existing.poster && item.poster)
        ) {
          byId.set(item.id, item)
        }
      }

      // Throttle progress callbacks — every page was re-rendering the whole app.
      const now = Date.now()
      if (page === 1 || page % 10 === 0 || now - lastProgressAt >= 2500) {
        lastProgressAt = now
        onProgress?.({
          sourceId: source.id,
          label: source.label,
          page: pages,
          added: byId.size,
          message: isShowlist
            ? `Adding shows… ${byId.size.toLocaleString()} so far (page ${page})`
            : `Updating catalog · ${feed.category} · page ${page}`,
        })
      }

      url = outcome.nextPage
      // EZTV: longer yield so Chrome fetch + UI stay responsive.
      await yieldToUi(isShowlist ? 200 : 80)
    }
  }

  const items = [...byId.values()]
  const meta = loadTorrentCatalogMeta()
  const previousCount = meta.bySource[source.id]?.count ?? 0

  // Only block tiny accidental wipes of a large library.
  if (eztvShowlist && previousCount >= 1000 && items.length > 0 && items.length < 100) {
    const message = `${source.label}: sync found only ${items.length.toLocaleString()} titles (had ${previousCount.toLocaleString()}); kept existing library`
    onProgress?.({
      sourceId: source.id,
      label: source.label,
      page: pages,
      added: previousCount,
      message,
    })
    return {
      sourceId: source.id,
      added: 0,
      pages,
      error: message,
    }
  }

  if (items.length > 0) {
    onProgress?.({
      sourceId: source.id,
      label: source.label,
      page: pages,
      added: items.length,
      message: `Saving ${items.length.toLocaleString()} titles…`,
    })
    // One replace at the end (batched) — mid-sync IDB writes were freezing Jiyu.
    await deleteTorrentItemsForSource(source.id)
    await upsertInBatches(items)
    meta.lastSyncAt = Date.now()
    meta.scraperVersion = TORRENT_SCRAPER_VERSION
    meta.bySource[source.id] = { syncedAt: Date.now(), count: items.length }
    saveTorrentCatalogMeta(meta)
  }

  onProgress?.({
    sourceId: source.id,
    label: source.label,
    page: pages,
    added: items.length,
    flush: items.length > 0,
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
  // Run EZTV last — its Show List crawl is the heavy one.
  const ordered = [...sources].sort((a, b) => {
    const ae = isEztvSource(a.url, a.label) ? 1 : 0
    const be = isEztvSource(b.url, b.label) ? 1 : 0
    return ae - be
  })
  const results: TorrentSyncResult[] = []
  for (const source of ordered) {
    results.push(await syncTorrentSource(source, onProgress))
    await yieldToUi(100)
  }
  return results
}
