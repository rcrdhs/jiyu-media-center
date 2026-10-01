/**
 * Movies shelf search fallback — mirror anime→Nyaa.
 * 1) Live YTS query (titles not yet synced into the local catalog)
 * 2) If YTS has nothing, TMDB + Cinetaro / cinextream movie embed
 * 3) Best-effort YMovies /film/ search as a last resort
 */

import type { StreamItem } from '../types'
import {
  cinetaroCinextreamMovieEmbedUrl,
  cinetaroMovieDetailUrl,
} from './cinetaro'
import { scrapePage, linkToCatalogItem, MOVIES_SHELF_NEW, MOVIES_SHELF_POPULAR, type TorrentSource } from './torrents'
import { parseYmoviesListHtml, YMOVIES_CATALOG_ORIGIN } from './ymovies'
import { zenoxMediaUrl } from './zenox'

const YTS_SHELF_SOURCE: TorrentSource = {
  id: 'builtin-yts',
  label: 'YTS',
  url: 'https://yts.gg/',
}

const CINETARO_MOVIE_SOURCE: TorrentSource = {
  id: 'builtin-cinetaro',
  label: 'Cinetaro',
  url: 'https://cinetaro.to/',
}

const ZENOX_MOVIE_SOURCE: TorrentSource = {
  id: 'builtin-zenox-movies',
  label: 'Zenox',
  url: 'https://zenox.lol/movies',
}

const YMOVIES_MOVIE_SOURCE: TorrentSource = {
  id: 'builtin-ymovies',
  label: 'YMovies',
  url: YMOVIES_CATALOG_ORIGIN + '/',
}

/** Same public TMDB key Rive / Cinetaro metadata already use. */
const TMDB_API = 'https://api.themoviedb.org/3'
const TMDB_KEY = 'd64117f26031a428449f102ced3aba73'
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500'

function ytsSearchApiUrl(query: string): string {
  const url = new URL('https://yts.gg/api/v2/list_movies.json')
  url.searchParams.set('limit', '20')
  url.searchParams.set('page', '1')
  url.searchParams.set('sort_by', 'download_count')
  url.searchParams.set('order_by', 'desc')
  url.searchParams.set('query_term', query.trim())
  return url.toString()
}

async function fetchJson(url: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    if (window.signalDesktop?.fetchHtml) {
      const result = await window.signalDesktop.fetchHtml(url, { quiet: true })
      if (!result.ok || !result.content) {
        return { ok: false, error: result.error || 'Fetch failed' }
      }
      return { ok: true, data: JSON.parse(result.content) }
    }
    const res = await fetch(url)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

export type MoviesShelfTarget = 'popular' | 'new'

function shelfTagForTarget(target: MoviesShelfTarget): string {
  return target === 'popular' ? MOVIES_SHELF_POPULAR : MOVIES_SHELF_NEW
}

/** Retag live-search hits for Popular Movies or New Movies. */
export function applyMoviesShelfTarget(
  movies: StreamItem[],
  target: MoviesShelfTarget,
): StreamItem[] {
  const want = shelfTagForTarget(target)
  const drop = target === 'popular' ? MOVIES_SHELF_NEW : MOVIES_SHELF_POPULAR
  return movies.map((item) => {
    const tags = (item.tags || []).filter(
      (t) => t.toLowerCase() !== drop.toLowerCase() && t.toLowerCase() !== want.toLowerCase(),
    )
    tags.push(want)
    return { ...item, tags }
  })
}

async function searchYtsMovies(query: string, shelfTag: string): Promise<StreamItem[]> {
  const outcome = await scrapePage(ytsSearchApiUrl(query), 'YTS')
  if (outcome.error && outcome.links.length === 0) return []
  return outcome.links
    .filter((link) => (link.category || 'movies') === 'movies' || !link.category)
    .map((link) =>
      linkToCatalogItem(
        { ...link, category: 'movies', shelfTag },
        YTS_SHELF_SOURCE,
        'movies',
        shelfTag,
      ),
    )
}

type TmdbMovieHit = {
  id?: number
  title?: string
  name?: string
  overview?: string
  poster_path?: string | null
  release_date?: string
}

async function searchCinetaroMovies(query: string, shelfTag: string): Promise<StreamItem[]> {
  const url =
    `${TMDB_API}/search/movie?api_key=${encodeURIComponent(TMDB_KEY)}` +
    `&query=${encodeURIComponent(query.trim())}&include_adult=false&page=1`
  const fetched = await fetchJson(url)
  if (!fetched.ok) return []
  const results = (fetched.data as { results?: TmdbMovieHit[] })?.results
  if (!Array.isArray(results) || results.length === 0) return []

  const out: StreamItem[] = []
  for (const row of results.slice(0, 16)) {
    const tmdbId = String(row.id || '').trim()
    if (!tmdbId) continue
    const title = String(row.title || row.name || '').trim()
    if (!title) continue
    const year = String(row.release_date || '').slice(0, 4)
    const overview = String(row.overview || '')
      .replace(/\s+/g, ' ')
      .trim()
    const shortOverview =
      overview.length > 220
        ? `${overview.slice(0, 217).replace(/\s+\S*$/, '')}…`
        : overview
    const embedUrl = cinetaroCinextreamMovieEmbedUrl(tmdbId)
    const detailUrl = cinetaroMovieDetailUrl(tmdbId)
    const releasedAt = year ? Date.parse(`${year}-01-01T00:00:00Z`) : undefined
    out.push({
      id: `cinetaro-movie-${tmdbId}`,
      title: year ? `${title} (${year})` : title,
      description: shortOverview || (year ? String(year) : 'Movie'),
      category: 'movies',
      url: embedUrl,
      detailUrl,
      poster: row.poster_path ? `${TMDB_POSTER}${row.poster_path}` : undefined,
      tags: ['movies', 'cinetaro', 'web-embed', shelfTag],
      source: 'Cinetaro',
      sourceKind: 'builtin',
      transport: 'direct',
      torrentSourceId: CINETARO_MOVIE_SOURCE.id,
      cinetaroTmdbId: tmdbId,
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
    })
  }
  return out
}

async function searchZenoxMovies(query: string, shelfTag: string): Promise<StreamItem[]> {
  const url =
    `${TMDB_API}/search/movie?api_key=${encodeURIComponent(TMDB_KEY)}` +
    `&query=${encodeURIComponent(query.trim())}&include_adult=false&page=1`
  const fetched = await fetchJson(url)
  if (!fetched.ok) return []
  const results = (fetched.data as { results?: TmdbMovieHit[] })?.results
  if (!Array.isArray(results) || results.length === 0) return []

  const out: StreamItem[] = []
  for (const row of results.slice(0, 16)) {
    const tmdbId = String(row.id || '').trim()
    if (!tmdbId) continue
    const title = String(row.title || row.name || '').trim()
    if (!title) continue
    const year = String(row.release_date || '').slice(0, 4)
    const overview = String(row.overview || '')
      .replace(/\s+/g, ' ')
      .trim()
    const shortOverview =
      overview.length > 220
        ? `${overview.slice(0, 217).replace(/\s+\S*$/, '')}…`
        : overview
    const mediaUrl = zenoxMediaUrl(tmdbId, 'movie')
    const releasedAt = year ? Date.parse(`${year}-01-01T00:00:00Z`) : undefined
    out.push({
      id: `zenox-movie-${tmdbId}`,
      title: year ? `${title} (${year})` : title,
      description: shortOverview || (year ? String(year) : 'Movie'),
      category: 'movies',
      url: mediaUrl,
      detailUrl: `https://zenox.lol/movies`,
      poster: row.poster_path ? `${TMDB_POSTER}${row.poster_path}` : undefined,
      tags: ['movies', 'zenox', 'web-embed', shelfTag],
      source: 'Zenox',
      sourceKind: 'builtin',
      transport: 'direct',
      torrentSourceId: ZENOX_MOVIE_SOURCE.id,
      rivestreamTmdbId: tmdbId,
      cinetaroTmdbId: tmdbId,
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
    })
  }
  return out
}

async function searchYmoviesMovies(query: string, shelfTag: string): Promise<StreamItem[]> {
  const q = query.trim()
  if (!q) return []
  const candidates = [
    `${YMOVIES_CATALOG_ORIGIN}/search/${encodeURIComponent(q)}`,
    `${YMOVIES_CATALOG_ORIGIN}/movie/search/${encodeURIComponent(q)}`,
  ]
  const { nativeFetchText } = await import('./nativeHttp')
  for (const pageUrl of candidates) {
    try {
      const result = await nativeFetchText(pageUrl, {
        quiet: true,
        preferWebView: true,
        allowUnlock: false,
        headers: {
          Accept: 'text/html',
          Referer: `${YMOVIES_CATALOG_ORIGIN}/`,
        },
      })
      if (!result.ok || !result.content) continue
      const links = parseYmoviesListHtml(result.content, YMOVIES_CATALOG_ORIGIN)
      // Prefer rows that look like films (no season/episode badge text).
      const movies = links.filter((link) => !/\bSS\s*\d+/i.test(link.summary || ''))
      const use = movies.length > 0 ? movies : links
      if (use.length === 0) continue
      return use.slice(0, 16).map((link) =>
        linkToCatalogItem(
          {
            ...link,
            category: 'movies',
            summary: link.summary?.replace(/^TV Series( · )?/i, '') || 'Movie',
            shelfTag,
          },
          YMOVIES_MOVIE_SOURCE,
          'movies',
          shelfTag,
        ),
      )
    } catch {
      /* try next URL shape */
    }
  }
  return []
}

/**
 * Movies shelf search → live YTS, then Zenox (TMDB), then Cinetaro, then YMovies.
 * `target` chooses Popular Movies vs New Movies for where hits are filed.
 */
export async function searchMoviesForShelf(
  query: string,
  target: MoviesShelfTarget = 'new',
): Promise<
  | {
      ok: true
      movies: StreamItem[]
      query: string
      source: 'yts' | 'zenox' | 'cinetaro' | 'ymovies'
    }
  | { ok: false; error: string }
> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'Empty movie query' }
  const shelfTag = shelfTagForTarget(target)

  try {
    const yts = await searchYtsMovies(q, shelfTag)
    if (yts.length > 0) {
      return { ok: true, movies: applyMoviesShelfTarget(yts, target), query: q, source: 'yts' }
    }

    const zenox = await searchZenoxMovies(q, shelfTag)
    if (zenox.length > 0) {
      return {
        ok: true,
        movies: applyMoviesShelfTarget(zenox, target),
        query: q,
        source: 'zenox',
      }
    }

    const cinetaro = await searchCinetaroMovies(q, shelfTag)
    if (cinetaro.length > 0) {
      return {
        ok: true,
        movies: applyMoviesShelfTarget(cinetaro, target),
        query: q,
        source: 'cinetaro',
      }
    }

    const ymovies = await searchYmoviesMovies(q, shelfTag)
    if (ymovies.length > 0) {
      return {
        ok: true,
        movies: applyMoviesShelfTarget(ymovies, target),
        query: q,
        source: 'ymovies',
      }
    }

    return { ok: false, error: 'No movie results for this search.' }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Movie search failed',
    }
  }
}

/** Pull a fuller plot synopsis from YTS movie_details when the card only has a year. */
export async function fetchYtsMovieSynopsis(
  detailUrl: string | undefined,
): Promise<{ synopsis?: string; runtimeSeconds?: number } | null> {
  if (!detailUrl || !/yts\./i.test(detailUrl)) return null
  try {
    const url = new URL(detailUrl)
    if (!/movie_details\.json/i.test(url.pathname)) return null
    if (!url.searchParams.has('with_images')) {
      url.searchParams.set('with_images', 'true')
    }
    const fetched = await fetchJson(url.toString())
    if (!fetched.ok) return null
    const movie = (fetched.data as { data?: { movie?: {
      summary?: string
      description_full?: string
      runtime?: number
    } } })?.data?.movie
    if (!movie) return null
    const overview = String(movie.description_full || movie.summary || '')
      .replace(/\s+/g, ' ')
      .trim()
    const mins = Number(movie.runtime)
    return {
      synopsis: overview || undefined,
      runtimeSeconds:
        Number.isFinite(mins) && mins >= 1 ? Math.round(mins * 60) : undefined,
    }
  } catch {
    return null
  }
}

/** True when catalog description is missing or just a year. */
export function needsRicherMovieSynopsis(description?: string): boolean {
  const raw = String(description || '').trim()
  if (!raw) return true
  if (/^https?:\/\//i.test(raw)) return true
  if (/^\d{4}$/.test(raw)) return true
  if (/^(movie|film)$/i.test(raw)) return true
  return raw.length < 40
}
