import type { CategoryId } from '../types'

const CACHE_KEY = 'jiyu.poster-fallback.v2'
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
    .replace(/\b(?:720p|1080p|2160p|480p|4k|uhd|hevc|h\.?265|h\.?264|x264|x265|web-?dl|bluray|eztv)\b/gi, ' ')

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
 * Wikipedia page summary thumbnails — works well for movies and many shows
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

async function searchPoster(title: string, category: PosterCategory): Promise<string> {
  const query = cleanPosterSearchTitle(title, category)
  if (!query) return ''

  if (category === 'anime') {
    return (await searchAnimePoster(query)) || (await searchWikipediaPoster(query))
  }
  if (category === 'series') {
    return (await searchSeriesPoster(query)) || (await searchWikipediaPoster(query))
  }
  // movies
  return (await searchWikipediaPoster(query)) || (await searchSeriesPoster(query))
}

/**
 * Resolve missing catalog artwork for movies, TV series, and anime.
 * Lookups are serialized to avoid hammering public APIs, and results are cached.
 */
export function resolveCatalogPoster(title: string, category: CategoryId): Promise<string> {
  if (category !== 'movies' && category !== 'series' && category !== 'anime') {
    return Promise.resolve('')
  }
  if (!title.trim()) return Promise.resolve('')
  const key = keyFor(category, title)
  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    return Promise.resolve(cache[key])
  }

  const existing = pending.get(key)
  if (existing) return existing

  const request = new Promise<string>((resolve) => {
    queue = queue.then(async () => {
      const poster = await searchPoster(title, category)
      cache[key] = poster
      saveCache()
      pending.delete(key)
      resolve(poster)
      await new Promise((done) => setTimeout(done, 750))
    })
  })
  pending.set(key, request)
  return request
}

/** @deprecated Prefer resolveCatalogPoster */
export function resolveAnimePoster(title: string): Promise<string> {
  return resolveCatalogPoster(title, 'anime')
}
