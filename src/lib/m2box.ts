/**
 * M2Box (m2box.org) — Nuxt SSR catalog pages for TV series.
 * Tier 3: resolve signed MP4/HLS via the AoneRoom play API for native playback.
 * Tier 2 fallback: Web Browser when play resolution fails.
 */

import type { TorrentPageLink } from './torrents'

export const M2BOX_SERIES_FEED_PREFIX = 'jiyu://m2box-series'
export const M2BOX_API_ORIGIN = 'https://h5-api.aoneroom.com'
export const M2BOX_FILTER_PATH = '/wefeed-h5api-bff/subject/filter'
export const M2BOX_PLAY_PATH = '/wefeed-h5api-bff/subject/play'
export const M2BOX_PER_PAGE = 36
/** Paginated filter API pages per country during catalog sync. */
export const M2BOX_CATALOG_PAGES = 100
export const M2BOX_API_REQUEST_GAP_MS = 350

/** Country chips on m2box.org/web/tv-series — catalog sync is limited to these. */
export const M2BOX_CATALOG_COUNTRIES = [
  'United States',
  'United Kingdom',
  'Korea',
  'Japan',
] as const

export type M2BoxCatalogCountry = (typeof M2BOX_CATALOG_COUNTRIES)[number]

export function isM2BoxCatalogCountry(value: string | undefined | null): value is M2BoxCatalogCountry {
  if (!value) return false
  return (M2BOX_CATALOG_COUNTRIES as readonly string[]).includes(value)
}

/** M2Box list path → filter API channelId (see probe-m2box-channels.cjs). */
const M2BOX_LIST_PATH_CHANNELS: Record<string, number> = {
  '/web/tv-series': 2,
  '/web/series': 2,
  '/web/movies': 1,
  '/web/movie': 1,
  '/web/anime': 4,
  '/web/kids': 5,
}

export interface M2BoxSubject {
  subjectId: string
  title: string
  description?: string
  detailPath: string
  releaseDate?: string
  genre?: string
  countryName?: string
  imdbRatingValue?: string
  cover?: { url?: unknown }
}

export interface M2BoxPager {
  hasMore?: boolean
  nextPage?: string
  page?: string
}

export function isM2BoxUrl(pageUrl: string): boolean {
  if (pageUrl.startsWith(M2BOX_SERIES_FEED_PREFIX)) return true
  try {
    return /(^|\.)m2box\.org$/i.test(new URL(pageUrl).hostname)
  } catch {
    return /m2box\.org/i.test(pageUrl)
  }
}

/** Catalog card from M2Box (detail page or source URL). */
export function isM2BoxCatalogItem(item: {
  url?: string
  detailUrl?: string
}): boolean {
  if (item.url && isM2BoxUrl(item.url)) return true
  if (item.detailUrl && isM2BoxUrl(item.detailUrl)) return true
  return false
}

export function isM2BoxSeriesFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(M2BOX_SERIES_FEED_PREFIX)
}

export function normalizeM2BoxOrigin(originOrUrl: string): string {
  try {
    const u = new URL(originOrUrl)
    u.protocol = 'https:'
    u.hostname = 'm2box.org'
    return u.origin
  } catch {
    return 'https://m2box.org'
  }
}

/** Default TV Series listing when the user adds the site root. */
export function m2boxDefaultListPath(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl)
    if (u.pathname && u.pathname !== '/') return u.pathname.replace(/\/$/, '') || '/web/tv-series'
  } catch {
    /* fall through */
  }
  return '/web/tv-series'
}

export function m2boxSeriesFeedUrl(origin: string, listPath?: string): string {
  const o = normalizeM2BoxOrigin(origin)
  const path = listPath || '/web/tv-series'
  return `${M2BOX_SERIES_FEED_PREFIX}?origin=${encodeURIComponent(o)}&path=${encodeURIComponent(path)}`
}

export function m2boxFeedOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('origin') || 'https://m2box.org'
  } catch {
    return 'https://m2box.org'
  }
}

export function m2boxFeedListPath(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('path') || '/web/tv-series'
  } catch {
    return '/web/tv-series'
  }
}

export function m2boxChannelIdForListPath(listPath: string): number {
  const path = listPath.replace(/\/$/, '').toLowerCase() || '/web/tv-series'
  return M2BOX_LIST_PATH_CHANNELS[path] ?? 2
}

export function m2boxListReferer(origin: string, listPath: string): string {
  return m2boxListPageUrl(origin, listPath, 1)
}

export function m2boxListPageUrl(origin: string, listPath: string, page = 1): string {
  const base = `${normalizeM2BoxOrigin(origin)}${listPath.startsWith('/') ? listPath : `/${listPath}`}`
  if (page <= 1) return base
  try {
    const u = new URL(base)
    u.searchParams.set('page', String(page))
    return u.toString()
  } catch {
    return `${base}?page=${page}`
  }
}

export function m2boxDetailUrl(origin: string, detailPath: string): string {
  const slug = detailPath.replace(/^\/detail\//, '').replace(/^\//, '')
  return `${normalizeM2BoxOrigin(origin)}/detail/${slug}`
}

/** Slug from `/detail/{slug}` or full detail URL. */
export function parseM2BoxDetailSlug(detailUrl: string): string | null {
  try {
    const u = new URL(detailUrl)
    const m = u.pathname.match(/\/detail\/([^/?#]+)/i)
    return m?.[1] ?? null
  } catch {
    const m = detailUrl.match(/\/detail\/([^/?#]+)/i)
    return m?.[1] ?? null
  }
}

/** Referer the play API expects — mirrors M2Box’s `/movies/…` player route. */
export function m2boxPlayReferer(
  slug: string,
  subjectId: string,
  season = 1,
  episode = 1,
): string {
  const params = new URLSearchParams({
    id: subjectId,
    type: '/movie/detail',
    detailSe: String(season),
    detailEp: String(episode),
    lang: 'en',
  })
  return `https://m2box.org/movies/${slug}?${params.toString()}`
}

export function m2boxPlayApiUrl(subjectId: string, season: number, episode: number): string {
  const qs = new URLSearchParams({
    subject_id: subjectId,
    se: String(season),
    ep: String(episode),
  })
  return `${M2BOX_API_ORIGIN}${M2BOX_PLAY_PATH}?${qs.toString()}`
}

export interface M2BoxPlayStream {
  format?: string
  url?: string
  resolutions?: string
  duration?: number
  vipLocked?: boolean
}

export interface M2BoxPlayData {
  streams?: M2BoxPlayStream[]
  hls?: M2BoxPlayStream[]
  hasResource?: boolean
  vipLocked?: boolean
}

export type M2BoxPlayResolveResult =
  | {
      ok: true
      url: string
      format: 'mp4' | 'hls'
      subjectId: string
      slug: string
      season: number
      episode: number
      referer: string
      durationSeconds?: number
      resolution?: string
    }
  | { ok: false; error: string }

function resolutionRank(value: string | undefined): number {
  if (!value) return 0
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : 0
}

/** Prefer highest-resolution MP4, then HLS. */
export function pickM2BoxPlayStream(data: M2BoxPlayData | null | undefined): {
  url: string
  format: 'mp4' | 'hls'
  durationSeconds?: number
  resolution?: string
} | null {
  if (!data) return null
  const mp4 = [...(data.streams ?? [])]
    .filter((s) => s.url && !s.vipLocked)
    .sort((a, b) => resolutionRank(b.resolutions) - resolutionRank(a.resolutions))
  if (mp4[0]?.url) {
    return {
      url: mp4[0].url,
      format: 'mp4',
      durationSeconds: mp4[0].duration,
      resolution: mp4[0].resolutions,
    }
  }
  const hls = [...(data.hls ?? [])]
    .filter((s) => s.url && !s.vipLocked)
    .sort((a, b) => resolutionRank(b.resolutions) - resolutionRank(a.resolutions))
  if (hls[0]?.url) {
    return {
      url: hls[0].url,
      format: 'hls',
      durationSeconds: hls[0].duration,
      resolution: hls[0].resolutions,
    }
  }
  return null
}

async function getM2BoxPlayJson(
  apiUrl: string,
  referer: string,
): Promise<{ ok: boolean; data: M2BoxPlayData | null; error: string }> {
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(apiUrl, referer)
    if (!result.ok) {
      return { ok: false, data: null, error: result.error || `HTTP ${result.status}` }
    }
    try {
      const parsed = JSON.parse(result.content) as { code?: number; message?: string; data?: M2BoxPlayData }
      if (parsed.code !== 0 && parsed.code !== undefined) {
        return { ok: false, data: null, error: parsed.message || 'M2Box play API error' }
      }
      return { ok: true, data: parsed.data ?? null, error: '' }
    } catch {
      return { ok: false, data: null, error: 'Invalid M2Box play JSON' }
    }
  }

  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: referer,
      },
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, data: null, error: `M2Box play HTTP ${res.status}` }
    }
    const parsed = JSON.parse(text) as { code?: number; message?: string; data?: M2BoxPlayData }
    if (parsed.code !== 0 && parsed.code !== undefined) {
      return { ok: false, data: null, error: parsed.message || 'M2Box play API error' }
    }
    return { ok: true, data: parsed.data ?? null, error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'M2Box play request failed',
    }
  }
}

/** Parse numeric subject id from detail SSR HTML (Nuxt pointer-aware). */
export function parseM2BoxSubjectIdFromHtml(html: string): string | null {
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (match) {
    try {
      const data = JSON.parse(match[1]) as unknown[]
      for (const entry of data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const obj = entry as Record<string, unknown>
        if (!('subjectId' in obj)) continue
        const titleOk =
          typeof obj.title === 'string' ||
          typeof obj.title === 'number' ||
          typeof obj.detailPath === 'string' ||
          typeof obj.detailPath === 'number'
        if (!titleOk) continue

        const sidRef = obj.subjectId
        let sid: unknown = sidRef
        if (typeof sidRef === 'number' && sidRef >= 0 && sidRef < data.length) {
          sid = data[sidRef]
          // Unwrap Reactive/Ref once
          if (
            Array.isArray(sid) &&
            sid.length === 2 &&
            typeof sid[0] === 'string' &&
            /^(?:Shallow)?Reactive|Ref$/i.test(sid[0])
          ) {
            const inner = sid[1]
            sid =
              typeof inner === 'number' && inner >= 0 && inner < data.length ? data[inner] : inner
          }
        }
        if (typeof sid === 'string' && /^\d{10,}$/.test(sid)) return sid
        if (typeof sid === 'number' && Number.isFinite(sid) && sid >= 1e10) {
          return String(Math.trunc(sid))
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Fallback: quoted id in HTML (rare — Nuxt usually uses pointers)
  const quoted = html.match(/"subjectId"\s*:\s*"(\d{10,})"/)
  if (quoted?.[1]) return quoted[1]
  return null
}

export async function fetchM2BoxSubjectId(detailUrl: string): Promise<string | null> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(detailUrl)
    if (result.ok && result.content) {
      return parseM2BoxSubjectIdFromHtml(result.content)
    }
    return null
  }
  try {
    const res = await fetch(detailUrl)
    if (!res.ok) return null
    return parseM2BoxSubjectIdFromHtml(await res.text())
  } catch {
    return null
  }
}

/**
 * Resolve a M2Box detail page to a signed progressive MP4 or HLS URL.
 * Requires `se`/`ep` and the `/movies/…` referer (see probe-m2box-referer.cjs).
 */
export async function resolveM2BoxPlay(
  detailUrl: string,
  options?: { subjectId?: string; season?: number; episode?: number },
): Promise<M2BoxPlayResolveResult> {
  const slug = parseM2BoxDetailSlug(detailUrl)
  if (!slug) {
    return { ok: false, error: 'Not a M2Box detail URL' }
  }

  let subjectId = options?.subjectId?.trim() || ''
  // Nuxt pointers look like "12" — never a real AoneRoom subject id.
  if (subjectId && !/^\d{10,}$/.test(subjectId)) {
    subjectId = ''
  }
  if (!subjectId) {
    subjectId = (await fetchM2BoxSubjectId(detailUrl)) || ''
  }
  if (!subjectId) {
    return { ok: false, error: 'Could not read M2Box subject id' }
  }

  const season = Math.max(1, options?.season ?? 1)
  const episode = Math.max(1, options?.episode ?? 1)
  const referer = m2boxPlayReferer(slug, subjectId, season, episode)
  const apiUrl = m2boxPlayApiUrl(subjectId, season, episode)
  const result = await getM2BoxPlayJson(apiUrl, referer)
  if (!result.ok) {
    return { ok: false, error: result.error || 'M2Box play API unavailable' }
  }

  let picked = pickM2BoxPlayStream(result.data)
  // Catalog may have a stale/missing id — retry once with SSR subject id.
  if (!picked && options?.subjectId) {
    const freshId = await fetchM2BoxSubjectId(detailUrl)
    if (freshId && freshId !== subjectId) {
      subjectId = freshId
      const retryReferer = m2boxPlayReferer(slug, subjectId, season, episode)
      const retry = await getM2BoxPlayJson(m2boxPlayApiUrl(subjectId, season, episode), retryReferer)
      if (retry.ok) picked = pickM2BoxPlayStream(retry.data)
    }
  }
  if (!picked) {
    const locked = result.data?.vipLocked
    return {
      ok: false,
      error: locked ? 'This title is VIP-locked on M2Box' : 'No playable streams for this episode',
    }
  }

  return {
    ok: true,
    url: picked.url,
    format: picked.format,
    subjectId,
    slug,
    season,
    episode,
    referer,
    durationSeconds: picked.durationSeconds,
    resolution: picked.resolution,
  }
}

/** Decode Nuxt 3 `__NUXT_DATA__` payload (pointer refs + reactive wrappers). */
export function reviveNuxtPayload(raw: string): unknown[] {
  const data = JSON.parse(raw) as unknown[]
  const memo = new Map<object, unknown>()

  function resolve(v: unknown, stack = new Set<number>()): unknown {
    if (v === null || v === undefined) return v
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < data.length) {
      if (stack.has(v)) return null
      stack.add(v)
      const out = resolve(data[v], stack)
      stack.delete(v)
      return out
    }
    const t = typeof v
    if (t !== 'object') return v

    if (memo.has(v as object)) return memo.get(v as object)

    if (Array.isArray(v)) {
      if (
        v.length === 2 &&
        typeof v[0] === 'string' &&
        /^(?:Shallow)?Reactive|Ref|Empty|Set|Map|Object|Array$/i.test(v[0])
      ) {
        return resolve(v[1], stack)
      }
      const arr = v.map((item) => resolve(item, stack))
      memo.set(v, arr)
      return arr
    }

    const out: Record<string, unknown> = {}
    memo.set(v as object, out)
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = resolve(val, stack)
    }
    return out
  }

  return data.map((_, i) => resolve(i))
}

export function extractM2BoxSubjects(revived: unknown[]): {
  subjects: M2BoxSubject[]
  pager: M2BoxPager | null
} {
  const subjects: M2BoxSubject[] = []
  const seen = new Set<string>()
  let pager: M2BoxPager | null = null

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const obj = node as Record<string, unknown>
    if (obj.pager && typeof obj.pager === 'object' && obj.items) {
      pager = obj.pager as M2BoxPager
    }
    if (
      (typeof obj.subjectId === 'number' || typeof obj.subjectId === 'string') &&
      typeof obj.title === 'string' &&
      typeof obj.detailPath === 'string'
    ) {
      const id = String(obj.subjectId)
      if (!seen.has(id)) {
        seen.add(id)
        subjects.push({
          subjectId: id,
          title: obj.title,
          description: typeof obj.description === 'string' ? obj.description : undefined,
          detailPath: obj.detailPath,
          releaseDate: typeof obj.releaseDate === 'string' ? obj.releaseDate : undefined,
          genre: typeof obj.genre === 'string' ? obj.genre : undefined,
          countryName: typeof obj.countryName === 'string' ? obj.countryName : undefined,
          imdbRatingValue:
            typeof obj.imdbRatingValue === 'string' ? obj.imdbRatingValue : undefined,
          cover: obj.cover && typeof obj.cover === 'object' ? (obj.cover as M2BoxSubject['cover']) : undefined,
        })
      }
    }
    for (const val of Object.values(obj)) walk(val)
  }

  for (const entry of revived) walk(entry)
  return { subjects, pager }
}

function m2boxPoster(cover: M2BoxSubject['cover']): string | undefined {
  if (!cover || typeof cover !== 'object') return undefined
  const url = cover.url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

function inferM2BoxCategory(subject: M2BoxSubject): 'series' | 'anime' {
  if (subject.genre && /\banime\b/i.test(subject.genre)) return 'anime'
  return 'series'
}

function parseM2BoxReleaseDate(releaseDate?: string): number | undefined {
  if (!releaseDate) return undefined
  const ms = Date.parse(releaseDate)
  return Number.isFinite(ms) ? ms : undefined
}

export function m2boxSubjectsToLinks(
  subjects: M2BoxSubject[],
  origin: string,
): TorrentPageLink[] {
  const o = normalizeM2BoxOrigin(origin)
  return subjects
    .filter((subject) => !subject.countryName || isM2BoxCatalogCountry(subject.countryName))
    .map((subject) => {
      const category = inferM2BoxCategory(subject)
      const rating =
        subject.imdbRatingValue && !/^#/.test(subject.imdbRatingValue)
          ? ` · IMDb ${subject.imdbRatingValue}`
          : ''
      const year = subject.releaseDate?.slice(0, 4)
      const genre = subject.genre?.split(',')[0]?.trim()
      const meta = [genre || (category === 'anime' ? 'Anime' : 'TV Series'), year]
        .filter(Boolean)
        .join(' · ')
        .concat(rating)
      const synopsis = subject.description?.trim()
      return {
        title: subject.title.slice(0, 180),
        url: m2boxDetailUrl(o, subject.detailPath),
        // Prefer M2Box plot synopsis; fall back to genre · year · rating.
        summary: synopsis || meta || (category === 'anime' ? 'Anime' : 'TV Series'),
        poster: m2boxPoster(subject.cover),
        category,
        releasedAt: parseM2BoxReleaseDate(subject.releaseDate),
        m2boxSubjectId: subject.subjectId,
      }
    })
}

export function parseM2BoxListHtml(
  html: string,
  origin: string,
): { links: TorrentPageLink[]; pager: M2BoxPager | null; pageTitle: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageTitle = doc.querySelector('title')?.textContent?.trim() || 'M2Box'
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!match) {
    return { links: [], pager: null, pageTitle }
  }
  const revived = reviveNuxtPayload(match[1])
  const { subjects, pager } = extractM2BoxSubjects(revived)
  return {
    links: m2boxSubjectsToLinks(subjects, origin),
    pager,
    pageTitle,
  }
}

function mapM2BoxApiSubject(raw: unknown): M2BoxSubject | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    (typeof obj.subjectId !== 'number' && typeof obj.subjectId !== 'string') ||
    typeof obj.title !== 'string' ||
    typeof obj.detailPath !== 'string'
  ) {
    return null
  }
  return {
    subjectId: String(obj.subjectId),
    title: obj.title,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    detailPath: obj.detailPath,
    releaseDate: typeof obj.releaseDate === 'string' ? obj.releaseDate : undefined,
    genre: typeof obj.genre === 'string' ? obj.genre : undefined,
    countryName: typeof obj.countryName === 'string' ? obj.countryName : undefined,
    imdbRatingValue:
      typeof obj.imdbRatingValue === 'string' ? obj.imdbRatingValue : undefined,
    cover: obj.cover && typeof obj.cover === 'object' ? (obj.cover as M2BoxSubject['cover']) : undefined,
  }
}

interface M2BoxFilterResponse {
  code?: number
  message?: string
  data?: {
    pager?: M2BoxPager
    items?: unknown[]
  }
}

async function postM2BoxFilter(
  channelId: number,
  page: number,
  referer: string,
  country?: string,
): Promise<{ ok: boolean; data: M2BoxFilterResponse | null; error: string }> {
  const url = `${M2BOX_API_ORIGIN}${M2BOX_FILTER_PATH}`
  const body: Record<string, unknown> = { page, perPage: M2BOX_PER_PAGE, channelId }
  if (country) body.country = country

  if (window.signalDesktop?.fetchJsonPost) {
    const result = await window.signalDesktop.fetchJsonPost(url, body, referer)
    if (!result.ok) {
      return { ok: false, data: null, error: result.error || `HTTP ${result.status}` }
    }
    try {
      return { ok: true, data: JSON.parse(result.content) as M2BoxFilterResponse, error: '' }
    } catch {
      return { ok: false, data: null, error: 'Invalid M2Box API JSON' }
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://m2box.org',
        Referer: referer,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, data: null, error: `M2Box API HTTP ${res.status}` }
    }
    return { ok: true, data: JSON.parse(text) as M2BoxFilterResponse, error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'M2Box API request failed',
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** Crawl one country filter until exhausted or maxPages. */
async function fetchM2BoxSubjectsForCountry(
  channelId: number,
  referer: string,
  country: string,
  maxPages: number,
  seen: Set<string>,
  subjects: M2BoxSubject[],
): Promise<string | null> {
  let lastError: string | null = null

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await postM2BoxFilter(channelId, page, referer, country)
    if (!result.ok || !result.data) {
      lastError = result.error || 'M2Box API unavailable'
      if (page === 1) break
      continue
    }
    if (result.data.code !== 0 && result.data.code !== undefined) {
      lastError = result.data.message || 'M2Box API error'
      if (page === 1) break
      continue
    }

    const items = result.data.data?.items ?? []
    let added = 0
    for (const raw of items) {
      const subject = mapM2BoxApiSubject(raw)
      if (!subject || seen.has(subject.subjectId)) continue
      // Trust API country filter, but drop anything outside the allowlist.
      if (subject.countryName && !isM2BoxCatalogCountry(subject.countryName)) continue
      if (!subject.countryName) subject.countryName = country
      seen.add(subject.subjectId)
      subjects.push(subject)
      added += 1
    }

    const pager = result.data.data?.pager
    if (added === 0 && page > 1) break
    if (!pager?.hasMore) break
    if (page < maxPages) await sleep(M2BOX_API_REQUEST_GAP_MS)
  }

  return lastError
}

/** Crawl the M2Box filter API for US / UK / Korea / Japan only. */
export async function fetchM2BoxCatalogSubjects(
  origin: string,
  listPath: string,
  maxPages = M2BOX_CATALOG_PAGES,
): Promise<{ subjects: M2BoxSubject[]; error: string | null }> {
  const channelId = m2boxChannelIdForListPath(listPath)
  const referer = m2boxListReferer(origin, listPath)
  const subjects: M2BoxSubject[] = []
  const seen = new Set<string>()
  let lastError: string | null = null

  for (let i = 0; i < M2BOX_CATALOG_COUNTRIES.length; i += 1) {
    const country = M2BOX_CATALOG_COUNTRIES[i]
    const err = await fetchM2BoxSubjectsForCountry(
      channelId,
      referer,
      country,
      maxPages,
      seen,
      subjects,
    )
    if (err) lastError = err
    if (i < M2BOX_CATALOG_COUNTRIES.length - 1) await sleep(M2BOX_API_REQUEST_GAP_MS)
  }

  return {
    subjects,
    error: subjects.length === 0 ? lastError : null,
  }
}

export async function fetchM2BoxCatalogLinks(
  origin: string,
  listPath: string,
  maxPages = M2BOX_CATALOG_PAGES,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  const { subjects, error } = await fetchM2BoxCatalogSubjects(origin, listPath, maxPages)
  return {
    links: m2boxSubjectsToLinks(subjects, origin),
    error,
  }
}

export interface M2BoxSeasonInfo {
  season: number
  maxEpisode: number
}

export interface M2BoxEpisodeInfo {
  key: string
  season: number
  episode: number
  title: string
}

/**
 * Nuxt payload integers are pointers — but `se` / `maxEp` resolve to small
 * integers that must NOT be followed again (index 1 is unrelated payload).
 */
function resolveNuxtOnce(data: unknown[], ref: unknown): unknown {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < data.length) {
    let v = data[ref]
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      /^(?:Shallow)?Reactive|Ref$/i.test(v[0])
    ) {
      return resolveNuxtOnce(data, v[1])
    }
    return v
  }
  return ref
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value)
    return n >= 1 ? n : null
  }
  return null
}

/** Read season → episode counts and synopsis from detail-page `__NUXT_DATA__`. */
export function parseM2BoxSeasonsFromHtml(html: string): {
  subjectId: string | null
  seasons: M2BoxSeasonInfo[]
  description: string | null
  genre: string | null
} {
  const subjectId = parseM2BoxSubjectIdFromHtml(html)
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!match) return { subjectId, seasons: [], description: null, genre: null }

  let data: unknown[]
  try {
    data = JSON.parse(match[1]) as unknown[]
  } catch {
    return { subjectId, seasons: [], description: null, genre: null }
  }

  let description: string | null = null
  let genre: string | null = null
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    if (!('subjectId' in obj)) continue
    const desc = resolveNuxtOnce(data, obj.description)
    if (typeof desc === 'string' && desc.trim().length > 20) {
      description = desc.trim()
    }
    const g = resolveNuxtOnce(data, obj.genre)
    if (typeof g === 'string' && g.trim()) {
      genre = g.trim()
    }
    if (description) break
  }

  let resource: Record<string, unknown> | null = null
  for (const entry of data) {
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      'seasons' in entry &&
      'source' in entry
    ) {
      resource = entry as Record<string, unknown>
      break
    }
  }
  if (!resource) return { subjectId, seasons: [], description, genre }

  const seasonsRef = resource.seasons
  const seasonsArr =
    typeof seasonsRef === 'number' && seasonsRef >= 0 && seasonsRef < data.length
      ? data[seasonsRef]
      : seasonsRef
  if (!Array.isArray(seasonsArr)) return { subjectId, seasons: [], description, genre }

  const seasons: M2BoxSeasonInfo[] = []
  const seen = new Set<number>()
  for (const seasonRef of seasonsArr) {
    const seasonRaw =
      typeof seasonRef === 'number' && seasonRef >= 0 && seasonRef < data.length
        ? data[seasonRef]
        : seasonRef
    if (!seasonRaw || typeof seasonRaw !== 'object' || Array.isArray(seasonRaw)) continue
    const seasonObj = seasonRaw as Record<string, unknown>
    const se = asPositiveInt(resolveNuxtOnce(data, seasonObj.se))
    const maxEp = asPositiveInt(resolveNuxtOnce(data, seasonObj.maxEp))
    if (se == null || maxEp == null) continue
    if (maxEp > 500) continue
    if (seen.has(se)) continue
    seen.add(se)
    seasons.push({ season: se, maxEpisode: maxEp })
  }

  seasons.sort((a, b) => a.season - b.season)
  return { subjectId, seasons, description, genre }
}

export function m2boxEpisodesFromSeasons(seasons: M2BoxSeasonInfo[]): M2BoxEpisodeInfo[] {
  const episodes: M2BoxEpisodeInfo[] = []
  for (const { season, maxEpisode } of seasons) {
    for (let episode = 1; episode <= maxEpisode; episode += 1) {
      const key = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      episodes.push({
        key,
        season,
        episode,
        title: `Episode ${episode}`,
      })
    }
  }
  return episodes
}

/** Fetch detail SSR and expand seasons into an episode list for the show picker. */
export async function fetchM2BoxEpisodeList(
  detailUrl: string,
  knownSubjectId?: string,
): Promise<{
  subjectId: string
  episodes: M2BoxEpisodeInfo[]
  description?: string
  genre?: string
  error?: string
}> {
  let html = ''
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(detailUrl)
    if (!result.ok || !result.content) {
      return {
        subjectId: knownSubjectId || '',
        episodes: [],
        error: result.error || 'Could not load M2Box detail page',
      }
    }
    html = result.content
  } else {
    try {
      const res = await fetch(detailUrl)
      if (!res.ok) {
        return {
          subjectId: knownSubjectId || '',
          episodes: [],
          error: `M2Box detail HTTP ${res.status}`,
        }
      }
      html = await res.text()
    } catch (err) {
      return {
        subjectId: knownSubjectId || '',
        episodes: [],
        error: err instanceof Error ? err.message : 'M2Box detail request failed',
      }
    }
  }

  const parsed = parseM2BoxSeasonsFromHtml(html)
  const subjectId = knownSubjectId || parsed.subjectId || ''
  const description = parsed.description || undefined
  const genre = parsed.genre || undefined
  if (parsed.seasons.length === 0) {
    // Single-shot titles still play as S01E01 when the season table is missing.
    return {
      subjectId,
      episodes: [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }],
      description,
      genre,
      error: subjectId ? undefined : 'Could not read M2Box seasons',
    }
  }

  return {
    subjectId,
    episodes: m2boxEpisodesFromSeasons(parsed.seasons),
    description,
    genre,
  }
}
