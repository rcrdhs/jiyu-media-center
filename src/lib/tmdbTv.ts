/**
 * TMDB TV catalog for Jiyu Series shelves + RiveStream playback.
 * Sync uses Electron's TMDB key (no Cloudflare). Play resolves via rivestream.ts.
 */

import type { TorrentPageLink } from './torrents'
import type { StreamItem } from '../types'
import { genresFromTmdbIds } from './genres'
import { normalizeTitleKey } from './dedupe'

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

/** Same public TMDB key used by RiveStream's client (metadata / episode lists / networks). */
const TMDB_PUBLIC_API_KEY = 'd64117f26031a428449f102ced3aba73'

/**
 * Series discover pages (20/page, TMDB max ~500 pages).
 * Animation (incl. anime) is excluded via without_genres=16 — anime stays on Anime.
 */
export const TMDB_TV_POPULAR_LIMIT = 10000
export const TMDB_TV_AIRING_LIMIT = 500
export const TMDB_TV_TRENDING_LIMIT = 100
/** Top 20 / year from 2000 → current (~27×20). */
export const TMDB_TV_BY_YEAR_START = 2000
export const TMDB_TV_BY_YEAR_PER_YEAR = 20
export const TMDB_TV_BY_YEAR_LIMIT = 800
/** JP animation discover for Anime → Full Shows (Ended / complete series only). */
export const TMDB_ANIME_FULL_LIMIT = 5000
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
  if (kind === 'animation') return 10000
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
  const { hideSectionForTmdbTvKind, tmdbWithoutKeywordsParam } = await import(
    './hideKeywords'
  )
  const withoutKeywords = tmdbWithoutKeywordsParam(hideSectionForTmdbTvKind(kind))
  if (desktopCatalog) {
    const stop = window.signalDesktop?.onTmdbProgress?.((p) => {
      onProgress?.(p.done, p.total || limit)
    })
    try {
      // Skip IMDb enrichment — Rive only needs TMDB ids (much faster).
      result = await desktopCatalog(kind, limit, {
        withExternalIds: false,
        withoutKeywords: withoutKeywords || undefined,
      })
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
  const seriesOnly = !isAnime && !isKids && kind === 'popular'
  for (const show of result.shows || []) {
    const id = String(show.tmdbId || '').trim()
    const title = String(show.name || '').trim()
    if (!id || !title || seen.has(id)) continue
    // Belt-and-suspenders: Series shelf must not ingest Animation/anime rows.
    if (seriesOnly) {
      const genres = Array.isArray(show.genreIds) ? show.genreIds : []
      if (genres.includes(16)) continue
    }
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
    const originalLanguage = String(show.originalLanguage || '')
      .trim()
      .toLowerCase()
    const genres = genresFromTmdbIds(show.genreIds)
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
      ...(originalLanguage ? { originalLanguage } : {}),
      ...(genres.length ? { genres } : {}),
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
  const desktop =
    typeof window !== 'undefined' ? window.signalDesktop?.fetchJsonGet : undefined
  if (desktop) {
    const result = await desktop(url, 'https://www.themoviedb.org/')
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
  // Android WebView fetch often fails / stalls on TMDB — use CapacitorHttp.
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJson } = await import('./nativeHttp')
      const result = await nativeFetchJson<unknown>(url, {
        referer: 'https://www.themoviedb.org/',
      })
      if (!result.ok) return { ok: false, data: null, error: result.error || 'TMDB request failed' }
      return { ok: true, data: result.data, error: '' }
    }
  } catch {
    /* fall through */
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

/** In-memory episode list cache — One Piece is ~23 season round-trips. */
const episodeListCache = new Map<
  string,
  { at: number; result: Awaited<ReturnType<typeof fetchTmdbTvEpisodeList>> }
>()
const EPISODE_LIST_CACHE_TTL_MS = 30 * 60_000

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await worker(items[i]!)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => run()))
  return out
}

/**
 * Episode list from TMDB seasons API.
 * Uses the same public key as RiveStream's client (metadata only).
 */
export type TmdbTvNetworkInfo = {
  name: string
  /** Absolute TMDB image URL, when logo_path is present. */
  logoUrl?: string
}

/** True when a TMDB episode's air_date (YYYY-MM-DD) is today or earlier (UTC). */
function tmdbEpisodeHasAired(airDate: string | null | undefined, seasonHasDates: boolean): boolean {
  const raw = String(airDate || '').trim()
  if (!raw) return !seasonHasDates
  const t = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(t)) return true
  return t <= Date.now()
}

export async function fetchTmdbTvEpisodeList(
  tmdbId: string,
): Promise<{
  tmdbId: string
  episodes: TmdbTvEpisodeInfo[]
  description?: string
  networks?: TmdbTvNetworkInfo[]
  error?: string
}> {
  const id = String(tmdbId || '').trim()
  if (!id) {
    return { tmdbId: '', episodes: [], error: 'Missing TMDB id' }
  }

  const cached = episodeListCache.get(id)
  if (cached && Date.now() - cached.at < EPISODE_LIST_CACHE_TTL_MS && cached.result.episodes.length > 0) {
    return cached.result
  }

  // Same public TMDB key used by RiveStream's client (metadata / episode lists).
  const apiKey = TMDB_PUBLIC_API_KEY

  const showUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}?api_key=${apiKey}&language=en-US`
  const show = await fetchJson(showUrl)
  if (!show.ok || !show.data || typeof show.data !== 'object') {
    return { tmdbId: id, episodes: [], error: show.error || 'TMDB show unavailable' }
  }

  const data = show.data as {
    overview?: string
    number_of_seasons?: number
    seasons?: Array<{ season_number?: number; episode_count?: number }>
    networks?: Array<{ name?: string; logo_path?: string | null }>
  }
  const overview = String(data.overview || '').replace(/\s+/g, ' ').trim()
  const networks: TmdbTvNetworkInfo[] = []
  for (const row of data.networks || []) {
    const name = String(row.name || '').trim()
    if (!name) continue
    const logoPath = String(row.logo_path || '').trim()
    networks.push({
      name,
      logoUrl: logoPath
        ? `https://image.tmdb.org/t/p/w154${logoPath.startsWith('/') ? '' : '/'}${logoPath}`
        : undefined,
    })
  }
  const seasonRows = (data.seasons || [])
    .map((s) => ({
      season: Number(s.season_number),
      episodeCount: Math.max(0, Number(s.episode_count) || 0),
    }))
    .filter((s) => Number.isFinite(s.season) && s.season >= 1)
    .sort((a, b) => a.season - b.season)

  const seasons =
    seasonRows.length > 0
      ? seasonRows.map((s) => s.season)
      : Array.from({ length: Math.max(1, Number(data.number_of_seasons) || 1) }, (_, i) => i + 1)

  // Fetch each season's real episode_number values. One Piece (and some other
  // long runners) use *absolute* episode numbers on TMDB (S09E292), not 1..N
  // within the season. Pre-seeding relative 1..episode_count doubled the list
  // (~2299) and sent Movy the wrong episodeId (S06E158 instead of S09E292).
  const byKey = new Map<string, TmdbTvEpisodeInfo>()
  const fetchedSeasons = new Set<number>()

  // Parallel season crawl (Android OkHttp) — sequential 23× round-trips felt empty.
  const seasonResults = await mapPool(seasons, 5, async (season) => {
    const seasonUrl =
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}/season/${season}` +
      `?api_key=${apiKey}&language=en-US`
    let seasonJson = await fetchJson(seasonUrl)
    if (!seasonJson.ok) {
      await new Promise((r) => setTimeout(r, 350))
      seasonJson = await fetchJson(seasonUrl)
    }
    return { season, seasonJson }
  })

  for (const { season, seasonJson } of seasonResults) {
    if (!seasonJson.ok || !seasonJson.data || typeof seasonJson.data !== 'object') continue
    const eps = (
      seasonJson.data as { episodes?: Array<{ episode_number?: number; name?: string; air_date?: string | null }> }
    ).episodes
    if (!Array.isArray(eps) || eps.length === 0) continue
    fetchedSeasons.add(season)
    // Unaired episodes have no stream anywhere yet; listing them only gives
    // "Could not find a stream". A missing air_date means "TBA" when the
    // season has dated episodes; keep undated rows only for fully undated seasons.
    const seasonHasDates = eps.some((ep) => Boolean(ep.air_date))
    for (const ep of eps) {
      const episode = Number(ep.episode_number)
      if (!Number.isFinite(episode) || episode < 1) continue
      if (!tmdbEpisodeHasAired(ep.air_date, seasonHasDates)) continue
      const key = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      byKey.set(key, {
        key,
        season,
        episode,
        title: String(ep.name || '').trim() || `Episode ${episode}`,
      })
    }
  }

  // Relative 1..N placeholders only for seasons TMDB failed to return — never
  // merge them with absolute episode_number rows from a successful fetch.
  for (const row of seasonRows) {
    if (fetchedSeasons.has(row.season) || row.episodeCount < 1) continue
    for (let episode = 1; episode <= row.episodeCount; episode += 1) {
      const key = `S${String(row.season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        season: row.season,
        episode,
        title: `Episode ${episode}`,
      })
    }
  }

  const episodes = [...byKey.values()].sort((a, b) =>
    a.season !== b.season ? a.season - b.season : a.episode - b.episode,
  )

  const result = {
    tmdbId: id,
    episodes,
    description: overview || undefined,
    networks: networks.length > 0 ? networks : undefined,
    error: episodes.length === 0 ? 'No episodes found on TMDB' : undefined,
  }
  rememberTmdbTvNetworks(id, networks)
  if (episodes.length > 0) {
    episodeListCache.set(id, { at: Date.now(), result })
  }
  return result
}

/* ------------------------------------------------------------------------ */
/* Network (channel / streamer) labels for TV cards                          */
/* ------------------------------------------------------------------------ */

/**
 * Catalog list endpoints (popular / on_the_air / trending) don't include
 * networks, so cards look them up from `/tv/{id}` lazily - only for cards on
 * screen, two at a time, and remembered in localStorage so each show costs one
 * request per month (shared by every shelf + the show page).
 */
const NETWORK_CACHE_STORAGE_KEY = 'jiyu-tmdb-tv-networks-v1'
const NETWORK_CACHE_TTL_MS = 30 * 24 * 60 * 60_000
/** Shows TMDB lists without a network: re-check less often than never. */
const NETWORK_EMPTY_TTL_MS = 7 * 24 * 60 * 60_000
/** After a failed lookup, wait before asking TMDB again this session. */
const NETWORK_FAIL_RETRY_MS = 10 * 60_000
const NETWORK_CACHE_MAX = 4000
const NETWORK_FETCH_CONCURRENCY = 2

type NetworkCacheEntry = {
  /** Saved-at (ms). */
  a: number
  /** [name, logo_path?] pairs (paths keep storage small). */
  n: Array<[string, string?]>
}

let networkCache: Map<string, NetworkCacheEntry> | null = null
let networkSaveTimer: ReturnType<typeof setTimeout> | null = null
const networkInflight = new Map<string, Promise<TmdbTvNetworkInfo[] | undefined>>()
const networkFailedAt = new Map<string, number>()
const networkQueue: Array<() => void> = []
let networkActive = 0

function networkLogoUrl(path: string | undefined, size = 'w154'): string | undefined {
  const p = String(path || '').trim()
  if (!p) return undefined
  return `https://image.tmdb.org/t/p/${size}${p.startsWith('/') ? '' : '/'}${p}`
}

function networkLogoPath(url: string | undefined): string | undefined {
  const m = String(url || '').match(/\/t\/p\/[^/]+(\/.+)$/)
  return m?.[1] || undefined
}

function loadNetworkCache(): Map<string, NetworkCacheEntry> {
  if (networkCache) return networkCache
  networkCache = new Map()
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(NETWORK_CACHE_STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, NetworkCacheEntry>
      for (const [id, entry] of Object.entries(parsed || {})) {
        if (entry && typeof entry.a === 'number' && Array.isArray(entry.n)) networkCache.set(id, entry)
      }
    }
  } catch {
    /* corrupt cache - start fresh */
  }
  return networkCache
}

function scheduleNetworkCacheSave(): void {
  if (networkSaveTimer != null) return
  networkSaveTimer = setTimeout(() => {
    networkSaveTimer = null
    const cache = loadNetworkCache()
    // Oldest first out when the cache grows past the cap.
    if (cache.size > NETWORK_CACHE_MAX) {
      const sorted = [...cache.entries()].sort((x, y) => x[1].a - y[1].a)
      for (const [id] of sorted.slice(0, cache.size - NETWORK_CACHE_MAX)) cache.delete(id)
    }
    try {
      localStorage.setItem(NETWORK_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)))
    } catch {
      /* storage full / unavailable - in-memory cache still works */
    }
  }, 800)
}

/** Save networks for a TMDB TV id (also fed by the show page's full fetch). */
export function rememberTmdbTvNetworks(tmdbId: string, networks: TmdbTvNetworkInfo[] | undefined): void {
  const id = String(tmdbId || '').trim()
  if (!id) return
  const cache = loadNetworkCache()
  cache.set(id, {
    a: Date.now(),
    n: (networks || []).map((row) => {
      const path = networkLogoPath(row.logoUrl)
      return path ? [row.name, path] : [row.name]
    }),
  })
  networkFailedAt.delete(id)
  scheduleNetworkCacheSave()
}

/**
 * Cached networks for a TMDB TV id: `undefined` when unknown / stale,
 * `[]` when TMDB lists none.
 */
export function getCachedTmdbTvNetworks(
  tmdbId: string,
  logoSize = 'w154',
): TmdbTvNetworkInfo[] | undefined {
  const id = String(tmdbId || '').trim()
  if (!id) return undefined
  const entry = loadNetworkCache().get(id)
  if (!entry) return undefined
  const ttl = entry.n.length > 0 ? NETWORK_CACHE_TTL_MS : NETWORK_EMPTY_TTL_MS
  if (Date.now() - entry.a > ttl) return undefined
  return entry.n.map(([name, path]) => ({ name, logoUrl: networkLogoUrl(path, logoSize) }))
}

function runNetworkQueue(): void {
  while (networkActive < NETWORK_FETCH_CONCURRENCY && networkQueue.length > 0) {
    const job = networkQueue.shift()!
    networkActive += 1
    job()
  }
}

/**
 * Look up a show's networks (one light `/tv/{id}` request, queued 2 at a time).
 * `isWanted` lets a card that scrolled away drop out before its turn.
 */
export function loadTmdbTvNetworks(
  tmdbId: string,
  options: { isWanted?: () => boolean; logoSize?: string } = {},
): Promise<TmdbTvNetworkInfo[] | undefined> {
  const id = String(tmdbId || '').trim()
  if (!/^\d+$/.test(id)) return Promise.resolve(undefined)
  const cached = getCachedTmdbTvNetworks(id, options.logoSize)
  if (cached) return Promise.resolve(cached)
  const failedAt = networkFailedAt.get(id)
  if (failedAt && Date.now() - failedAt < NETWORK_FAIL_RETRY_MS) return Promise.resolve(undefined)
  const existing = networkInflight.get(id)
  if (existing) {
    return existing.then(() => getCachedTmdbTvNetworks(id, options.logoSize))
  }
  const promise = new Promise<TmdbTvNetworkInfo[] | undefined>((resolve) => {
    networkQueue.push(() => {
      void (async () => {
        try {
          if (options.isWanted && !options.isWanted()) {
            resolve(undefined)
            return
          }
          const fresh = getCachedTmdbTvNetworks(id, options.logoSize)
          if (fresh) {
            resolve(fresh)
            return
          }
          const url =
            `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}` +
            `?api_key=${TMDB_PUBLIC_API_KEY}&language=en-US`
          const res = await fetchJson(url)
          if (!res.ok || !res.data || typeof res.data !== 'object') {
            networkFailedAt.set(id, Date.now())
            resolve(undefined)
            return
          }
          const rows = (res.data as { networks?: Array<{ name?: string; logo_path?: string | null }> })
            .networks
          const networks: TmdbTvNetworkInfo[] = []
          for (const row of rows || []) {
            const name = String(row.name || '').trim()
            if (!name) continue
            networks.push({ name, logoUrl: networkLogoUrl(row.logo_path || undefined) })
          }
          rememberTmdbTvNetworks(id, networks)
          resolve(getCachedTmdbTvNetworks(id, options.logoSize))
        } catch {
          networkFailedAt.set(id, Date.now())
          resolve(undefined)
        } finally {
          networkActive -= 1
          runNetworkQueue()
        }
      })()
    })
    runNetworkQueue()
  })
  // Only share the request while it's in flight (a dropped "unwanted" job
  // must not block a later card that does want it).
  networkInflight.set(id, promise)
  void promise.finally(() => {
    if (networkInflight.get(id) === promise) networkInflight.delete(id)
  })
  return promise
}

/**
 * TMDB TV id for a show card, when one is known without extra lookups.
 * Series shelves (TMDB / Cinetaro / NetMirror) + TMDB Kids shows only - anime
 * ids are remapped at play time and movie ids would hit the wrong endpoint.
 */
type CardTmdbFields = Pick<
  StreamItem,
  | 'title'
  | 'category'
  | 'torrentSourceId'
  | 'rivestreamTmdbId'
  | 'cinetaroTmdbId'
  | 'netmirrorTmdbId'
  | 'url'
  | 'detailUrl'
  | 'releasedAt'
>

function directCardTmdbTvId(item: CardTmdbFields): string {
  const series = item.category === 'series'
  const kidsShow = item.category === 'kids' && item.torrentSourceId === TMDB_KIDS_SOURCE_ID
  if (!series && !kidsShow) return ''
  const id =
    String(item.rivestreamTmdbId || '').trim() ||
    String(item.cinetaroTmdbId || '').trim() ||
    String(item.netmirrorTmdbId || '').trim() ||
    tmdbTvIdFromUrl(item.url || '') ||
    tmdbTvIdFromUrl(item.detailUrl || '')
  return /^\d+$/.test(id) ? id : ''
}

/**
 * Title -> TMDB id from series rows that already carry one, so M2Box / other
 * id-less rows of the same show borrow it (zero requests). A title shared by
 * different TMDB shows is ambiguous (null) unless the release year settles it.
 */
const tmdbTvTitleIndex = new Map<string, string | null>()
let tmdbTvTitleIndexSource: readonly StreamItem[] | null = null

function seriesTitleKey(title: string): string {
  return normalizeTitleKey(String(title || '').replace(/\s*\((19|20)\d{2}\)\s*$/, ''))
}

function releaseYear(releasedAt: number | undefined): string {
  if (!releasedAt || !Number.isFinite(releasedAt)) return ''
  return String(new Date(releasedAt).getUTCFullYear())
}

function indexTitleKey(key: string, id: string): void {
  const prev = tmdbTvTitleIndex.get(key)
  if (prev === undefined) tmdbTvTitleIndex.set(key, id)
  else if (prev !== id) tmdbTvTitleIndex.set(key, null)
}

/** Rebuild the title index from the catalog's series rows (cheap, no network). */
export function indexTmdbTvTitles(items: readonly StreamItem[]): void {
  if (items === tmdbTvTitleIndexSource) return
  tmdbTvTitleIndexSource = items
  tmdbTvTitleIndex.clear()
  for (const item of items) {
    if (item.category !== 'series') continue
    const id = directCardTmdbTvId(item)
    if (!id) continue
    const key = seriesTitleKey(item.title)
    if (!key) continue
    indexTitleKey(key, id)
    const year = releaseYear(item.releasedAt)
    if (year) indexTitleKey(`${key}|${year}`, id)
  }
}

/**
 * TMDB TV id for a show card, when one is known without extra lookups.
 * Series shelves (TMDB / Cinetaro / NetMirror) + TMDB Kids shows only - anime
 * ids are remapped at play time and movie ids would hit the wrong endpoint.
 * Series rows without an id (M2Box) borrow one from a same-title TMDB row.
 */
export function cardTmdbTvId(item: CardTmdbFields): string {
  const direct = directCardTmdbTvId(item)
  if (direct || item.category !== 'series' || tmdbTvTitleIndex.size === 0) return direct
  const key = seriesTitleKey(item.title)
  if (!key) return ''
  const year = releaseYear(item.releasedAt)
  const byYear = year ? tmdbTvTitleIndex.get(`${key}|${year}`) : undefined
  if (byYear) return byYear
  return tmdbTvTitleIndex.get(key) || ''
}

/**
 * Title -> TMDB TV id for series rows with no id and no same-title TMDB row in
 * the catalog (M2Box Popular). One `/search/tv` per show, only for cards on
 * screen, same 2-at-a-time queue, remembered ~30 days (misses ~7 days).
 */
const TITLE_ID_CACHE_STORAGE_KEY = 'jiyu-tmdb-tv-title-ids-v1'

type TitleIdCacheEntry = {
  /** Saved-at (ms). */
  a: number
  /** TMDB TV id, '' when TMDB had no confident match. */
  i: string
}

let titleIdCache: Map<string, TitleIdCacheEntry> | null = null
let titleIdSaveTimer: ReturnType<typeof setTimeout> | null = null
const titleIdInflight = new Map<string, Promise<string | undefined>>()
const titleIdFailedAt = new Map<string, number>()

function titleLookupKey(title: string, releasedAt?: number): string {
  const key = seriesTitleKey(title)
  if (!key) return ''
  const year = releaseYear(releasedAt)
  return year ? `${key}|${year}` : key
}

function loadTitleIdCache(): Map<string, TitleIdCacheEntry> {
  if (titleIdCache) return titleIdCache
  titleIdCache = new Map()
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TITLE_ID_CACHE_STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, TitleIdCacheEntry>
      for (const [key, entry] of Object.entries(parsed || {})) {
        if (entry && typeof entry.a === 'number' && typeof entry.i === 'string') titleIdCache.set(key, entry)
      }
    }
  } catch {
    /* corrupt cache - start fresh */
  }
  return titleIdCache
}

function scheduleTitleIdCacheSave(): void {
  if (titleIdSaveTimer != null) return
  titleIdSaveTimer = setTimeout(() => {
    titleIdSaveTimer = null
    const cache = loadTitleIdCache()
    if (cache.size > NETWORK_CACHE_MAX) {
      const sorted = [...cache.entries()].sort((x, y) => x[1].a - y[1].a)
      for (const [key] of sorted.slice(0, cache.size - NETWORK_CACHE_MAX)) cache.delete(key)
    }
    try {
      localStorage.setItem(TITLE_ID_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)))
    } catch {
      /* storage full / unavailable - in-memory cache still works */
    }
  }, 800)
}

/**
 * Known TMDB TV id for a show title: the id, `''` when TMDB had no confident
 * match (recently), `undefined` when it hasn't been looked up.
 */
export function getCachedTmdbTvIdForTitle(title: string, releasedAt?: number): string | undefined {
  const key = titleLookupKey(title, releasedAt)
  if (!key) return ''
  const entry = loadTitleIdCache().get(key)
  if (!entry) return undefined
  const ttl = entry.i ? NETWORK_CACHE_TTL_MS : NETWORK_EMPTY_TTL_MS
  if (Date.now() - entry.a > ttl) return undefined
  return entry.i
}

type TmdbTvSearchRow = { id?: number; name?: string; original_name?: string; first_air_date?: string }

/** Exact (normalized) title match only; the release year breaks ties. */
function pickTmdbTvSearchMatch(rows: TmdbTvSearchRow[], title: string, releasedAt?: number): string {
  const key = seriesTitleKey(title)
  const exact = rows.filter(
    (row) =>
      row.id &&
      (seriesTitleKey(row.name || '') === key || seriesTitleKey(row.original_name || '') === key),
  )
  if (exact.length === 0) return ''
  const year = Number(releaseYear(releasedAt))
  if (year) {
    const rowYear = (row: TmdbTvSearchRow) => Number(String(row.first_air_date || '').slice(0, 4)) || 0
    const sameYear = exact.find((row) => rowYear(row) === year)
    if (sameYear) return String(sameYear.id)
    // M2Box dates can be a later season's: accept an earlier premiere too.
    const earlier = exact.find((row) => rowYear(row) > 0 && rowYear(row) <= year)
    if (earlier) return String(earlier.id)
    return ''
  }
  return String(exact[0].id)
}

/** Resolve a show title to a TMDB TV id (one `/search/tv`, queued with network lookups). */
export function resolveTmdbTvIdForTitle(
  title: string,
  releasedAt?: number,
  options: { isWanted?: () => boolean } = {},
): Promise<string | undefined> {
  const key = titleLookupKey(title, releasedAt)
  if (!key) return Promise.resolve('')
  const cached = getCachedTmdbTvIdForTitle(title, releasedAt)
  if (cached !== undefined) return Promise.resolve(cached)
  const failedAt = titleIdFailedAt.get(key)
  if (failedAt && Date.now() - failedAt < NETWORK_FAIL_RETRY_MS) return Promise.resolve(undefined)
  const existing = titleIdInflight.get(key)
  if (existing) return existing.then(() => getCachedTmdbTvIdForTitle(title, releasedAt))
  const query = String(title || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim()
  const promise = new Promise<string | undefined>((resolve) => {
    networkQueue.push(() => {
      void (async () => {
        try {
          if (options.isWanted && !options.isWanted()) {
            resolve(undefined)
            return
          }
          const fresh = getCachedTmdbTvIdForTitle(title, releasedAt)
          if (fresh !== undefined) {
            resolve(fresh)
            return
          }
          const url =
            `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_PUBLIC_API_KEY}` +
            `&language=en-US&include_adult=false&page=1&query=${encodeURIComponent(query)}`
          const res = await fetchJson(url)
          if (!res.ok || !res.data || typeof res.data !== 'object') {
            titleIdFailedAt.set(key, Date.now())
            resolve(undefined)
            return
          }
          const rows = (res.data as { results?: TmdbTvSearchRow[] }).results || []
          const id = pickTmdbTvSearchMatch(rows, title, releasedAt)
          loadTitleIdCache().set(key, { a: Date.now(), i: id })
          scheduleTitleIdCacheSave()
          resolve(id)
        } catch {
          titleIdFailedAt.set(key, Date.now())
          resolve(undefined)
        } finally {
          networkActive -= 1
          runNetworkQueue()
        }
      })()
    })
    runNetworkQueue()
  })
  titleIdInflight.set(key, promise)
  void promise.finally(() => {
    if (titleIdInflight.get(key) === promise) titleIdInflight.delete(key)
  })
  return promise
}
