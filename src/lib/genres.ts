/**
 * Canonical genre slugs for recommendations.
 *
 * Catalog builders map TMDB `genre_ids`, YTS genre names and M2Box genre
 * strings into these slugs (`StreamItem.genres`). Provider, transport and
 * shelf tags (cinetaro, torrent, popular-movies, …) are never genres.
 */

/** TMDB movie + TV genre ids → slugs (TV combos expand to two slugs). */
const TMDB_GENRE_IDS: Record<number, string[]> = {
  28: ['action'],
  12: ['adventure'],
  16: ['animation'],
  35: ['comedy'],
  80: ['crime'],
  99: ['documentary'],
  18: ['drama'],
  10751: ['family'],
  14: ['fantasy'],
  36: ['history'],
  27: ['horror'],
  10402: ['music'],
  9648: ['mystery'],
  10749: ['romance'],
  878: ['sci-fi'],
  53: ['thriller'],
  10752: ['war'],
  37: ['western'],
  10759: ['action', 'adventure'],
  10762: ['kids'],
  10763: ['news'],
  10764: ['reality'],
  10765: ['sci-fi', 'fantasy'],
  10766: ['soap'],
  10767: ['talk'],
  10768: ['war', 'politics'],
}

/** Name variants (lowercased) → slug. */
const GENRE_ALIASES: Record<string, string> = {
  action: 'action',
  adventure: 'adventure',
  animation: 'animation',
  animated: 'animation',
  comedy: 'comedy',
  crime: 'crime',
  documentary: 'documentary',
  drama: 'drama',
  family: 'family',
  fantasy: 'fantasy',
  history: 'history',
  historical: 'history',
  horror: 'horror',
  music: 'music',
  musical: 'music',
  mystery: 'mystery',
  romance: 'romance',
  'science fiction': 'sci-fi',
  'sci-fi': 'sci-fi',
  scifi: 'sci-fi',
  'sci fi': 'sci-fi',
  thriller: 'thriller',
  suspense: 'thriller',
  war: 'war',
  western: 'western',
  kids: 'kids',
  news: 'news',
  reality: 'reality',
  'reality-tv': 'reality',
  soap: 'soap',
  talk: 'talk',
  politics: 'politics',
  biography: 'biography',
  sport: 'sport',
  sports: 'sport',
}

const GENRE_LABELS: Record<string, string> = {
  'sci-fi': 'Sci-Fi',
  kids: 'Kids',
}

/** TMDB genre ids → slugs (unknown ids dropped, de-duplicated). */
export function genresFromTmdbIds(ids: ReadonlyArray<number | string> | undefined): string[] {
  const out = new Set<string>()
  for (const raw of ids ?? []) {
    for (const slug of TMDB_GENRE_IDS[Number(raw)] ?? []) out.add(slug)
  }
  return [...out]
}

/**
 * Genre names / slugs ("Sci-Fi & Fantasy", "Action, Drama", "science fiction")
 * → slugs. Anything that isn't a known genre (providers, shelves) is dropped.
 * Idempotent on slugs.
 */
export function normalizeGenres(values: ReadonlyArray<string | null | undefined> | undefined): string[] {
  const out = new Set<string>()
  for (const value of values ?? []) {
    for (const part of String(value || '')
      .toLowerCase()
      .split(/\s*(?:&|,|\/|\|)\s*|\s+and\s+/)) {
      const slug = GENRE_ALIASES[part.trim()]
      if (slug) out.add(slug)
    }
  }
  return [...out]
}

/** "sci-fi" → "Sci-Fi", "drama" → "Drama". */
export function genreLabel(slug: string): string {
  return GENRE_LABELS[slug] ?? slug.replace(/(^|[-\s])(\w)/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}
