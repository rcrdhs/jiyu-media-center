/**
 * TMDB discover/list fetch for Android (and any non-Electron shell).
 * Uses the same TMDB_API_KEY from .env (exposed via Vite envPrefix).
 * Desktop still prefers Electron IPC so the key stays in main process there.
 */

import { nativeFetchJson } from './nativeHttp'
import type { TmdbTvFeedKind } from './tmdbTv'
import { getTorrentSyncControlState, TorrentSyncCancelledError } from './torrentSyncControl'

export type ClientTmdbShow = {
  tmdbId: number
  name: string
  firstAirDate: string
  popularity: number
  imdbId: string
  overview: string
  poster: string
  originalLanguage?: string
  genreIds?: number[]
}

type TmdbRow = {
  id?: number
  name?: string
  original_name?: string
  first_air_date?: string
  popularity?: number
  overview?: string
  poster_path?: string
  original_language?: string
  genre_ids?: number[]
  media_type?: string
}

function throwIfCatalogSyncCancelled(): void {
  if (getTorrentSyncControlState().cancelling) {
    throw new TorrentSyncCancelledError()
  }
}

function tmdbApiKey(): string {
  const env = import.meta.env as Record<string, string | undefined>
  return String(env.TMDB_API_KEY || env.TMDB_KEY || env.VITE_TMDB_API_KEY || '').trim()
}

export function canFetchTmdbClientSide(): boolean {
  if (window.signalDesktop?.tmdbTvCatalog) return true
  return Boolean(tmdbApiKey())
}

function mapShow(show: TmdbRow, imdbId = ''): ClientTmdbShow {
  return {
    tmdbId: Number(show.id) || 0,
    name: show.name || show.original_name || '',
    firstAirDate: show.first_air_date || '',
    popularity: show.popularity ?? 0,
    imdbId,
    overview: String(show.overview || '')
      .replace(/\s+/g, ' ')
      .trim(),
    poster: show.poster_path ? `https://image.tmdb.org/t/p/w342${show.poster_path}` : '',
    originalLanguage: String(show.original_language || '').trim(),
    genreIds: Array.isArray(show.genre_ids)
      ? show.genre_ids.map((g) => Number(g)).filter((n) => Number.isFinite(n))
      : [],
  }
}

function buildDiscoverUrl(kind: TmdbTvFeedKind, page: number, year?: number): string {
  const apiKey = tmdbApiKey()
  if (kind === 'on_the_air') {
    const url = new URL('https://api.themoviedb.org/3/tv/on_the_air')
    url.searchParams.set('api_key', apiKey)
    url.searchParams.set('language', 'en-US')
    url.searchParams.set('page', String(page))
    return url.toString()
  }
  if (kind === 'trending') {
    const url = new URL('https://api.themoviedb.org/3/trending/tv/week')
    url.searchParams.set('api_key', apiKey)
    url.searchParams.set('language', 'en-US')
    url.searchParams.set('page', String(page))
    return url.toString()
  }
  const url = new URL('https://api.themoviedb.org/3/discover/tv')
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('language', 'en-US')
  url.searchParams.set('page', String(page))
  url.searchParams.set('include_null_first_air_dates', 'false')
  if (kind === 'by_year' && year) {
    url.searchParams.set('sort_by', 'popularity.desc')
    url.searchParams.set('first_air_date_year', String(year))
  } else if (kind === 'anime') {
    url.searchParams.set('with_genres', '16')
    url.searchParams.set('with_original_language', 'ja')
    url.searchParams.set('with_status', '3')
    url.searchParams.set('sort_by', 'popularity.desc')
  } else if (kind === 'animation') {
    url.searchParams.set('with_genres', '16')
    url.searchParams.set('sort_by', 'popularity.desc')
  } else if (kind === 'kids') {
    url.searchParams.set('with_genres', '10762')
    url.searchParams.set('sort_by', 'popularity.desc')
    url.searchParams.set('without_genres', '10767,10763')
  } else {
    // popular
    url.searchParams.set('sort_by', 'popularity.desc')
    url.searchParams.set('first_air_date.gte', '2010-01-01')
  }
  return url.toString()
}

/**
 * Fetch a TMDB TV catalog without Electron. Progress is best-effort via onProgress.
 * Caps pages on Android to keep first sync usable on mobile networks.
 */
export async function fetchTmdbTvCatalogClient(
  kind: TmdbTvFeedKind,
  limit = 500,
  options?: {
    withExternalIds?: boolean
    onProgress?: (done: number, total: number) => void
  },
): Promise<{ ok: boolean; shows: ClientTmdbShow[]; error?: string | null; cancelled?: boolean }> {
  const apiKey = tmdbApiKey()
  if (!apiKey) {
    return {
      ok: false,
      shows: [],
      error: 'TMDB_API_KEY missing — add it to .env and rebuild the Android app',
    }
  }

  // Same ceilings as Electron main — Android used to truncate Popular (~400),
  // which left Series ~2–3k titles short of desktop.
  const hardCap =
    kind === 'animation' ? 10000 : kind === 'by_year' ? 800 : 5000
  const target = Math.max(1, Math.min(hardCap, Number(limit) || 500))
  const pageSize = 20
  const shows: TmdbRow[] = []
  const onProgress = options?.onProgress

  try {
    if (kind === 'by_year') {
      const byYearStart = 2000
      const byYearPerYear = 20
      const byYearEnd = new Date().getFullYear()
      const years: number[] = []
      for (let y = byYearEnd; y >= byYearStart; y -= 1) years.push(y)
      const yearTarget = Math.min(target, years.length * byYearPerYear)
      const seen = new Set<number>()
      onProgress?.(0, yearTarget)
      for (let i = 0; i < years.length && shows.length < yearTarget; i += 1) {
        throwIfCatalogSyncCancelled()
        const year = years[i]!
        const { ok, data, error } = await nativeFetchJson<{ results?: TmdbRow[] }>(
          buildDiscoverUrl(kind, 1, year),
        )
        if (!ok || !data) {
          return { ok: false, shows: [], error: error || `TMDB by_year ${year} failed` }
        }
        const results = Array.isArray(data.results) ? data.results : []
        let taken = 0
        for (const row of results) {
          if (taken >= byYearPerYear || shows.length >= yearTarget) break
          const id = row?.id
          if (!id || seen.has(id)) continue
          seen.add(id)
          shows.push(row)
          taken += 1
        }
        onProgress?.(Math.min(shows.length, yearTarget), yearTarget)
      }
    } else {
      const pagesNeeded = Math.ceil(target / pageSize)
      onProgress?.(0, target)
      for (let page = 1; page <= pagesNeeded; page += 1) {
        throwIfCatalogSyncCancelled()
        const { ok, data, error } = await nativeFetchJson<{
          results?: TmdbRow[]
          total_pages?: number
        }>(buildDiscoverUrl(kind, page))
        if (!ok || !data) {
          return { ok: false, shows: [], error: error || `TMDB ${kind} failed` }
        }
        const results = Array.isArray(data.results) ? data.results : []
        if (results.length === 0) break
        const tvRows =
          kind === 'trending'
            ? results.filter((row) => !row.media_type || row.media_type === 'tv')
            : results
        shows.push(...tvRows)
        onProgress?.(Math.min(shows.length, target), target)
        const totalPages = Number(data.total_pages) || pagesNeeded
        if (page >= totalPages) break
      }
    }
  } catch (err) {
    if (err instanceof TorrentSyncCancelledError) {
      return { ok: false, shows: [], error: 'Catalog sync cancelled', cancelled: true }
    }
    return {
      ok: false,
      shows: [],
      error: err instanceof Error ? err.message : 'TMDB catalog failed',
    }
  }

  const top = shows.slice(0, target)
  const withExternalIds = options?.withExternalIds === true
  if (!withExternalIds) {
    const out = top.map((s) => mapShow(s)).filter((s) => s.tmdbId && s.name)
    onProgress?.(out.length, out.length)
    return { ok: true, shows: out, error: null }
  }

  // IMDb enrichment (EZTV path) — sequential batches to avoid hammering TMDB on mobile.
  const out: ClientTmdbShow[] = []
  for (let i = 0; i < top.length; i += 1) {
    const show = top[i]!
    let imdbId = ''
    try {
      const extUrl = new URL(`https://api.themoviedb.org/3/tv/${show.id}/external_ids`)
      extUrl.searchParams.set('api_key', apiKey)
      const ext = await nativeFetchJson<{ imdb_id?: string }>(extUrl.toString())
      if (ext.ok && ext.data?.imdb_id) {
        imdbId = String(ext.data.imdb_id).replace(/^tt/i, '')
      }
    } catch {
      /* ignore */
    }
    out.push(mapShow(show, imdbId))
    if (i % 10 === 0) onProgress?.(i + 1, top.length)
  }
  onProgress?.(out.length, out.length)
  return { ok: true, shows: out.filter((s) => s.tmdbId && s.name), error: null }
}
