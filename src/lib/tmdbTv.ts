/**
 * TMDB TV catalog for Jiyu Series shelves + RiveStream playback.
 * Sync uses Electron's TMDB key (no Cloudflare). Play resolves via rivestream.ts.
 */

import type { TorrentPageLink } from './torrents'

export const TMDB_TV_SOURCE_ID = 'builtin-tmdb-tv'
export const TMDB_ANIME_SOURCE_ID = 'builtin-tmdb-anime'
export const TMDB_KIDS_SOURCE_ID = 'builtin-tmdb-kids'
export const TMDB_TV_POPULAR_FEED_PREFIX = 'jiyu://tmdb-tv-popular'
export const TMDB_TV_AIRING_FEED_PREFIX = 'jiyu://tmdb-tv-airing'
export const TMDB_TV_TRENDING_FEED_PREFIX = 'jiyu://tmdb-tv-trending'
export const TMDB_TV_BY_YEAR_FEED_PREFIX = 'jiyu://tmdb-tv-by-year'
export const TMDB_ANIME_FULL_FEED_PREFIX = 'jiyu://tmdb-anime-full'
export const TMDB_KIDS_SHOWS_FEED_PREFIX = 'jiyu://tmdb-kids-shows'
export const TMDB_TV_DETAIL_PREFIX = 'jiyu://tmdb-tv'

/** Popular discover pages (20/page). Align desktop/Android Series shelves. */
export const TMDB_TV_POPULAR_LIMIT = 3000
export const TMDB_TV_AIRING_LIMIT = 500
export const TMDB_TV_TRENDING_LIMIT = 100
/** Top 20 / year from 2000 → current (~27×20). */
export const TMDB_TV_BY_YEAR_START = 2000
export const TMDB_TV_BY_YEAR_PER_YEAR = 20
export const TMDB_TV_BY_YEAR_LIMIT = 800
/** JP animation discover for Anime → Full Shows (Ended / complete series only). */
export const TMDB_ANIME_FULL_LIMIT = 2000
/** TMDB Kids genre TV for Kids → Shows (Rive play). */
export const TMDB_KIDS_SHOWS_LIMIT = 500

export type TmdbTvFeedKind = 'popular' | 'on_the_air' | 'trending' | 'by_year' | 'anime' | 'kids' | 'animation'

export interface TmdbTvEpisodeInfo {
  key: string
  season: number
  episode: number
  title: string
}

export function tmdbTvPopularFeedUrl(): string {
  return TMDB_TV_POPULAR_FEED_PREFIX
}

export function tmdbTvAiringFeedUrl(): string {
  return TMDB_TV_AIRING_FEED_PREFIX
}

export function tmdbTvTrendingFeedUrl(): string {
  return TMDB_TV_TRENDING_FEED_PREFIX
}

export function tmdbTvByYearFeedUrl(): string {
  return TMDB_TV_BY_YEAR_FEED_PREFIX
}

export function tmdbAnimeFullFeedUrl(): string {
  return TMDB_ANIME_FULL_FEED_PREFIX
}

export function tmdbKidsShowsFeedUrl(): string {
  return TMDB_KIDS_SHOWS_FEED_PREFIX
}

export function isTmdbTvPopularFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_TV_POPULAR_FEED_PREFIX)
}

export function isTmdbTvAiringFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_TV_AIRING_FEED_PREFIX)
}

export function isTmdbTvTrendingFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_TV_TRENDING_FEED_PREFIX)
}

export function isTmdbTvByYearFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_TV_BY_YEAR_FEED_PREFIX)
}

export function isTmdbAnimeFullFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_ANIME_FULL_FEED_PREFIX)
}

export function isTmdbKidsShowsFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(TMDB_KIDS_SHOWS_FEED_PREFIX)
}

export function isTmdbTvFeedUrl(pageUrl: string): boolean {
  return (
    isTmdbTvPopularFeedUrl(pageUrl) ||
    isTmdbTvAiringFeedUrl(pageUrl) ||
    isTmdbTvTrendingFeedUrl(pageUrl) ||
    isTmdbTvByYearFeedUrl(pageUrl) ||
    isTmdbAnimeFullFeedUrl(pageUrl) ||
    isTmdbKidsShowsFeedUrl(pageUrl)
  )
}

export function tmdbTvFeedKind(pageUrl: string): TmdbTvFeedKind {
  if (isTmdbTvAiringFeedUrl(pageUrl)) return 'on_the_air'
  if (isTmdbTvTrendingFeedUrl(pageUrl)) return 'trending'
  if (isTmdbTvByYearFeedUrl(pageUrl)) return 'by_year'
  if (isTmdbAnimeFullFeedUrl(pageUrl)) return 'anime'
  if (isTmdbKidsShowsFeedUrl(pageUrl)) return 'kids'
  return 'popular'
}

export function tmdbTvDetailUrl(tmdbId: string | number): string {
  return `${TMDB_TV_DETAIL_PREFIX}/${encodeURIComponent(String(tmdbId))}`
}

export function tmdbTvIdFromUrl(pageUrl: string): string {
  const m = pageUrl.match(/^jiyu:\/\/tmdb-tv\/(\d+)/i)
  return m?.[1] || ''
}

export function isTmdbTvDetailUrl(pageUrl: string): boolean {
  return Boolean(tmdbTvIdFromUrl(pageUrl))
}

export function isTmdbTvUrl(pageUrl: string): boolean {
  return isTmdbTvFeedUrl(pageUrl) || isTmdbTvDetailUrl(pageUrl)
}

export function isTmdbTvCatalogItem(item: {
  url?: string
  detailUrl?: string
  rivestreamTmdbId?: string
  torrentSourceId?: string
}): boolean {
  if (
    item.torrentSourceId === TMDB_TV_SOURCE_ID ||
    item.torrentSourceId === TMDB_ANIME_SOURCE_ID ||
    item.torrentSourceId === TMDB_KIDS_SOURCE_ID ||
    // Zenox Animation stores rivestreamTmdbId for Rive play.
    item.torrentSourceId === 'builtin-zenox-animation'
  ) {
    return true
  }
  if (item.rivestreamTmdbId && (item.url?.startsWith(TMDB_TV_DETAIL_PREFIX) || item.detailUrl?.startsWith(TMDB_TV_DETAIL_PREFIX))) {
    return true
  }
  if (item.rivestreamTmdbId && /zenox\.lol/i.test(`${item.url || ''} ${item.detailUrl || ''}`)) {
    return true
  }
  if (item.url && isTmdbTvUrl(item.url)) return true
  if (item.detailUrl && isTmdbTvUrl(item.detailUrl)) return true
  return false
}

function feedLimit(kind: TmdbTvFeedKind): number {
  if (kind === 'on_the_air') return TMDB_TV_AIRING_LIMIT
  if (kind === 'trending') return TMDB_TV_TRENDING_LIMIT
  if (kind === 'by_year') return TMDB_TV_BY_YEAR_LIMIT
  if (kind === 'anime') return TMDB_ANIME_FULL_LIMIT
  if (kind === 'animation') return 8000
  if (kind === 'kids') return TMDB_KIDS_SHOWS_LIMIT
  return TMDB_TV_POPULAR_LIMIT
}

/** Sync TMDB TV/anime list into catalog links (no Cloudflare — Rive plays by TMDB id). */
export async function fetchTmdbTvCatalogLinks(
  kind: TmdbTvFeedKind,
  onProgress?: (done: number, total: number) => void,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  const limit = feedLimit(kind)
  const isAnime = kind === 'anime'
  const isKids = kind === 'kids'
  const isByYear = kind === 'by_year'
  onProgress?.(0, limit)

  type CatalogResult = {
    ok: boolean
    shows?: Array<{
      tmdbId: number
      name: string
      firstAirDate: string
      popularity: number
      imdbId?: string
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
      onProgress?.(p.done, p.total || limit)
    })
    try {
      // Skip IMDb enrichment — Rive only needs TMDB ids (much faster).
      result = await desktopCatalog(kind, limit, { withExternalIds: false })
    } finally {
      stop?.()
    }
  } else {
    const { fetchTmdbTvCatalogClient } = await import('./tmdbClient')
    result = await fetchTmdbTvCatalogClient(kind, limit, {
      withExternalIds: false,
      onProgress,
    })
  }

  if (result.cancelled || /catalog sync cancelled/i.test(String(result.error || ''))) {
    return { links: [], error: result.error || 'Catalog sync cancelled' }
  }
  if (!result.ok) {
    return { links: [], error: result.error || 'TMDB catalog failed' }
  }

  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  let rankIndex = 0
  let lastByYear = -1
  let withinYearRank = 0
  for (const show of result.shows || []) {
    const id = String(show.tmdbId || '').trim()
    const title = String(show.name || '').trim()
    if (!id || !title || seen.has(id)) continue
    seen.add(id)
    const year = String(show.firstAirDate || '').slice(0, 4)
    const yearNum = Number(year) || 0
    const airMs = show.firstAirDate
      ? Date.parse(`${show.firstAirDate}T00:00:00Z`)
      : undefined
    // Popular / trending / anime lists are popularity.desc — keep that order
    // via releasedAt (same trick as YTS Popular), so shelves can sort by rank.
    // By-year: newest year first, then top-20 rank within that year.
    const popularity =
      typeof show.popularity === 'number' && Number.isFinite(show.popularity)
        ? show.popularity
        : 0
    let rankReleasedAt: number | undefined
    if (kind === 'on_the_air') {
      rankReleasedAt = Number.isFinite(airMs) ? airMs : undefined
    } else if (isByYear && yearNum >= TMDB_TV_BY_YEAR_START) {
      if (yearNum !== lastByYear) {
        lastByYear = yearNum
        withinYearRank = 0
      }
      rankReleasedAt =
        yearNum * 1_000_000 + (TMDB_TV_BY_YEAR_PER_YEAR - withinYearRank) * 1_000
      withinYearRank += 1
    } else if (popularity > 0) {
      rankReleasedAt =
        Math.round(popularity * 1_000_000) + (10_000 - Math.min(rankIndex, 9_999))
      rankIndex += 1
    } else {
      rankReleasedAt = Date.now() - rankIndex * 10
      rankIndex += 1
    }
    links.push({
      title,
      url: tmdbTvDetailUrl(id),
      summary: [
        isKids ? 'Kids' : isAnime ? 'Anime' : isByYear ? `Top ${year}` : 'TV Series',
        year,
        'TMDB',
        'Rive',
      ]
        .filter(Boolean)
        .join(' · '),
      poster: show.poster || undefined,
      category: isKids ? 'kids' : isAnime ? 'anime' : 'series',
      releasedAt: Number.isFinite(rankReleasedAt) ? rankReleasedAt : undefined,
      rivestreamTmdbId: id,
    })
  }

  onProgress?.(links.length, links.length)
  return {
    links,
    error:
      links.length === 0
        ? `TMDB returned no ${isKids ? 'kids shows' : isAnime ? 'anime' : isByYear ? 'yearly top series' : 'TV series'}`
        : null,
  }
}

async function fetchJson(url: string): Promise<{ ok: boolean; data: unknown; error: string }> {
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, 'https://www.themoviedb.org/')
    if (!result.ok) {
      return { ok: false, data: null, error: result.error || `HTTP ${result.status}` }
    }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null'), error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json(), error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'TMDB request failed',
    }
  }
}

/**
 * Episode list from TMDB seasons API.
 * Uses the same public key as RiveStream's client (metadata only).
 */
export async function fetchTmdbTvEpisodeList(
  tmdbId: string,
): Promise<{
  tmdbId: string
  episodes: TmdbTvEpisodeInfo[]
  description?: string
  error?: string
}> {
  const id = String(tmdbId || '').trim()
  if (!id) {
    return { tmdbId: '', episodes: [], error: 'Missing TMDB id' }
  }

  // Same public TMDB key used by RiveStream's client (metadata / episode lists).
  const apiKey = 'd64117f26031a428449f102ced3aba73'

  const showUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}?api_key=${apiKey}&language=en-US`
  const show = await fetchJson(showUrl)
  if (!show.ok || !show.data || typeof show.data !== 'object') {
    return { tmdbId: id, episodes: [], error: show.error || 'TMDB show unavailable' }
  }

  const data = show.data as {
    overview?: string
    number_of_seasons?: number
    seasons?: Array<{ season_number?: number; episode_count?: number }>
  }
  const overview = String(data.overview || '').replace(/\s+/g, ' ').trim()
  const seasonNums = (data.seasons || [])
    .map((s) => Number(s.season_number))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .sort((a, b) => a - b)

  const seasons =
    seasonNums.length > 0
      ? seasonNums
      : Array.from({ length: Math.max(1, Number(data.number_of_seasons) || 1) }, (_, i) => i + 1)

  const episodes: TmdbTvEpisodeInfo[] = []
  for (const season of seasons) {
    const seasonUrl =
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}/season/${season}` +
      `?api_key=${apiKey}&language=en-US`
    const seasonJson = await fetchJson(seasonUrl)
    if (!seasonJson.ok || !seasonJson.data || typeof seasonJson.data !== 'object') continue
    const eps = (seasonJson.data as { episodes?: Array<{ episode_number?: number; name?: string }> })
      .episodes
    if (!Array.isArray(eps)) continue
    for (const ep of eps) {
      const episode = Number(ep.episode_number)
      if (!Number.isFinite(episode) || episode < 1) continue
      const key = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      episodes.push({
        key,
        season,
        episode,
        title: String(ep.name || '').trim() || `Episode ${episode}`,
      })
    }
  }

  return {
    tmdbId: id,
    episodes,
    description: overview || undefined,
    error: episodes.length === 0 ? 'No episodes found on TMDB' : undefined,
  }
}
