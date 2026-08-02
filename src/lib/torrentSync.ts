import {
  deleteTorrentItemsForSource,
  loadTorrentCatalogMeta,
  saveTorrentCatalogMeta,
  upsertTorrentItems,
} from './torrentCatalogStore'
import { getPerformanceKnobs } from './deviceProfile'
import {
  catalogFeedsForSource,
  isEztvApiUrl,
  isEztvSource,
  isEztvShowUrl,
  isEztvTmdbAiringFeedUrl,
  isEztvTmdbFeedUrl,
  isSubsPleaseUrl,
  isYtsSource,
  linkToCatalogItem,
  scrapeEztvTmdbFeed,
  scrapePage,
  type TorrentSource,
} from './torrents'
import type { StreamItem } from '../types'

/**
 * Bump whenever a site adapter changes how titles/posters are extracted, so
 * already-synced shelves are rebuilt automatically on the next launch.
 */
export const TORRENT_SCRAPER_VERSION = 27

export interface TorrentSyncProgress {
  sourceId: string
  label: string
  page: number
  added: number
  message: string
  /** 0–100 estimate for the current source (showlist uses page / maxPages). */
  percent?: number
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

async function upsertInBatches(items: StreamItem[], batchSize?: number): Promise<void> {
  const size = batchSize ?? getPerformanceKnobs().syncIdbBatchSize
  for (let i = 0; i < items.length; i += size) {
    await upsertTorrentItems(items.slice(i, i + size))
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

  const feedCount = Math.max(1, feeds.length)
  for (let feedIndex = 0; feedIndex < feeds.length; feedIndex += 1) {
    const feed = feeds[feedIndex]!
    let url: string | null = feed.url
    let page = 0
    const isShowlist = /\/showlist\/ajax\//i.test(feed.url)
    const isTmdbFeed = isEztvTmdbFeedUrl(feed.url)
    const tmdbKind = isEztvTmdbAiringFeedUrl(feed.url) ? 'on_the_air' : 'popular'
    const feedBase = (feedIndex / feedCount) * 100
    const feedSpan = 100 / feedCount

    // TMDB → EZTV probe is one long feed with internal progress (no Cloudflare).
    if (isTmdbFeed) {
      pages += 1
      let origin = ''
      try {
        origin = new URL(feed.url).searchParams.get('origin') || new URL(source.url).origin
      } catch {
        origin = ''
      }
      if (!origin) {
        lastError = `${source.label}: missing EZTV origin for TMDB sync`
        continue
      }
      const shelfName = tmdbKind === 'on_the_air' ? 'Now Airing' : 'Full Shows'
      onProgress?.({
        sourceId: source.id,
        label: source.label,
        page: pages,
        added: byId.size,
        percent: Math.min(97, Math.round(feedBase + 1)),
        message: `${shelfName}: loading title list…`,
      })
      lastProgressAt = Date.now()
      const outcome = await scrapeEztvTmdbFeed(
        origin,
        source.label,
        tmdbKind,
        (done, total, matched, phase) => {
          // TMDB list fetch is ~40% of this feed; EZTV probes are the rest.
          const tmdbShare = 0.4
          const within =
            total > 0
              ? phase === 'tmdb'
                ? (done / total) * tmdbShare
                : tmdbShare + (done / total) * (1 - tmdbShare)
              : phase === 'tmdb'
                ? 0.05
                : tmdbShare
          const percent = Math.min(97, Math.round(feedBase + within * feedSpan * 0.97))
          const now = Date.now()
          if (done === total || done === 0 || now - lastProgressAt >= 800) {
            lastProgressAt = now
            onProgress?.({
              sourceId: source.id,
              label: source.label,
              page: pages,
              added: matched,
              percent,
              message:
                phase === 'tmdb'
                  ? `${shelfName}: loading title list… ${done.toLocaleString()}/${Math.max(total, 1).toLocaleString()}`
                  : `${shelfName}: matching catalog… ${done.toLocaleString()}/${total.toLocaleString()} · ${matched.toLocaleString()} found`,
            })
          }
        },
      )
      if (outcome.error && outcome.links.length === 0) {
        lastError = outcome.error
        continue
      }
      for (const link of outcome.links) {
        const item = linkToCatalogItem(link, source, feed.category, feed.shelfTag)
        const existing = byId.get(item.id)
        if (!existing) {
          byId.set(item.id, item)
          continue
        }
        const tags = [...new Set([...(existing.tags ?? []), ...(item.tags ?? [])])]
        byId.set(item.id, {
          ...existing,
          ...item,
          tags,
          poster: item.poster || existing.poster,
          description: item.description || existing.description,
          releasedAt:
            Math.max(existing.releasedAt ?? 0, item.releasedAt ?? 0) ||
            existing.releasedAt ||
            item.releasedAt,
        })
      }
      onProgress?.({
        sourceId: source.id,
        label: source.label,
        page: pages,
        added: byId.size,
        percent: Math.min(97, Math.round(feedBase + feedSpan * 0.97)),
        message: `${shelfName} ready · ${outcome.links.length.toLocaleString()} titles`,
      })
      continue
    }

    // Announce feed start so the bar doesn't sit at 0% during the first request.
    onProgress?.({
      sourceId: source.id,
      label: source.label,
      page: pages,
      added: byId.size,
      percent: Math.min(97, Math.round(feedBase + 1)),
      message:
        feed.shelfTag === 'popular-movies'
          ? 'Popular Movies: starting…'
          : feed.shelfTag === 'new-movies'
            ? 'New Movies: starting…'
            : `Updating catalog · ${feed.category}…`,
    })
    lastProgressAt = Date.now()

    while (url && page < feed.maxPages) {
      page += 1
      pages += 1
      const outcome = await scrapePage(url, source.label)
      if (outcome.error && outcome.links.length === 0) {
        lastError = outcome.error
        break
      }
      // Trending/showlist cards are /shows/… or imdb API URLs after canonicalize.
      if (
        eztvShowlist &&
        /\/showlist\b/i.test(feed.url) &&
        outcome.links.length > 0 &&
        !outcome.links.some(
          (link) =>
            isEztvShowUrl(link.url) ||
            (isEztvApiUrl(link.url) && Boolean(new URL(link.url).searchParams.get('imdb_id'))),
        )
      ) {
        lastError = `${source.label}: Now Airing list unavailable`
        break
      }
      for (const link of outcome.links) {
        const item = linkToCatalogItem(link, source, feed.category, feed.shelfTag)
        const existing = byId.get(item.id)
        if (!existing) {
          byId.set(item.id, item)
          continue
        }
        // Same show can appear in Trending and Full Shows — keep both shelf tags.
        const tags = [...new Set([...(existing.tags ?? []), ...(item.tags ?? [])])]
        const preferIncoming =
          (item.releasedAt ?? 0) > (existing.releasedAt ?? 0) ||
          (!existing.poster && item.poster)
        byId.set(item.id, {
          ...(preferIncoming ? { ...existing, ...item } : { ...item, ...existing }),
          tags,
          poster: item.poster || existing.poster,
          description: item.description || existing.description,
          releasedAt:
            Math.max(existing.releasedAt ?? 0, item.releasedAt ?? 0) || existing.releasedAt || item.releasedAt,
        })
      }

      const reachedEnd = !outcome.nextPage || page >= feed.maxPages
      const within = reachedEnd ? 1 : Math.min(0.99, page / Math.max(1, feed.maxPages))
      // Leave headroom for the final "Saving…" step.
      const percent = Math.min(97, Math.round(feedBase + within * feedSpan * 0.97))

      // Throttle progress callbacks — every page was re-rendering the whole app.
      const now = Date.now()
      if (page === 1 || page % 5 === 0 || reachedEnd || now - lastProgressAt >= 1500) {
        lastProgressAt = now
        const pctLabel = `${percent}%`
        onProgress?.({
          sourceId: source.id,
          label: source.label,
          page: pages,
          added: byId.size,
          percent,
          message: isShowlist
            ? `Now Airing… ${pctLabel} · ${byId.size.toLocaleString()} titles (page ${page})`
            : feed.shelfTag === 'popular-movies'
              ? `Popular Movies… ${pctLabel} · page ${page}/${feed.maxPages}`
              : feed.shelfTag === 'new-movies'
                ? `New Movies… ${pctLabel} · page ${page}/${feed.maxPages}`
                : `Updating catalog · ${feed.category} · ${pctLabel} · page ${page}`,
        })
      }

      url = outcome.nextPage
      // EZTV: longer yield so Chrome fetch + UI stay responsive.
      // Device profile stretches yields on lite machines.
      const knobs = getPerformanceKnobs()
      await yieldToUi(isShowlist ? knobs.syncShowlistYieldMs : knobs.syncYieldMs)
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
      percent: 100,
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
      percent: 98,
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
    percent: 100,
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

/** Lower = sooner. TV Series first, then Anime, then Movies, then anything else. */
function torrentSyncPriority(source: TorrentSource): number {
  if (isEztvSource(source.url, source.label)) return 0
  if (isSubsPleaseUrl(source.url)) return 1
  if (isYtsSource(source.url, source.label)) return 2
  return 3
}

export async function syncAllTorrentSources(
  sources: TorrentSource[],
  onProgress?: (progress: TorrentSyncProgress) => void,
): Promise<TorrentSyncResult[]> {
  const ordered = [...sources].sort(
    (a, b) => torrentSyncPriority(a) - torrentSyncPriority(b),
  )
  const results: TorrentSyncResult[] = []
  const sourceCount = Math.max(1, ordered.length)
  for (let i = 0; i < ordered.length; i += 1) {
    const source = ordered[i]!
    const sourceBase = (i / sourceCount) * 100
    const sourceSpan = 100 / sourceCount
    results.push(
      await syncTorrentSource(source, (p) => {
        const local = p.percent ?? 0
        const percent = Math.min(100, Math.round(sourceBase + (local / 100) * sourceSpan))
        onProgress?.({ ...p, percent })
      }),
    )
    await yieldToUi(getPerformanceKnobs().syncYieldMs)
  }
  return results
}
