/**
 * Per-section blocklist: hide titles in Movies / Series / Anime / Kids when
 * the title or description contains a keyword saved for that section only.
 *
 * Optional TMDB boost: when a word resolves to a TMDB keyword id, discover
 * syncs can pass without_keywords for that section's feed.
 */

import type { CategoryId } from '../types'

/** Legacy flat list (pre per-section). Migrated once into v2. */
export const HIDE_KEYWORDS_KEY_V1 = 'jiyu.hide-keywords.v1'
export const HIDE_KEYWORDS_KEY = 'jiyu.hide-keywords.v2'
export const HIDE_KEYWORDS_TMDB_CACHE_KEY = 'jiyu.hide-keywords.tmdb.v1'
export const HIDE_KEYWORDS_EVENT = 'jiyu:hide-keywords'

export type HideKeywordSection = 'movies' | 'series' | 'anime' | 'kids'

export const HIDE_KEYWORD_SECTIONS: readonly HideKeywordSection[] = [
  'movies',
  'series',
  'anime',
  'kids',
] as const

const VOD: ReadonlySet<CategoryId> = new Set(HIDE_KEYWORD_SECTIONS)
const MIN_LEN = 2
const MAX_KEYWORDS = 48

type KeywordStore = Record<HideKeywordSection, string[]>

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(HIDE_KEYWORDS_EVENT))
  } catch {
    /* ignore */
  }
}

export function normalizeHideKeyword(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isHideKeywordSection(
  category: CategoryId | string | undefined,
): category is HideKeywordSection {
  return Boolean(category && VOD.has(category as CategoryId))
}

export function isHideKeywordCategory(category: CategoryId | undefined): boolean {
  return isHideKeywordSection(category)
}

function emptyStore(): KeywordStore {
  return { movies: [], series: [], anime: [], kids: [] }
}

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    const key = normalizeHideKeyword(String(row || ''))
    if (key.length < MIN_LEN || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

function readStore(): KeywordStore {
  try {
    const v2 = localStorage.getItem(HIDE_KEYWORDS_KEY)
    if (v2) {
      const parsed = JSON.parse(v2) as Partial<KeywordStore>
      const store = emptyStore()
      for (const section of HIDE_KEYWORD_SECTIONS) {
        store[section] = sanitizeList(parsed?.[section])
      }
      return store
    }

    // One-time migrate: old global list → each section (user can trim per section).
    const v1 = localStorage.getItem(HIDE_KEYWORDS_KEY_V1)
    if (v1) {
      const legacy = sanitizeList(JSON.parse(v1) as unknown)
      const store = emptyStore()
      for (const section of HIDE_KEYWORD_SECTIONS) {
        store[section] = [...legacy]
      }
      writeStore(store)
      try {
        localStorage.removeItem(HIDE_KEYWORDS_KEY_V1)
      } catch {
        /* ignore */
      }
      return store
    }
  } catch {
    /* ignore */
  }
  return emptyStore()
}

function writeStore(store: KeywordStore) {
  try {
    const trimmed: KeywordStore = emptyStore()
    for (const section of HIDE_KEYWORD_SECTIONS) {
      trimmed[section] = store[section].slice(0, MAX_KEYWORDS)
    }
    localStorage.setItem(HIDE_KEYWORDS_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
  emit()
}

export function listHideKeywords(section: HideKeywordSection): string[] {
  return [...readStore()[section]]
}

/** True when any section has at least one hide word. */
export function hasAnyHideKeywords(): boolean {
  const store = readStore()
  return HIDE_KEYWORD_SECTIONS.some((section) => store[section].length > 0)
}

/** Add one keyword (or several comma/newline separated) to a section. */
export function addHideKeywords(section: HideKeywordSection, raw: string): string[] {
  if (!isHideKeywordSection(section)) return []
  const parts = String(raw || '')
    .split(/[,;\n]+/)
    .map(normalizeHideKeyword)
    .filter((k) => k.length >= MIN_LEN)
  if (parts.length === 0) return []
  const store = readStore()
  const next = [...store[section]]
  const added: string[] = []
  for (const key of parts) {
    if (next.includes(key)) continue
    if (next.length >= MAX_KEYWORDS) break
    next.push(key)
    added.push(key)
  }
  if (added.length === 0) return []
  store[section] = next
  writeStore(store)
  return added
}

export function removeHideKeyword(section: HideKeywordSection, keyword: string) {
  if (!isHideKeywordSection(section)) return
  const key = normalizeHideKeyword(keyword)
  const store = readStore()
  store[section] = store[section].filter((row) => row !== key)
  writeStore(store)
  // Keep TMDB cache entries — other sections may still use the same word.
}

export function clearHideKeywords(section?: HideKeywordSection) {
  if (section && isHideKeywordSection(section)) {
    const store = readStore()
    store[section] = []
    writeStore(store)
    return
  }
  writeStore(emptyStore())
  try {
    localStorage.removeItem(HIDE_KEYWORDS_TMDB_CACHE_KEY)
  } catch {
    /* ignore */
  }
}

export function itemMatchesHideKeywords(item: {
  title?: string
  description?: string
  category?: CategoryId
}): boolean {
  if (!isHideKeywordSection(item.category)) return false
  const keywords = listHideKeywords(item.category)
  if (keywords.length === 0) return false
  const hay = `${item.title || ''} ${item.description || ''}`.toLowerCase()
  if (!hay.trim()) return false
  return keywords.some((key) => hay.includes(key))
}

export function subscribeHideKeywords(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(HIDE_KEYWORDS_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(HIDE_KEYWORDS_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

type TmdbCache = Record<string, number | null>

function readTmdbCache(): TmdbCache {
  try {
    const raw = localStorage.getItem(HIDE_KEYWORDS_TMDB_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TmdbCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeTmdbCache(cache: TmdbCache) {
  try {
    localStorage.setItem(HIDE_KEYWORDS_TMDB_CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
}

/** Map a TMDB TV discover feed kind to the matching hide-keyword section. */
export function hideSectionForTmdbTvKind(kind: string): HideKeywordSection {
  if (kind === 'anime' || kind === 'animation') return 'anime'
  if (kind === 'kids') return 'kids'
  return 'series'
}

/** Pipe-joined TMDB keyword ids for discover `without_keywords` (OR). */
export function tmdbWithoutKeywordsParam(section: HideKeywordSection): string {
  const cache = readTmdbCache()
  const ids = listHideKeywords(section)
    .map((key) => cache[key])
    .filter((id): id is number => typeof id === 'number' && id > 0)
  return [...new Set(ids)].join('|')
}

async function searchTmdbKeywordId(keyword: string): Promise<number | null> {
  try {
    const { tmdbApiKey } = await import('./tmdbClient')
    const key = tmdbApiKey()
    if (!key) return null
    const url = new URL('https://api.themoviedb.org/3/search/keyword')
    url.searchParams.set('api_key', key)
    url.searchParams.set('query', keyword)
    url.searchParams.set('page', '1')
    type KeywordSearch = { results?: Array<{ id?: number; name?: string }> }
    let data: KeywordSearch | null = null
    if (window.signalDesktop?.fetchJsonGet) {
      const res = await window.signalDesktop.fetchJsonGet(
        url.toString(),
        'https://www.themoviedb.org/',
      )
      if (!res.ok) return null
      try {
        data = JSON.parse(res.content || 'null') as KeywordSearch
      } catch {
        return null
      }
    } else {
      const { nativeFetchJson } = await import('./nativeHttp')
      const res = await nativeFetchJson<KeywordSearch>(url.toString())
      if (!res.ok) return null
      data = res.data || null
    }
    const results: Array<{ id?: number; name?: string }> = Array.isArray(data?.results)
      ? data!.results!
      : []
    const exact = results.find(
      (row: { id?: number; name?: string }) =>
        normalizeHideKeyword(String(row.name || '')) === keyword && row.id,
    )
    if (exact?.id) return Number(exact.id)
    const first = results.find((row: { id?: number }) => row.id)
    return first?.id ? Number(first.id) : null
  } catch {
    return null
  }
}

/** Resolve TMDB keyword ids for newly added (or all) blocklist words in a section. */
export async function resolveHideKeywordTmdbIds(
  section: HideKeywordSection,
  only?: string[],
): Promise<void> {
  const targets = (
    only && only.length > 0 ? only : listHideKeywords(section)
  ).map(normalizeHideKeyword)
  if (targets.length === 0) return
  const cache = readTmdbCache()
  let changed = false
  for (const key of targets) {
    if (key in cache) continue
    const id = await searchTmdbKeywordId(key)
    cache[key] = id
    changed = true
  }
  if (changed) writeTmdbCache(cache)
}
