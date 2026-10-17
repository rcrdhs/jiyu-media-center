/**
 * Curated Kids shelf (under 13): allowlists, YTS safety filter, shelf tags.
 */

import type { StreamItem } from '../types'

export const KIDS_SHELF_MOVIES = 'kids-movies'
export const KIDS_SHELF_SHOWS = 'kids-shows'
export const KIDS_SHELF_LIVE = 'kids-live'
/**
 * Kids movie that dropped out of the YTS kids feeds but is kept because the
 * user has it in Continue watching / Watch history / Saved. Hidden from the
 * Kids Movies shelf; the row stays so those lists still resolve and play it.
 */
export const KIDS_RETIRED_TAG = 'kids-retired'

/** YTS genres crawled for Kids Movies (Popular + New passes). Extend here. */
export const YTS_KIDS_GENRES = ['Family', 'Animation'] as const
/** Kids New: latest uploads per genre (50/page) so new kids movies show up fast. */
export const YTS_KIDS_NEW_MAX_PAGES = 3
/** Kids New pass between full YTS syncs (light: only the date_added kids feeds). */
export const KIDS_NEW_PASS_INTERVAL_MS = 3 * 60 * 60 * 1000
/** Curated EZTV Kids Shows + TMDB Kids Shows refresh. */
export const KIDS_SHOWS_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Skip pruning when a full Kids sync returns fewer than this share of the old shelf. */
export const KIDS_PRUNE_MIN_RATIO = 0.5

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
 * Curated under-13 TV shows, probed against EZTV's open API (Kids -> Shows).
 * To add a show: append `{ imdb: '<IMDb digits, no tt>', name: '<display name>' }`.
 * Refreshed daily alongside TMDB Kids Shows (CatalogContext kids shows pass).
 *
 * (IMDb digits without requiring "tt" prefix consistency —
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

export function isRetiredKidsMovie(item: StreamItem): boolean {
  return isKidsMovieItem(item) && hasShelfTag(item, KIDS_RETIRED_TAG)
}

/** Kids Movies shelf rows: kids movies minus retired (hidden-but-retained) ones. */
export function isKidsMovieShelfItem(item: StreamItem): boolean {
  return isKidsMovieItem(item) && !hasShelfTag(item, KIDS_RETIRED_TAG)
}

/**
 * Re-check a stored Kids movie row against the current kids rules. Rows keep
 * title + genre slugs (no MPAA), so: title blocklist always; genre rules when
 * genres were captured; legacy rows without genres get the title check only.
 */
export function isKidsSafeStoredMovie(item: Pick<StreamItem, 'title' | 'genres'>): boolean {
  const title = String(item.title || '')
  if (KIDS_TITLE_BLOCKLIST.test(title)) return false
  const genres = (item.genres ?? []).map((g) => String(g))
  if (genres.length === 0) return true
  return isKidsSafeYtsMovie({ title, genres })
}

export interface KidsMoviePruneInput {
  /** Existing kids movie rows for the YTS source (before this sync's write). */
  existing: StreamItem[]
  /** Ids returned by this sync (all kids feeds, already kids-filtered). */
  seenIds: ReadonlySet<string>
  /** Kids movies returned by this sync. */
  incomingCount: number
  /** Every Kids Popular feed ran to its last page (not light / cancelled). */
  feedsComplete: boolean
  /** Any Kids Popular feed hit an error or skipped a page. */
  feedsErrored: boolean
  /** Continue watching / Watch history / Saved ids - retained, never deleted. */
  protectedIds: ReadonlySet<string>
}

export interface KidsMoviePrunePlan {
  pruned: boolean
  reason: string
  /** Rows to delete (unsafe, or unseen and unprotected after a complete sync). */
  deleteIds: string[]
  /** Unseen rows to keep as-is (prune skipped) - safe ones only. */
  keep: StreamItem[]
  /** Unseen protected rows kept but tagged retired (hidden from the shelf). */
  retire: StreamItem[]
}

/**
 * Decide what happens to Kids movie rows this sync did not return.
 * - Unsafe rows (fail today's kids rules) are always removed.
 * - Unseen safe rows are only pruned after a complete, error-free, non-thin sync;
 *   protected ones are retained hidden instead of deleted.
 */
export function planKidsMoviePrune(input: KidsMoviePruneInput): KidsMoviePrunePlan {
  const unseen = input.existing.filter(
    (item) => isKidsMovieItem(item) && !input.seenIds.has(item.id),
  )
  const unsafeIds = unseen.filter((item) => !isKidsSafeStoredMovie(item)).map((item) => item.id)
  const unsafe = new Set(unsafeIds)
  const safeUnseen = unseen.filter((item) => !unsafe.has(item.id))
  const previousActive = input.existing.filter(
    (item) => isKidsMovieItem(item) && !hasShelfTag(item, KIDS_RETIRED_TAG),
  ).length

  let reason = ''
  if (!input.feedsComplete) reason = 'kids feeds incomplete'
  else if (input.feedsErrored) reason = 'kids feed error'
  else if (input.incomingCount <= 0) reason = 'kids feeds empty'
  else if (previousActive > 0 && input.incomingCount < previousActive * KIDS_PRUNE_MIN_RATIO) {
    reason = `kids feeds thin (${input.incomingCount}/${previousActive})`
  }

  if (reason) {
    return { pruned: false, reason, deleteIds: unsafeIds, keep: safeUnseen, retire: [] }
  }

  const deleteIds = [...unsafeIds]
  const retire: StreamItem[] = []
  for (const item of safeUnseen) {
    if (input.protectedIds.has(item.id)) {
      retire.push(
        hasShelfTag(item, KIDS_RETIRED_TAG)
          ? item
          : { ...item, tags: [...(item.tags ?? []), KIDS_RETIRED_TAG] },
      )
    } else {
      deleteIds.push(item.id)
    }
  }
  return { pruned: true, reason: 'complete sync', deleteIds, keep: [], retire }
}

/**
 * Titles that open the movie detail page (synopsis + Watch) instead of playing
 * straight away: general Movies and Kids Movies alike.
 */
export function isMovieDetailItem(item: StreamItem): boolean {
  return item.category === 'movies' || isKidsMovieItem(item)
}

export function isKidsShowItem(item: StreamItem): boolean {
  if (item.category !== 'kids') return false
  if (hasShelfTag(item, KIDS_SHELF_SHOWS)) return true
  // TMDB Kids catalog rows always belong on Shows.
  return item.torrentSourceId === 'builtin-tmdb-kids'
}

export function isKidsLiveItem(item: StreamItem): boolean {
  if (item.category !== 'kids') return false
  if (hasShelfTag(item, KIDS_SHELF_LIVE)) return true
  // Untagged kids IPTV / builtins count as Live when not movie/show shelves.
  return !isKidsMovieItem(item) && !isKidsShowItem(item)
}
