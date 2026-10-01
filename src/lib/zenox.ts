/**
 * Zenox (zenox.lol) Animation catalog → Anime Full Shows / Kids / Series.
 * Zenox is TMDB-backed (`/tv?genre=16`). We sync via Electron TMDB discover
 * (same Animation genre) so each title gets language + genre ids for routing,
 * then store Zenox watch URLs + rivestreamTmdbId for playback.
 */

import type { TorrentPageLink } from './torrents'

export const ZENOX_SOURCE_ID = 'builtin-zenox-animation'
export const ZENOX_ORIGIN = 'https://zenox.lol'
export const ZENOX_ANIMATION_FEED_PREFIX = 'jiyu://zenox-animation'
/** TMDB TV Animation genre — matches https://zenox.lol/tv?genre=16 */
export const ZENOX_ANIMATION_GENRE_ID = 16
export const ZENOX_KIDS_GENRE_ID = 10762
export const ZENOX_FAMILY_GENRE_ID = 10751
/** Cap keeps sync reasonable (Zenox lists ~15k; TMDB discover tops out ~10k). */
export const ZENOX_ANIMATION_LIMIT = 8000

/** Asian animation languages → Anime Full Shows. */
const ANIME_LANGS = new Set(['ja', 'ko', 'zh', 'th'])

/** Adult / not-for-kids Western cartoons (never Kids shelf). */
const ADULT_CARTOON_TITLE =
  /\b(south park|family guy|american dad|rick and morty|robot chicken|clone high|bojack|archer\b|harmontown|drawn together|ugly americans|brickleberry|paradise pd|happy tree friends|ren (and|&) stimpy|beavis|butt-?head|mr\.?\s*pickles|superjail|metalocalypse|venture bros|aqua teen|sealab|squidbillies|moral orel|big mouth|human resources|duncanville|the cleveland show|futurama|the simpsons|king of the hill|bob'?s burgers|solar opposites|final space|smiling friends)\b/i

export type ZenoxShelfBucket = 'anime' | 'kids' | 'series'

export interface ZenoxCatalogShow {
  tmdbId: number | string
  name: string
  firstAirDate?: string
  popularity?: number
  overview?: string
  poster?: string
  originalLanguage?: string
  genreIds?: number[]
}

export function zenoxAnimationFeedUrl(): string {
  return ZENOX_ANIMATION_FEED_PREFIX
}

export function isZenoxAnimationFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(ZENOX_ANIMATION_FEED_PREFIX)
}

export function isZenoxUrl(pageUrl: string): boolean {
  if (isZenoxAnimationFeedUrl(pageUrl)) return true
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase()
    return host === 'zenox.lol' || host.endsWith('.zenox.lol')
  } catch {
    return /zenox\.lol/i.test(pageUrl)
  }
}

export function isZenoxCatalogItem(item: {
  url?: string
  detailUrl?: string
  torrentSourceId?: string
}): boolean {
  if (item.torrentSourceId === ZENOX_SOURCE_ID) return true
  if (item.url && isZenoxUrl(item.url)) return true
  if (item.detailUrl && isZenoxUrl(item.detailUrl)) return true
  return false
}

export function zenoxMediaUrl(tmdbId: string | number, mediaType: 'tv' | 'movie' = 'tv'): string {
  return `${ZENOX_ORIGIN}/?media=${mediaType}-${encodeURIComponent(String(tmdbId))}`
}

export function zenoxWatchUrl(
  tmdbId: string | number,
  season = 1,
  episode = 1,
): string {
  return `${ZENOX_ORIGIN}/media/series-${encodeURIComponent(String(tmdbId))}-${season}-${episode}`
}

/**
 * Route a Zenox Animation title into Anime Full Shows, Kids Shows, or Series.
 * Asian animation → anime first; then Kids/Family genres; else series.
 */
export function classifyZenoxAnimationShow(show: {
  name?: string
  title?: string
  originalLanguage?: string
  genreIds?: number[]
}): ZenoxShelfBucket {
  const title = String(show.name || show.title || '').trim()
  const lang = String(show.originalLanguage || '').trim().toLowerCase()
  const genres = Array.isArray(show.genreIds)
    ? show.genreIds.map((g) => Number(g)).filter((n) => Number.isFinite(n))
    : []

  const adultTitle = ADULT_CARTOON_TITLE.test(title)
  const hasKids = genres.includes(ZENOX_KIDS_GENRE_ID)
  const hasFamily = genres.includes(ZENOX_FAMILY_GENRE_ID)

  // Doraemon / Pokémon etc. are often tagged Kids on TMDB — still Anime Full Shows.
  if (ANIME_LANGS.has(lang)) return 'anime'
  if (hasKids && !adultTitle) return 'kids'
  if (hasFamily && !adultTitle) return 'kids'
  return 'series'
}

/** Sync Zenox Animation list via TMDB discover (genre 16). Desktop uses Electron IPC; Android uses client TMDB. */
export async function fetchZenoxAnimationCatalogLinks(
  onProgress?: (done: number, total: number) => void,
): Promise<{ links: TorrentPageLink[]; error: string | null; counts: Record<ZenoxShelfBucket, number> }> {
  onProgress?.(0, ZENOX_ANIMATION_LIMIT)

  type CatalogResult = {
    ok: boolean
    shows?: Array<{
      tmdbId: number
      name: string
      firstAirDate: string
      popularity: number
      overview: string
      poster: string
      originalLanguage?: string
      genreIds?: number[]
    }>
    error?: string | null
    cancelled?: boolean
  }

  let result: CatalogResult
  const desktopCatalog = window.signalDesktop?.tmdbTvCatalog
  if (desktopCatalog) {
    const stop = window.signalDesktop?.onTmdbProgress?.((p) => {
      onProgress?.(p.done, p.total || ZENOX_ANIMATION_LIMIT)
    })
    try {
      result = await desktopCatalog('animation', ZENOX_ANIMATION_LIMIT, { withExternalIds: false })
    } finally {
      stop?.()
    }
  } else {
    const { fetchTmdbTvCatalogClient } = await import('./tmdbClient')
    result = await fetchTmdbTvCatalogClient('animation', ZENOX_ANIMATION_LIMIT, {
      withExternalIds: false,
      onProgress,
    })
  }

  if (result.cancelled || /catalog sync cancelled/i.test(String(result.error || ''))) {
    return {
      links: [],
      error: result.error || 'Catalog sync cancelled',
      counts: { anime: 0, kids: 0, series: 0 },
    }
  }
  if (!result.ok) {
    return {
      links: [],
      error: result.error || 'Zenox / TMDB animation catalog failed',
      counts: { anime: 0, kids: 0, series: 0 },
    }
  }

  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  const counts: Record<ZenoxShelfBucket, number> = { anime: 0, kids: 0, series: 0 }
  let rankIndex = 0

  for (const raw of result.shows || []) {
    const show = raw as ZenoxCatalogShow & {
      tmdbId: number
      name: string
      firstAirDate: string
      popularity: number
      poster: string
      overview: string
    }
    const id = String(show.tmdbId || '').trim()
    const title = String(show.name || '').trim()
    if (!id || !title || seen.has(id)) continue
    seen.add(id)

    const bucket = classifyZenoxAnimationShow({
      name: title,
      originalLanguage: show.originalLanguage,
      genreIds: show.genreIds,
    })
    counts[bucket] += 1

    const year = String(show.firstAirDate || '').slice(0, 4)
    const popularity =
      typeof show.popularity === 'number' && Number.isFinite(show.popularity)
        ? show.popularity
        : 0
    const rankReleasedAt =
      popularity > 0
        ? Math.round(popularity * 1_000_000) + (10_000 - Math.min(rankIndex, 9_999))
        : Date.now() - rankIndex * 10
    rankIndex += 1

    const shelfLabel =
      bucket === 'anime' ? 'Anime' : bucket === 'kids' ? 'Kids' : 'Series'

    links.push({
      title,
      url: zenoxMediaUrl(id, 'tv'),
      summary: [shelfLabel, year, 'Zenox', 'Animation'].filter(Boolean).join(' · '),
      poster: show.poster || undefined,
      category: bucket,
      shelfTag:
        bucket === 'anime'
          ? 'full-shows'
          : bucket === 'kids'
            ? 'kids-shows'
            : 'popular-series',
      releasedAt: Number.isFinite(rankReleasedAt) ? rankReleasedAt : undefined,
      rivestreamTmdbId: id,
    })
  }

  onProgress?.(links.length, links.length)
  return {
    links,
    counts,
    error:
      links.length === 0
        ? 'Zenox Animation returned no titles'
        : null,
  }
}
