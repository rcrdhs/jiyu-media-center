/**
 * Curated Kids shelf (under 13): allowlists, YTS safety filter, shelf tags.
 */

import type { StreamItem } from '../types'

export const KIDS_SHELF_MOVIES = 'kids-movies'
export const KIDS_SHELF_SHOWS = 'kids-shows'
export const KIDS_SHELF_LIVE = 'kids-live'

/** Feed URL for curated kids TV sync (EZTV by IMDb allowlist). */
export const KIDS_SHOWS_FEED_PREFIX = 'jiyu://kids-shows'

export function isKidsShowsFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(KIDS_SHOWS_FEED_PREFIX)
}

export function kidsShowsFeedUrl(eztvOrigin: string): string {
  return `${KIDS_SHOWS_FEED_PREFIX}?origin=${encodeURIComponent(eztvOrigin)}`
}

function hasShelfTag(item: StreamItem, tag: string): boolean {
  return Boolean(item.tags?.some((t) => t.toLowerCase() === tag.toLowerCase()))
}

/**
 * Curated under-13 TV shows (IMDb digits without requiring "tt" prefix consistency —
 * values include the tt prefix for clarity; strip when calling EZTV).
 */
export const KIDS_SHOW_ALLOWLIST: ReadonlyArray<{ imdb: string; name: string }> = [
  { imdb: '7678620', name: 'Bluey' },
  { imdb: '0383715', name: 'Peppa Pig' },
  { imdb: '2297757', name: 'PAW Patrol' },
  { imdb: '1116530', name: 'Curious George' },
  { imdb: '1615919', name: "Daniel Tiger's Neighborhood" },
  { imdb: '0424627', name: 'Dora the Explorer' },
  { imdb: '0197152', name: 'Arthur' },
  { imdb: '0063951', name: 'Sesame Street' },
  { imdb: '0460628', name: 'Little Einsteins' },
  { imdb: '0457433', name: 'The Backyardigans' },
  { imdb: '1832668', name: 'Bubble Guppies' },
  { imdb: '2937902', name: 'Doc McStuffins' },
  { imdb: '1695360', name: 'Phineas and Ferb' },
  { imdb: '0383126', name: 'SpongeBob SquarePants' },
  { imdb: '0319961', name: 'Avatar: The Last Airbender' },
  { imdb: '0086815', name: 'Thomas & Friends' },
  { imdb: '0169597', name: 'Teletubbies' },
  { imdb: '0383718', name: 'Fireman Sam' },
  { imdb: '0383717', name: 'Charlie and Lola' },
  { imdb: '0085007', name: 'Fraggle Rock' },
]

const BLOCKED_YTS_GENRES =
  /\b(horror|thriller|crime|war|western|film-?\s*noir|adult)\b/i
const BLOCKED_MPAA = /\b(PG-13|R|NC-17|X|TV-14|TV-MA)\b/i

/** Title substrings that must never land on Kids even if tagged Family. */
const KIDS_TITLE_BLOCKLIST =
  /\b(deadpool|john wick|saw\b|halloween|scream|purge|conjuring|annabelle|\bit\b|chucky|fifty shades|borat|\bted\b|sausage party|south park|family guy|american dad|rick and morty|game of thrones|walking dead)\b/i

export function isKidsSafeYtsMovie(movie: {
  title?: string
  title_long?: string
  genres?: string[]
  mpa_rating?: string
}): boolean {
  const title = `${movie.title || ''} ${movie.title_long || ''}`
  if (KIDS_TITLE_BLOCKLIST.test(title)) return false

  const mpaa = (movie.mpa_rating || '').trim()
  if (mpaa && BLOCKED_MPAA.test(mpaa)) return false

  const genres = (movie.genres || []).map((g) => String(g))
  if (genres.length === 0) return false
  if (genres.some((g) => BLOCKED_YTS_GENRES.test(g))) return false

  const hasAnimation = genres.some((g) => /^animation$/i.test(g.trim()))
  const hasFamily = genres.some((g) => /^family$/i.test(g.trim()))
  if (!hasAnimation && !hasFamily) return false

  // Adult-leaning animation often lacks Family + has hard MPAA — already blocked.
  // Prefer Family, or G/PG Animation.
  const softMpaa = !mpaa || /^(G|PG|TV-Y|TV-Y7|TV-G|TV-PG)$/i.test(mpaa)
  if (hasAnimation && !hasFamily && !softMpaa) return false
  return true
}

export function isKidsMovieItem(item: StreamItem): boolean {
  return item.category === 'kids' && hasShelfTag(item, KIDS_SHELF_MOVIES)
}

export function isKidsShowItem(item: StreamItem): boolean {
  return item.category === 'kids' && hasShelfTag(item, KIDS_SHELF_SHOWS)
}

export function isKidsLiveItem(item: StreamItem): boolean {
  if (item.category !== 'kids') return false
  if (hasShelfTag(item, KIDS_SHELF_LIVE)) return true
  // Untagged kids IPTV / builtins count as Live when not movie/show shelves.
  return !isKidsMovieItem(item) && !isKidsShowItem(item)
}
