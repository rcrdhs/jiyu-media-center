import type { CategoryId } from '../types'

const CACHE_KEY = 'jiyu.poster-fallback.v3'
const pending = new Map<string, Promise<string>>()
let queue = Promise.resolve()

type PosterCategory = Extract<CategoryId, 'movies' | 'series' | 'anime'>

function loadCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, string>
  } catch {
    return {}
  }
}

const cache = loadCache()

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // A missing poster should never prevent catalog rendering.
  }
}

function keyFor(category: PosterCategory, title: string): string {
  return `${category}:${title.trim().toLowerCase()}`
}

/** Strip release noise so metadata searches match the real title. */
export function cleanPosterSearchTitle(title: string, category: PosterCategory): string {
  let t = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:720|1080|2160|480|HEVC|x264|x265|WEB-?DL|BluRay|Batch)[^)]*\)/gi, ' ')
    .replace(
      /\b(?:720p|1080p|2160p|480p|4k|uhd|hevc|h\.?265|h\.?264|x264|x265|web-?dl|bluray|eztv|proper|repack)\b/gi,
      ' ',
    )

  if (category === 'series' || category === 'anime') {
    t = t.replace(/\bS\d{1,2}E\d{1,3}\b[\s\S]*$/i, ' ')
    t = t.replace(/\b\d{1,2}x\d{1,3}\b[\s\S]*$/i, ' ')
    t = t.replace(/\s+-\s+\d{1,4}(?:\s|$)/, ' ')
    t = t.replace(/\s+\d{1,4}$/, ' ')
  }

  // Drop trailing year for Wikipedia/TVMaze matching when present as a suffix
  t = t.replace(/\s+(?:19|20)\d{2}\s*$/, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * EZTV / listing screenshots and tiny thumbs are not useful show art — treat
 * them as missing so we can probe TVMaze / iTunes / Wikipedia instead.
 */
export function isWeakPosterUrl(url: string | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return true
  if (/ezimg\.|eztv[^/]*\.(?:to|ch|re|ag|it|wf)|\/screenshots?\//i.test(url)) return true
  if (/\/(?:small[_-]?cover|thumb(?:nail)?s?|mini)(?:[_./-]|\d{2,3}x\d{2,3})/i.test(url)) {
    return true
  }
  return false
}

async function searchAnimePoster(title: string): Promise<string> {
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query ($search: String) { Media(search: $search, type: ANIME) { coverImage { large extraLarge } } }',
        variables: { search: title },
      }),
    })
    if (!response.ok) return ''
    const json = (await response.json()) as {
      data?: {
        Media?: {
          coverImage?: { large?: string; extraLarge?: string }
        }
      }
    }
    return json.data?.Media?.coverImage?.extraLarge || json.data?.Media?.coverImage?.large || ''
  } catch {
    return ''
  }
}

/** TVMaze — free, no API key; best for Western / live-action series. */
async function searchSeriesPoster(title: string): Promise<string> {
  try {
    const response = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`,
    )
    if (!response.ok) return ''
    const json = (await response.json()) as Array<{
      show?: { image?: { medium?: string; original?: string } | null }
    }>
    const image = json[0]?.show?.image
    return image?.original || image?.medium || ''
  } catch {
    return ''
  }
}

/**
 * iTunes Search API — free, no key. Strong movie / TV artwork (upsized from
 * the 100px thumbnail URL Apple returns).
 */
async function searchItunesPoster(
  title: string,
  entity: 'movie' | 'tvSeason' | 'tvShow',
): Promise<string> {
  try {
    const response = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=${entity}&limit=5`,
    )
    if (!response.ok) return ''
    const json = (await response.json()) as {
      results?: Array<{
        trackName?: string
        collectionName?: string
        artworkUrl100?: string
        artworkUrl60?: string
      }>
    }
    const results = Array.isArray(json.results) ? json.results : []
    if (results.length === 0) return ''

    const needle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const ranked = [...results].sort((a, b) => {
      const aName = `${a.trackName || ''} ${a.collectionName || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
      const bName = `${b.trackName || ''} ${b.collectionName || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
      const aHit = aName.includes(needle) || needle.includes(aName.trim()) ? 1 : 0
      const bHit = bName.includes(needle) || needle.includes(bName.trim()) ? 1 : 0
      return bHit - aHit
    })

    const art = ranked[0]?.artworkUrl100 || ranked[0]?.artworkUrl60 || ''
    if (!art) return ''
    // Apple serves larger art at the same path with a bigger size token.
    return art
      .replace(/100x100bb/i, '600x600bb')
      .replace(/100x100/i, '600x600')
      .replace(/60x60bb/i, '600x600bb')
      .replace(/60x60/i, '600x600')
  } catch {
    return ''
  }
}

/**
 * Wikipedia page summary thumbnails — works well for many films/shows
 * without requiring an API key.
 */
async function searchWikipediaPoster(title: string): Promise<string> {
  try {
    const response = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { Accept: 'application/json' } },
    )
    if (!response.ok) return ''
    const json = (await response.json()) as {
      type?: string
      thumbnail?: { source?: string }
      originalimage?: { source?: string }
    }
    if (json.type === 'disambiguation') return ''
    return json.originalimage?.source || json.thumbnail?.source || ''
  } catch {
    return ''
  }
}

async function searchWikipediaFilmPoster(title: string): Promise<string> {
  return (
    (await searchWikipediaPoster(`${title} (film)`)) ||
    (await searchWikipediaPoster(`${title} film`)) ||
    (await searchWikipediaPoster(title))
  )
}

async function searchPoster(title: string, category: PosterCategory): Promise<string> {
  const query = cleanPosterSearchTitle(title, category)
  if (!query) return ''

  if (category === 'anime') {
    return (
      (await searchAnimePoster(query)) ||
      (await searchItunesPoster(query, 'tvShow')) ||
      (await searchWikipediaPoster(query))
    )
  }
  if (category === 'series') {
    return (
      (await searchSeriesPoster(query)) ||
      (await searchItunesPoster(query, 'tvSeason')) ||
      (await searchItunesPoster(query, 'tvShow')) ||
      (await searchWikipediaPoster(query))
    )
  }
  // movies — iTunes is much more reliable than bare Wikipedia for VOD titles
  return (
    (await searchItunesPoster(query, 'movie')) ||
    (await searchWikipediaFilmPoster(query)) ||
    (await searchSeriesPoster(query))
  )
}

/**
 * Resolve missing catalog artwork for movies, TV series, and anime.
 * Lookups are serialized to avoid hammering public APIs, and hits are cached.
 * Empty misses are not cached so later visits can retry.
 */
export function resolveCatalogPoster(title: string, category: CategoryId): Promise<string> {
  if (category !== 'movies' && category !== 'series' && category !== 'anime') {
    return Promise.resolve('')
  }
  if (!title.trim()) return Promise.resolve('')
  const key = keyFor(category, title)
  if (Object.prototype.hasOwnProperty.call(cache, key) && cache[key]) {
    return Promise.resolve(cache[key])
  }

  const existing = pending.get(key)
  if (existing) return existing

  const request = new Promise<string>((resolve) => {
    queue = queue.then(async () => {
      const poster = await searchPoster(title, category)
      if (poster) {
        cache[key] = poster
        saveCache()
      } else {
        // Drop prior empty cache entries from older versions
        if (Object.prototype.hasOwnProperty.call(cache, key)) {
          delete cache[key]
          saveCache()
        }
      }
      pending.delete(key)
      resolve(poster)
      await new Promise((done) => setTimeout(done, 450))
    })
  })
  pending.set(key, request)
  return request
}

/** @deprecated Prefer resolveCatalogPoster */
export function resolveAnimePoster(title: string): Promise<string> {
  return resolveCatalogPoster(title, 'anime')
}
