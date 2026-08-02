/**
 * Torrent websites (user-supplied pages that contain magnet or .torrent links)
 * and link scraping. Page fetches go through the desktop bridge to avoid CORS; the list
 * of added websites persists in localStorage.
 */

import { clampQualityToDevice } from './deviceProfile'
import { stableTorrentItemId } from './torrentCatalogStore'
import { getViewingQuality } from './viewingQuality'
import type { StreamItem } from '../types'

export interface TorrentSource {
  id: string
  label: string
  /** Web page URL that contains magnet or .torrent links */
  url: string
}

export interface TorrentResult {
  title: string
  uri: string
  kind: 'magnet' | 'torrent'
  sizeBytes: number
  seeders: number
  sourceLabel: string
}

export interface TorrentPageLink {
  title: string
  url: string
  summary: string
  poster?: string
  category?: 'movies' | 'series' | 'anime'
  /** Unix ms when the listing was added / released, if known */
  releasedAt?: number
  /** Magnet/.torrent URI when the listing already carries one (API sources) */
  torrentUri?: string
  /** Authoritative runtime in seconds when the listing API provides it (e.g. YTS). */
  runtimeSeconds?: number
}

const SOURCES_KEY = 'jiyu.torrent.sources'
const SUBSPLEASE_SOURCE: TorrentSource = {
  id: 'builtin-subsplease',
  label: 'subsplease.org',
  url: 'https://subsplease.org/shows/',
}

function labelSubsPleaseSource(source: TorrentSource): TorrentSource {
  try {
    if (!isSubsPleaseUrl(source.url)) return source
    if (isSubsPleaseShowsListUrl(source.url)) {
      return { ...source, label: 'subsplease.org · Full Shows' }
    }
    if (isSubsPleaseLatestFeedUrl(source.url)) {
      return { ...source, label: 'subsplease.org · New Releases' }
    }
  } catch {
    /* keep label */
  }
  return source
}

function normalizeTorrentSourceList(parsed: unknown): TorrentSource[] {
  const sources: TorrentSource[] = Array.isArray(parsed)
    ? parsed.filter(
        (s): s is TorrentSource =>
          Boolean(s && typeof s === 'object' && typeof (s as TorrentSource).url === 'string'),
      )
    : []
  if (!sources.some((source) => isSubsPleaseUrl(source.url))) {
    sources.push(SUBSPLEASE_SOURCE)
  }
  return sources.map(labelSubsPleaseSource)
}

function readTorrentSourcesLocal(): TorrentSource[] {
  try {
    const raw = localStorage.getItem(SOURCES_KEY)
    return normalizeTorrentSourceList(raw ? JSON.parse(raw) : [])
  } catch {
    return [SUBSPLEASE_SOURCE]
  }
}

export function loadTorrentSources(): TorrentSource[] {
  const sources = readTorrentSourcesLocal()
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources))
  } catch {
    /* ignore */
  }
  return sources
}

/** Merge Electron-disk website list when Chromium localStorage was lost. */
export async function loadTorrentSourcesAsync(): Promise<TorrentSource[]> {
  const current = readTorrentSourcesLocal()
  const api = window.signalDesktop
  if (!api?.torrentSourcesList || !api.torrentSourcesSave) return current
  try {
    const disk = normalizeTorrentSourceList(await api.torrentSourcesList())
    const currentUrls = new Set(current.map((s) => s.url.trim().toLowerCase()))
    const extras = disk.filter((s) => !currentUrls.has(s.url.trim().toLowerCase()))
    const merged =
      current.length <= 1 && disk.length > current.length ? disk : [...current, ...extras]
    const next = normalizeTorrentSourceList(merged)
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
    await api.torrentSourcesSave(next)
    return next
  } catch {
    return current
  }
}

export function saveTorrentSources(sources: TorrentSource[]) {
  const next = normalizeTorrentSourceList(sources)
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(next))
  } catch {
    /* Chromium storage can be unavailable after profile corruption */
  }
  void window.signalDesktop?.torrentSourcesSave?.(next)
}

export function isMagnetLink(text: string): boolean {
  return /^magnet:\?/i.test(text.trim())
}

export function isTorrentFileLink(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return /^https?:$/i.test(url.protocol) && /\.torrent$/i.test(url.pathname)
  } catch {
    return false
  }
}

export function isTorrentInput(text: string): boolean {
  return isMagnetLink(text) || isTorrentFileLink(text)
}

export function normalizeWebsiteUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function magnetInfoHash(magnet: string): string | null {
  const m = /urn:btih:([a-z0-9]{32,40})/i.exec(magnet)
  return m ? m[1].toLowerCase() : null
}

function magnetDisplayName(magnet: string): string {
  const m = /[?&]dn=([^&]+)/i.exec(magnet)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim()
  } catch {
    return m[1].replace(/\+/g, ' ').trim()
  }
}

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|KB|KiB)/i

function parseSizeText(text: string): number {
  const m = SIZE_RE.exec(text)
  if (!m) return 0
  const value = Number(m[1])
  const unit = m[2].toLowerCase()
  const mult = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : 1024
  return Math.round(value * mult)
}

function parseSeedersText(text: string): number {
  const m = /(\d[\d,]*)\s*seed(?:er)?s?\b/i.exec(text)
  return m ? Number(m[1].replace(/,/g, '')) : 0
}

/**
 * Extract magnet and .torrent links from a page's HTML. Relative torrent URLs
 * are resolved against the source page. Anchor text / dn= supplies the title.
 */
export function scrapeTorrentLinks(
  html: string,
  sourceLabel: string,
  sourceUrl: string,
): TorrentResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const byHash = new Map<string, TorrentResult>()

  const add = (
    uri: string,
    kind: TorrentResult['kind'],
    title: string,
    context: string,
  ) => {
    const hash = kind === 'magnet' ? magnetInfoHash(uri) : null
    const key = hash ?? uri
    let fileName = ''
    if (kind === 'torrent') {
      try {
        fileName = decodeURIComponent(new URL(uri).pathname.split('/').pop() ?? '').replace(
          /\.torrent$/i,
          '',
        )
      } catch {
        /* use generic title */
      }
    }
    const cleanTitle = (
      title ||
      (kind === 'magnet' ? magnetDisplayName(uri) : fileName) ||
      'Untitled torrent'
    ).trim()
    const existing = byHash.get(key)
    const size = parseSizeText(context)
    const seeders = parseSeedersText(context)
    if (existing) {
      if (!existing.sizeBytes && size) existing.sizeBytes = size
      if (!existing.seeders && seeders) existing.seeders = seeders
      if (existing.title === 'Untitled torrent' && cleanTitle !== 'Untitled torrent') {
        existing.title = cleanTitle
      }
      return
    }
    byHash.set(key, { title: cleanTitle, uri, kind, sizeBytes: size, seeders, sourceLabel })
  }

  for (const anchor of doc.querySelectorAll('a[href^="magnet:"]')) {
    const magnet = anchor.getAttribute('href') ?? ''
    if (!isMagnetLink(magnet)) continue
    const anchorText = anchor.textContent?.trim() ?? ''
    const row = anchor.closest('tr, li, article, div')
    const title =
      anchorText && anchorText.length > 3 && !isMagnetLink(anchorText)
        ? anchorText
        : anchor.getAttribute('title')?.trim() ?? ''
    add(magnet, 'magnet', title, row?.textContent ?? anchorText)
  }

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim() ?? ''
    const contentType = anchor.getAttribute('type')?.toLowerCase() ?? ''
    const download = anchor.getAttribute('download') ?? ''
    let absolute = ''
    try {
      absolute = new URL(href, sourceUrl).toString()
    } catch {
      continue
    }
    const isTorrent =
      isTorrentFileLink(absolute) ||
      contentType === 'application/x-bittorrent' ||
      /\.torrent$/i.test(download)
    if (!isTorrent || !/^https?:\/\//i.test(absolute)) continue
    const anchorText = anchor.textContent?.trim() ?? ''
    const row = anchor.closest('tr, li, article, div')
    const title =
      anchorText && anchorText.length > 3
        ? anchorText
        : anchor.getAttribute('title')?.trim() ?? ''
    add(absolute, 'torrent', title, row?.textContent ?? anchorText)
  }

  // Also catch magnets embedded in raw text instead of an anchor.
  const magnetRe = /magnet:\?[^\s"'<>]+/gi
  let match: RegExpExecArray | null
  while ((match = magnetRe.exec(html)) !== null) {
    add(match[0].replace(/&amp;/gi, '&'), 'magnet', '', '')
  }

  return [...byHash.values()]
}

/** Resolve an image element's real source (handles common lazy-load attrs). */
function extractPoster(scope: Element, pageUrl: string): string {
  const img = scope.querySelector('img')
  if (!img) return ''
  let candidate =
    img.getAttribute('src') ||
    img.getAttribute('data-src') ||
    img.getAttribute('data-original') ||
    img.getAttribute('data-lazy-src') ||
    img.getAttribute('data-echo') ||
    ''
  candidate = candidate.trim()
  if (!candidate) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || ''
    candidate = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? ''
  }
  if (!candidate || /^data:/i.test(candidate)) return ''
  try {
    return new URL(candidate, pageUrl).toString()
  } catch {
    return ''
  }
}

/** Strip rating prefixes and call-to-action noise from a scraped movie title. */
function cleanMovieTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  t = t.replace(/^\d+(?:\.\d+)?\s*\/\s*10\s*/i, '')
  t = t.replace(/\b(?:view details|download|watch(?: now| online| free)?|stream|magnet|torrent)\b/gi, ' ')
  return t.replace(/\s{2,}/g, ' ').trim()
}

function isTorlockUrl(pageUrl: string): boolean {
  try {
    return /(^|\.)torlock\.com$/i.test(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

/** Apex torlock.com often fails TLS in Electron — always use www. */
function normalizeTorlockOrigin(originOrUrl: string): string {
  try {
    const u = new URL(originOrUrl)
    if (/(^|\.)torlock\.com$/i.test(u.hostname)) {
      u.protocol = 'https:'
      u.hostname = 'www.torlock.com'
      return u.origin
    }
    return u.origin
  } catch {
    return 'https://www.torlock.com'
  }
}

function isTorlockTorznabUrl(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl)
    return isTorlockUrl(pageUrl) && /\/torznab\/api\/?$/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Torlock Torznab categories (from /torznab/api?t=caps). */
const TORLOCK_CAT = {
  movies: 2000,
  series: 5000,
  anime: 5070,
} as const

const TORLOCK_PAGE_SIZE = 100

function torlockTorznabUrl(
  origin: string,
  category: keyof typeof TORLOCK_CAT,
  offset = 0,
): string {
  const u = new URL('/torznab/api', normalizeTorlockOrigin(origin))
  u.searchParams.set('t', 'search')
  u.searchParams.set('cat', String(TORLOCK_CAT[category]))
  u.searchParams.set('q', '')
  u.searchParams.set('limit', String(TORLOCK_PAGE_SIZE))
  u.searchParams.set('offset', String(Math.max(0, offset)))
  return u.toString()
}

function torlockCategoryFromUrl(pageUrl: string): keyof typeof TORLOCK_CAT | null {
  try {
    const cat = new URL(pageUrl).searchParams.get('cat')
    if (cat === String(TORLOCK_CAT.movies)) return 'movies'
    if (cat === String(TORLOCK_CAT.anime)) return 'anime'
    if (cat === String(TORLOCK_CAT.series)) return 'series'
  } catch {
    /* ignore */
  }
  if (/\/anime\b/i.test(pageUrl)) return 'anime'
  if (/\/television\b|\/tv\b/i.test(pageUrl)) return 'series'
  if (/\/movie/i.test(pageUrl)) return 'movies'
  return null
}

function isTorlockDecoyTitle(title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t) return true
  return /^\[?movies?\]?(?:\s*[-–:]\s*.*)?$/i.test(t) && t.length < 40
}

export function isYtsUrl(pageUrl: string): boolean {
  try {
    return isYifyHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

/** True when the saved website label is a YTS / YIFY mirror (e.g. "yts.gg", "YTS"). */
export function isYtsLabel(label: string): boolean {
  return /\byts\b|\byify\b/i.test(label.trim())
}

/** Host or label identifies a YTS / YIFY site — use the JSON API, not HTML scrape. */
export function isYtsSource(pageUrl: string, sourceLabel = ''): boolean {
  return isYtsUrl(pageUrl) || isYtsApiUrl(pageUrl) || isYtsLabel(sourceLabel)
}

/** YTS / YIFY and its many mirror domains (yts.mx, en.yts-official.biz, …) */
export function isYifyHost(hostname: string): boolean {
  return /(^|[.-])(yts|yify)([.-]|$)/i.test(hostname) || /yts-official|yifymovies/i.test(hostname)
}

/** YTS API allows up to 50 per page. */
const YTS_PAGE_SIZE = 50
/** Popular Movies — most downloaded (50 × 60 = 3,000). */
export const YTS_POPULAR_MAX_PAGES = 60
/** New Movies — recently uploaded. */
export const YTS_NEW_MAX_PAGES = 40

export type YtsSortBy = 'download_count' | 'date_added' | 'like_count' | 'rating' | 'seeds'

function isYtsApiUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    // Path is enough: labeled mirrors may use hosts that don't contain "yts"
    return /\/api\/v2\/(?:list_movies|movie_details)\.json$/i.test(url.pathname)
  } catch {
    return false
  }
}

function ytsListApiUrl(
  origin: string,
  page: number,
  query?: string,
  sortBy: YtsSortBy = 'date_added',
): string {
  const url = new URL(`${origin}/api/v2/list_movies.json`)
  url.searchParams.set('limit', String(YTS_PAGE_SIZE))
  url.searchParams.set('page', String(Math.max(1, page)))
  url.searchParams.set('sort_by', sortBy)
  url.searchParams.set('order_by', 'desc')
  if (query?.trim()) url.searchParams.set('query_term', query.trim())
  return url.toString()
}

function ytsSortFromUrl(pageUrl: string): YtsSortBy {
  try {
    const sort = new URL(pageUrl).searchParams.get('sort_by') || 'date_added'
    if (
      sort === 'download_count' ||
      sort === 'like_count' ||
      sort === 'rating' ||
      sort === 'seeds' ||
      sort === 'date_added'
    ) {
      return sort
    }
  } catch {
    /* default */
  }
  return 'date_added'
}

function ytsDetailsApiUrl(origin: string, movieId: number): string {
  const url = new URL(`${origin}/api/v2/movie_details.json`)
  url.searchParams.set('movie_id', String(movieId))
  // yts.gg returns an empty stub unless with_images is set
  url.searchParams.set('with_images', 'true')
  return url.toString()
}

function ytsMagnet(hash: string, title: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`
}

interface YtsApiTorrent {
  hash?: string
  quality?: string
  type?: string
  seeds?: number
  size_bytes?: number
  date_uploaded_unix?: number
}

interface YtsApiMovie {
  id?: number
  url?: string
  title?: string
  title_long?: string
  year?: number
  rating?: number
  /** Runtime in minutes (YTS list/details API). */
  runtime?: number
  genres?: string[]
  summary?: string
  description_full?: string
  medium_cover_image?: string
  large_cover_image?: string
  small_cover_image?: string
  torrents?: YtsApiTorrent[]
  date_uploaded_unix?: number
}

function ytsRuntimeSeconds(movie: YtsApiMovie): number | undefined {
  const mins = Number(movie.runtime)
  if (!Number.isFinite(mins) || mins < 1) return undefined
  return Math.round(mins * 60)
}

/** Look up authoritative runtime (seconds) from a YTS movie_details.json URL. */
export async function fetchYtsRuntimeSeconds(
  detailUrl: string | undefined,
): Promise<number | undefined> {
  if (!detailUrl || !/yts\./i.test(detailUrl)) return undefined
  try {
    const url = new URL(detailUrl)
    if (!/movie_details\.json/i.test(url.pathname)) return undefined
    if (!url.searchParams.has('with_images')) {
      url.searchParams.set('with_images', 'true')
    }
    const href = url.toString()
    let body = ''
    if (window.signalDesktop?.fetchHtml) {
      const result = await window.signalDesktop.fetchHtml(href)
      if (!result?.ok || !result.content) return undefined
      body = result.content
    } else {
      const response = await fetch(href)
      if (!response.ok) return undefined
      body = await response.text()
    }
    const json = JSON.parse(body) as { data?: { movie?: YtsApiMovie } }
    return ytsRuntimeSeconds(json?.data?.movie as YtsApiMovie)
  } catch {
    return undefined
  }
}

function ytsMovieTitle(movie: YtsApiMovie): string {
  return (
    movie.title_long?.trim() ||
    [movie.title?.trim(), movie.year ? `(${movie.year})` : ''].filter(Boolean).join(' ') ||
    'Untitled'
  )
}

function ytsReleasedAt(movie: YtsApiMovie): number | undefined {
  const uploaded = movie.date_uploaded_unix ? movie.date_uploaded_unix * 1000 : undefined
  const year = Number(movie.year)
  // Prefer theatrical year so Movies sorts 2026 → 1950s, not by torrent upload day.
  if (Number.isFinite(year) && year >= 1800 && year <= 2100) {
    if (uploaded) {
      const uploadedYear = new Date(uploaded).getUTCFullYear()
      if (uploadedYear === year) return uploaded
    }
    return Date.UTC(year, 0, 1)
  }
  return uploaded
}

function ytsTorrentResults(
  movie: YtsApiMovie,
  sourceLabel: string,
): { results: TorrentResult[]; bestUri?: string; releasedAt?: number } {
  const title = ytsMovieTitle(movie)
  const results: TorrentResult[] = []
  let releasedAt = ytsReleasedAt(movie)

  for (const torrent of movie.torrents ?? []) {
    const hash = torrent.hash?.trim()
    if (!hash) continue
    const quality = torrent.quality?.trim() || 'unknown'
    const type = torrent.type?.trim()
    const label = `${title} [${quality}]${type ? ` [${type}]` : ''}`
    const uri = ytsMagnet(hash, label)
    const sizeBytes = Number(torrent.size_bytes) || 0
    const seeders = Number(torrent.seeds) || 0
    if (torrent.date_uploaded_unix) {
      const ts = torrent.date_uploaded_unix * 1000
      // Only let upload time refine sorting when we don't already have a year.
      if (!movie.year && (!releasedAt || ts > releasedAt)) releasedAt = ts
    }
    results.push({
      title: label,
      uri,
      kind: 'magnet',
      sizeBytes,
      seeders,
      sourceLabel,
    })
  }

  const pick = pickBestStream(results, 0, 1080)
  return { results, bestUri: pick?.result.uri, releasedAt }
}

/** Infer media category from a listing page URL or surrounding text. */
export function inferTorrentCategory(
  pageUrl: string,
  title = '',
  summary = '',
): 'movies' | 'series' | 'anime' {
  const hay = `${pageUrl} ${title} ${summary}`.toLowerCase()
  if (/\/anime\b|\banime\b|ova\b|hentai\b/.test(hay)) return 'anime'
  if (
    /\/television\b|\/tv\b|\/series\b|\btv\s*series\b|\bseason\b|\bs\d{1,2}e\d{1,2}\b|\bep(?:isode)?\s*\d|\bcomplete\s*series\b/.test(
      hay,
    )
  ) {
    return 'series'
  }
  return 'movies'
}

/** Parse "Today", "Yesterday", or M/D/YYYY-style dates from listing rows. */
export function parseReleaseDate(text: string, now = Date.now()): number | undefined {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  if (/\btoday\b/i.test(cleaned)) return now
  if (/\byesterday\b/i.test(cleaned)) return now - 86_400_000

  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(cleaned)
  if (us) {
    const month = Number(us[1]) - 1
    const day = Number(us[2])
    const year = Number(us[3])
    const d = new Date(year, month, day).getTime()
    return Number.isFinite(d) ? d : undefined
  }

  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(cleaned)
  if (iso) {
    const d = Date.parse(iso[0])
    return Number.isFinite(d) ? d : undefined
  }

  const yearOnly = /\b(19|20)\d{2}\b/.exec(cleaned)
  if (yearOnly) {
    const d = new Date(Number(yearOnly[0]), 0, 1).getTime()
    return Number.isFinite(d) ? d : undefined
  }
  return undefined
}

/**
 * Torlock HTML listings: detail pages are /torrent/<id>/<slug>.html on
 * torlock.com (often unquoted hrefs). Ads use rotating *.t0r.space hosts with
 * decoy "Movie - Full Version" titles — skip those.
 */
function scrapeTorlockLinks(html: string, pageUrl: string): TorrentPageLink[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageCategory = inferTorrentCategory(pageUrl)
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  const now = Date.now()

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const raw = anchor.getAttribute('href')?.trim() ?? ''
    let url: URL
    try {
      url = new URL(raw, pageUrl)
    } catch {
      continue
    }
    const hostOk =
      /(^|\.)torlock\.com$/i.test(url.hostname) || /(^|\.)t0r\.space$/i.test(url.hostname)
    if (!hostOk) continue
    if (!/^\/torrent\/\d+\/[^/]+\.html$/i.test(url.pathname)) continue

    // Prefer the canonical torlock.com detail URL when the href is on t0r.space.
    if (/(^|\.)t0r\.space$/i.test(url.hostname)) {
      try {
        url = new URL(url.pathname, 'https://www.torlock.com')
      } catch {
        continue
      }
    }

    url.hash = ''
    const absolute = url.toString()
    if (seen.has(absolute)) continue

    const row = anchor.closest('tr, article, li, .torrent, .item')
    const title = cleanMovieTitle(
      anchor.getAttribute('title')?.trim() ||
        anchor.textContent?.replace(/\s+/g, ' ').trim() ||
        '',
    )
    if (title.length < 2 || isTorlockDecoyTitle(title)) continue

    const rowText = row?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

    // On mixed/search pages, use the row's category link when present.
    let category = pageCategory
    if (row?.querySelector('a[href*="/anime/"]')) category = 'anime'
    else if (row?.querySelector('a[href*="/television/"]')) category = 'series'
    else if (row?.querySelector('a[href*="/movie/"]')) category = 'movies'
    else category = inferTorrentCategory(pageUrl, title, rowText)

    // When browsing a filtered category page, drop rows from other buckets.
    if (pageCategory === 'movies' && category !== 'movies') continue
    if (pageCategory === 'series' && category !== 'series') continue
    if (pageCategory === 'anime' && category !== 'anime') continue

    const poster = extractPoster(row ?? anchor, pageUrl)
    links.push({
      title: title.slice(0, 180),
      url: absolute,
      summary: rowText && rowText !== title ? rowText.slice(0, 220) : '',
      poster: poster || undefined,
      category,
      releasedAt: parseReleaseDate(rowText, now),
    })
    seen.add(absolute)
    if (links.length >= 300) break
  }

  return links
}

function xmlTagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  if (!m) return ''
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function torznabAttr(block: string, name: string): string {
  const m = block.match(
    new RegExp(`<torznab:attr[^>]*name="${name}"[^>]*value="([^"]*)"`, 'i'),
  )
  return m?.[1]?.trim() ?? ''
}

/** Parse Torlock Torznab RSS into catalog links (preferred over HTML scrape). */
function scrapeTorlockTorznab(xml: string, pageUrl: string): {
  links: TorrentPageLink[]
  nextPage: string | null
} {
  const feedCategory = torlockCategoryFromUrl(pageUrl) ?? 'movies'
  const origin = new URL(pageUrl).origin
  const offset = Math.max(0, Number(new URL(pageUrl).searchParams.get('offset') || 0) || 0)
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()

  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const title = cleanMovieTitle(xmlTagText(block, 'title'))
    if (title.length < 2 || isTorlockDecoyTitle(title)) continue

    const catAttr = torznabAttr(block, 'category') || xmlTagText(block, 'category')
    // Parent TV (5000) responses can include Anime (5070) — keep shelves clean.
    if (feedCategory === 'series' && catAttr === String(TORLOCK_CAT.anime)) continue
    if (feedCategory === 'anime' && catAttr && catAttr !== String(TORLOCK_CAT.anime)) continue
    if (feedCategory === 'movies' && catAttr && catAttr !== String(TORLOCK_CAT.movies)) continue

    const guid = xmlTagText(block, 'guid') || xmlTagText(block, 'comments')
    const magnet =
      torznabAttr(block, 'magneturl') ||
      (() => {
        const link = xmlTagText(block, 'link')
        return /^magnet:\?/i.test(link) ? link : ''
      })()
    let detail = guid
    if (!detail || !/^https?:\/\//i.test(detail)) {
      const pathMatch = /\/torrent\/\d+\/[^/\s]+\.html/i.exec(block)
      detail = pathMatch ? new URL(pathMatch[0], origin).toString() : ''
    }
    if (!detail && !magnet) continue
    const url = detail || magnet
    if (seen.has(url)) continue
    seen.add(url)

    const pub = xmlTagText(block, 'pubDate')
    const releasedAt = pub ? Date.parse(pub) : undefined
    const seeders = Number(torznabAttr(block, 'seeders') || 0) || 0

    links.push({
      title: title.slice(0, 180),
      url,
      summary: seeders ? `${seeders.toLocaleString()} seeders` : 'Torlock',
      category: feedCategory,
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
      torrentUri: magnet || undefined,
    })
  }

  // First page only — do not offer further Torznab offsets.
  return { links, nextPage: null }
}

async function scrapeTorlockPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  // Prefer Torznab — HTML listings hide/obfuscate titles and break plain scrapers.
  let apiUrl = pageUrl
  if (!isTorlockTorznabUrl(pageUrl)) {
    const origin = new URL(pageUrl).origin
    const category = torlockCategoryFromUrl(pageUrl) ?? 'movies'
    apiUrl = torlockTorznabUrl(origin, category, 0)
  }

  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) {
    return emptyOutcome(apiUrl, sourceLabel, fetchError || 'could not load Torznab feed')
  }
  if (!/<item[\s>]/i.test(content) && !/<rss[\s>]/i.test(content)) {
    return emptyOutcome(apiUrl, sourceLabel, 'Torznab response was not a feed')
  }

  const { links, nextPage } = scrapeTorlockTorznab(content, apiUrl)
  const searchTemplate = (() => {
    const u = new URL('/torznab/api', new URL(apiUrl).origin)
    u.searchParams.set('t', 'search')
    u.searchParams.set('cat', String(TORLOCK_CAT.movies))
    u.searchParams.set('q', QUERY_TOKEN)
    u.searchParams.set('limit', String(TORLOCK_PAGE_SIZE))
    u.searchParams.set('offset', '0')
    return u.toString()
  })()
  return {
    results: [],
    links,
    pageTitle: sourceLabel,
    pageUrl: apiUrl,
    nextPage,
    prevPage: null,
    searchTemplate,
    error:
      links.length === 0
        ? `${sourceLabel}: Torznab feed returned no titles`
        : null,
  }
}

/**
 * YTS / YIFY browse pages (and mirrors) — movie cards with posters and year.
 * The real title lives in `.browse-movie-title`; overlay text carries only
 * ratings and genres, so it must never be used as the title.
 */
export function looksLikeYtsHtml(html: string): boolean {
  return /browse-movie-wrap|browse-movie-title|YIFY Movies/i.test(html)
}

function scrapeYtsLinks(html: string, pageUrl: string): TorrentPageLink[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  const now = Date.now()

  const push = (rawHref: string, title: string, year: string, poster: string) => {
    let url: URL
    try {
      url = new URL(rawHref, pageUrl)
    } catch {
      return
    }
    if (!/\/(?:movie|movies)\//i.test(url.pathname)) return
    url.hash = ''
    const absolute = url.toString().replace(/\/$/, '')
    if (seen.has(absolute)) return
    const cleanTitle = cleanMovieTitle(title)
    if (cleanTitle.length < 2) return
    seen.add(absolute)
    links.push({
      title: cleanTitle.slice(0, 180),
      url: absolute,
      summary: year ? `Movie · ${year}` : 'Movie',
      poster: poster || undefined,
      category: 'movies',
      releasedAt: parseReleaseDate(year, now),
    })
  }

  // Preferred: YTS card markup used by the official site and its mirrors.
  // The title anchor (.browse-movie-title) carries the real name; the image
  // link overlay only holds rating/genre text, so never read from it.
  for (const card of doc.querySelectorAll('.browse-movie-wrap')) {
    const titleEl = card.querySelector('.browse-movie-title')
    const href =
      titleEl?.getAttribute('href') ||
      card.querySelector('a.browse-movie-link')?.getAttribute('href') ||
      card.querySelector('a[href*="/movies/"]')?.getAttribute('href') ||
      ''
    if (!href) continue
    const title =
      titleEl?.textContent?.replace(/\s+/g, ' ').trim() ||
      card.querySelector('img')?.getAttribute('alt')?.trim() ||
      ''
    const year = card.querySelector('.browse-movie-year')?.textContent?.trim() || ''
    const poster = extractPoster(card, pageUrl)
    push(href, title, year, poster)
  }

  // Fallback for mirrors without .browse-movie-wrap: several anchors point
  // at the same /movies/<slug> page (poster overlay with rating + genres,
  // then the real title link), so gather candidates per URL and keep the one
  // that actually reads like a title.
  if (links.length === 0) {
    interface Candidate {
      url: URL
      title: string
      year: string
      poster: string
    }
    const overlayRe = /\d(?:\.\d)?\s*\/\s*10|view details|^(?:watch|download)\b/i
    const genreOnlyRe =
      /^(?:(?:action|adventure|animation|biography|comedy|crime|documentary|drama|family|fantasy|film-?noir|game-?show|history|horror|music(?:al)?|mystery|news|reality-?tv|romance|sci-?fi|sport|talk-?show|thriller|war|western)[\s,·|-]*)+$/i
    const byUrl = new Map<string, Candidate>()

    for (const anchor of doc.querySelectorAll('a[href*="/movies/"], a[href*="/movie/"]')) {
      let url: URL
      try {
        url = new URL(anchor.getAttribute('href') ?? '', pageUrl)
      } catch {
        continue
      }
      if (!/\/(?:movie|movies)\//i.test(url.pathname)) continue
      url.hash = ''
      const key = url.toString().replace(/\/$/, '')

      const title = cleanMovieTitle(
        anchor.getAttribute('title')?.trim() ||
          anchor.textContent?.replace(/\s+/g, ' ').trim() ||
          anchor.querySelector('img')?.getAttribute('alt')?.trim() ||
          '',
      )
      const card = anchor.closest('div, figure, article, li') ?? anchor
      const context = card.textContent?.replace(/\s+/g, ' ') ?? ''
      const year = /\b(19|20)\d{2}\b/.exec(context)?.[0] ?? ''
      const poster = extractPoster(card, pageUrl)

      const existing = byUrl.get(key)
      if (!existing) {
        byUrl.set(key, { url, title, year, poster })
        continue
      }
      if (!existing.poster && poster) existing.poster = poster
      if (!existing.year && year) existing.year = year
      const existingIsJunk =
        existing.title.length < 2 ||
        overlayRe.test(existing.title) ||
        genreOnlyRe.test(existing.title)
      const currentIsJunk = title.length < 2 || overlayRe.test(title) || genreOnlyRe.test(title)
      if (existingIsJunk && !currentIsJunk) existing.title = title
    }

    for (const candidate of byUrl.values()) {
      if (overlayRe.test(candidate.title) || genreOnlyRe.test(candidate.title)) continue
      push(candidate.url.toString(), candidate.title, candidate.year, candidate.poster)
    }
  }

  return links
}

/** Extract ordinary navigable links so listing pages can be browsed in Jiyu. */
export function scrapePageLinks(html: string, pageUrl: string): TorrentPageLink[] {
  if (isTorlockUrl(pageUrl)) return scrapeTorlockLinks(html, pageUrl)
  // Detect YTS/YIFY by host OR page markup so unknown mirrors still parse cleanly
  if (isYtsUrl(pageUrl) || looksLikeYtsHtml(html)) {
    const yts = scrapeYtsLinks(html, pageUrl)
    if (yts.length > 0) return yts
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageOrigin = new URL(pageUrl).origin
  const assetRe = /\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp4|mkv|webm)$/i
  const allowedCategoryRe = /\b(?:movies?|films?|tv|television|series|shows?|anime)\b/i
  const categoryRouteRe = /(?:^|[/_-])(?:category|categories|browse|type|section|genre)(?:[/_?=&-]|$)/i
  const categoryLabelRe =
    /^(?:movies?|films?|tv|television|series|shows?|anime|games?|music|software|apps?|books?|ebooks?|audio|adult|xxx|other)$/i
  const now = Date.now()
  const pageCategory = inferTorrentCategory(pageUrl)

  interface Group {
    url: URL
    container: Element | null
    titles: string[]
    poster: string
  }
  const groups = new Map<string, Group>()
  const order: string[] = []

  // A movie block often has separate poster and title anchors pointing to the
  // same detail URL. Group by URL so each film becomes one card with a poster.
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const raw = anchor.getAttribute('href')?.trim() ?? ''
    if (!raw || raw.startsWith('#') || /^(?:magnet|javascript|mailto|tel):/i.test(raw)) continue
    let url: URL
    try {
      url = new URL(raw, pageUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== pageOrigin) continue
    if (/\.torrent$/i.test(url.pathname) || assetRe.test(url.pathname)) continue
    url.hash = ''
    const absolute = url.toString()

    let group = groups.get(absolute)
    if (!group) {
      group = {
        url,
        container: anchor.closest('article, tr, li, section, div'),
        titles: [],
        poster: '',
      }
      groups.set(absolute, group)
      order.push(absolute)
    }

    const imgAlt = anchor.querySelector('img')?.getAttribute('alt')?.trim() ?? ''
    const titleAttr = anchor.getAttribute('title')?.trim() ?? ''
    const anchorText = anchor.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    for (const candidate of [imgAlt, titleAttr, anchorText]) {
      if (candidate) group.titles.push(candidate)
    }
    if (!group.poster) group.poster = extractPoster(anchor, pageUrl)
  }

  const links: TorrentPageLink[] = []
  for (const absolute of order) {
    const group = groups.get(absolute)
    if (!group) continue
    const { url } = group

    let poster = group.poster
    if (!poster && group.container) poster = extractPoster(group.container, pageUrl)

    // Prefer the shortest meaningful candidate — usually the title itself,
    // not the rating/genre/"View Details" overlay text.
    let title = ''
    for (const candidate of group.titles) {
      const cleaned = cleanMovieTitle(candidate)
      if (cleaned.length < 2) continue
      if (!title || (cleaned.length >= 3 && cleaned.length < title.length)) title = cleaned
    }
    if (!title && group.container) {
      title = cleanMovieTitle(group.container.textContent ?? '').slice(0, 120)
    }
    if (title.length < 2) continue

    // Category/nav links are limited to Movies, TV/Series, and Anime.
    const looksLikeCategory =
      categoryRouteRe.test(`${url.pathname}${url.search}`) || categoryLabelRe.test(title)
    if (looksLikeCategory && !allowedCategoryRe.test(`${title} ${url.pathname} ${url.search}`)) {
      continue
    }

    const context = group.container?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const summary = context && context !== title ? context.slice(0, 220) : ''
    links.push({
      title: title.slice(0, 180),
      url: absolute,
      summary,
      poster: poster || undefined,
      category: inferTorrentCategory(absolute, title, summary) || pageCategory,
      releasedAt: parseReleaseDate(summary, now),
    })
    if (links.length >= 300) break
  }
  return links
}

export function formatSize(bytes: number): string {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1024 ** 2
  return `${mb.toFixed(0)} MB`
}

/** Detect a video quality (vertical resolution) from a torrent title. 0 = unknown. */
export function parseQuality(title: string): number {
  const t = title.toLowerCase()
  if (/2160p|\buhd\b|\b4k\b/.test(t)) return 2160
  if (/1440p|\b2k\b|\bqhd\b/.test(t)) return 1440
  if (/1080p|\bfhd\b/.test(t)) return 1080
  if (/720p|\bhd\b/.test(t)) return 720
  if (/480p/.test(t)) return 480
  return 0
}

export function labelQuality(quality: number): string {
  if (quality >= 2160) return '4K'
  if (quality >= 1440) return '1440p'
  if (quality >= 1080) return '1080p'
  if (quality >= 720) return '720p'
  if (quality > 0) return `${quality}p`
  return 'best available'
}

/** Effective downlink (Mbps) estimate from the browser, 0 if unknown. */
export function getConnectionDownlinkMbps(): number {
  const conn = (navigator as unknown as { connection?: { downlink?: number } }).connection
  return typeof conn?.downlink === 'number' && conn.downlink > 0 ? conn.downlink : 0
}

/** Highest quality a connection can comfortably sustain. Prefer 720p first. */
export function targetQualityForSpeed(downlinkMbps: number): number {
  let network = 720
  if (downlinkMbps <= 0) network = 720 // unknown → start at 720p
  else if (downlinkMbps >= 25) network = 2160
  else if (downlinkMbps >= 12) network = 1080
  // Device profile caps Auto so weak machines don't attempt 4K remux.
  return clampQualityToDevice(network)
}

export interface BestStreamPick {
  result: TorrentResult
  quality: number
  target: number
}

/**
 * Choose the best torrent for the connection: the highest quality at or below
 * the speed target, falling back to the lowest available if all exceed it.
 * Seeders and size break ties.
 */
export function pickBestStream(
  results: TorrentResult[],
  downlinkMbps: number,
  preferredQuality?: number,
): BestStreamPick | null {
  if (results.length === 0) return null
  const target = preferredQuality ?? targetQualityForSpeed(downlinkMbps)

  // Seed counts are only known when the page listed them; when some links have
  // seeds, skip the ones confirmed at zero — they will never produce data.
  const seeded = results.filter((r) => r.seeders > 0)
  if (seeded.length > 0) results = seeded

  const annotated = results.map((result) => ({ result, quality: parseQuality(result.title) }))
  const known = annotated.filter((x) => x.quality > 0)

  if (known.length === 0) {
    const best = [...results].sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)[0]
    return { result: best, quality: 0, target }
  }

  const atOrBelow = known.filter((x) => x.quality <= target)
  if (atOrBelow.length > 0) {
    // Seeds first: a living 480p beat a dead 720p every time for streaming.
    atOrBelow.sort(
      (a, b) =>
        b.result.seeders - a.result.seeders ||
        b.quality - a.quality ||
        b.result.sizeBytes - a.result.sizeBytes,
    )
    return { result: atOrBelow[0].result, quality: atOrBelow[0].quality, target }
  }

  // Everything is above the target — take the healthiest, then lowest quality
  known.sort(
    (a, b) =>
      b.result.seeders - a.result.seeders ||
      a.quality - b.quality ||
      b.result.sizeBytes - a.result.sizeBytes,
  )
  return { result: known[0].result, quality: known[0].quality, target }
}

/** Best episode to auto-start: most seeders, else the newest key. */
export function pickBestEpisodeIndex(episodes: EpisodeChoice[]): number {
  if (episodes.length === 0) return 0
  let best = 0
  let bestSeeds = episodes[0].seeders ?? 0
  for (let i = 1; i < episodes.length; i++) {
    const seeds = episodes[i].seeders ?? 0
    if (seeds > bestSeeds) {
      best = i
      bestSeeds = seeds
    }
  }
  if (bestSeeds > 0) return best
  // All reported dead — newest episode is the least-bad guess.
  return episodes.length - 1
}

export function torrentUrisForEpisode(ep: EpisodeChoice): string[] {
  return [ep.torrentUri, ...(ep.alternates || [])].filter(
    (uri, i, arr) => Boolean(uri) && arr.indexOf(uri) === i,
  )
}

/** Pull an episode / SxxExx token out of a torrent title for grouping. */
export function parseEpisodeKey(title: string): string | null {
  const sxxexx = /\bS(\d{1,2})E(\d{1,3})\b/i.exec(title)
  if (sxxexx) return `S${sxxexx[1].padStart(2, '0')}E${sxxexx[2].padStart(2, '0')}`

  const nxn = /\b(\d{1,2})x(\d{1,3})\b/i.exec(title)
  if (nxn) return `S${nxn[1].padStart(2, '0')}E${nxn[2].padStart(2, '0')}`

  const epHash = /\bEpisode\s*#?\s*(\d+(?:\.\d+)?)\b/i.exec(title)
  if (epHash) return `E${epHash[1]}`

  const epWord = /\b(?:Ep(?:isode)?\.?\s*|E)(\d+(?:\.\d+)?)\b/i.exec(title)
  if (epWord) return `E${epWord[1]}`

  const dashEp = /\s[-–]\s*(\d{1,3}(?:\.\d+)?)\s*(?:\[|\(|$)/.exec(title)
  if (dashEp) return `E${dashEp[1]}`

  return null
}

/** Strip episode/quality noise so sibling catalog rows of the same show match. */
export function normalizeShowKey(title: string): string {
  return cleanShowDisplayTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Human-readable show name from an EZTV / release title (drops SxxExx + quality). */
export function cleanShowDisplayTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bS\d{1,2}E\d{1,3}\b[\s\S]*$/i, ' ')
    .replace(/\b\d{1,2}x\d{1,3}\b[\s\S]*$/i, ' ')
    .replace(/\b(?:Episode|Ep\.?)\s*#?\s*\d+(?:\.\d+)?\b[\s\S]*$/i, ' ')
    .replace(
      /\b(?:720p|1080p|2160p|480p|4k|uhd|hevc|h\.?265|h\.?264|x264|x265|web-?dl|bluray|eztv|proper|repack|extended|unrated)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
}

export interface EpisodeChoice {
  key: string
  title: string
  torrentUri: string
  quality: number
  /** Other magnets for this episode (seeders desc) when the primary swarm is dead. */
  alternates?: string[]
  seeders?: number
}

/**
 * Collapse a flat magnet list (many qualities × many episodes) into one
 * best-quality pick per episode, ordered naturally for the player drawer.
 */
/** Group key for a release — episode token, or title without quality (movies/OVAs). */
function episodeGroupKey(title: string): string | null {
  const ep = parseEpisodeKey(title)
  if (ep) return ep
  const showKey = normalizeShowKey(title)
  return showKey.length >= 2 ? `T:${showKey}` : null
}

export function buildEpisodeChoices(
  results: TorrentResult[],
  downlinkMbps: number,
  preferredQuality?: number,
  options?: { minDistinctEpisodes?: number; seededOnly?: boolean },
): EpisodeChoice[] {
  const minDistinct = options?.minDistinctEpisodes ?? 2
  const seededOnly = options?.seededOnly === true
  const byEpisode = new Map<string, TorrentResult[]>()
  for (const result of results) {
    const key = episodeGroupKey(result.title)
    if (!key) continue
    // Hide confirmed-dead magnets when the caller wants a seeded-only list.
    if (seededOnly && (result.seeders ?? 0) <= 0) continue
    const list = byEpisode.get(key)
    if (list) list.push(result)
    else byEpisode.set(key, [result])
  }

  // Player playlist needs multiple episodes; show pages can list a single ep.
  if (byEpisode.size < minDistinct) return []

  const episodes: EpisodeChoice[] = []
  for (const [key, group] of byEpisode) {
    const pick = pickBestStream(group, downlinkMbps, preferredQuality)
    if (!pick) continue
    if (seededOnly && (pick.result.seeders ?? 0) <= 0) continue
    const showTitle = pick.result.title
      .replace(/\s*\(\d{3,4}p\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    const alternates = [...group]
      .filter((r) => r.uri !== pick.result.uri && (!seededOnly || r.seeders > 0))
      .sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)
      .map((r) => r.uri)
      .filter((uri, i, arr) => arr.indexOf(uri) === i)
      .slice(0, 4)
    episodes.push({
      key,
      title: showTitle || `Episode ${key}`,
      torrentUri: pick.result.uri,
      quality: pick.quality,
      seeders: pick.result.seeders,
      alternates: alternates.length ? alternates : undefined,
    })
  }

  // Chronological when seeded-only; otherwise float living swarms first.
  episodes.sort((a, b) => {
    if (!seededOnly) {
      const aLive = (a.seeders ?? 0) > 0 ? 1 : 0
      const bLive = (b.seeders ?? 0) > 0 ? 1 : 0
      if (aLive !== bLive) return bLive - aLive
    }
    return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' })
  })
  return episodes
}

/** Series / anime torrent cards open an episode list before playback. */
export function isShowBrowseItem(item: Pick<StreamItem, 'category' | 'transport' | 'sourceKind'>): boolean {
  return (
    (item.category === 'series' || item.category === 'anime') &&
    (item.transport === 'torrent' || item.sourceKind === 'torrent')
  )
}

function isEpisodeReleaseRow(item: StreamItem): boolean {
  if (!isShowBrowseItem(item)) return false
  if (!(item.torrentUri && isTorrentInput(item.torrentUri))) return false
  return Boolean(parseEpisodeKey(item.title))
}

/**
 * Shelf view: one card per show. Episode magnets stay in the catalog for the
 * episode list / player — this only collapses what the grid displays.
 */
export function collapseEpisodeRowsToShows(items: StreamItem[]): StreamItem[] {
  const passthrough: StreamItem[] = []
  const showCards = new Map<string, StreamItem>()
  const episodeGroups = new Map<string, StreamItem[]>()

  for (const item of items) {
    if (!isShowBrowseItem(item)) {
      passthrough.push(item)
      continue
    }
    const key = `${item.torrentSourceId || item.source || 'torrent'}:${normalizeShowKey(item.title)}`
    if (!key.endsWith(':') && normalizeShowKey(item.title).length >= 2 && isEpisodeReleaseRow(item)) {
      const list = episodeGroups.get(key)
      if (list) list.push(item)
      else episodeGroups.set(key, [item])
      continue
    }
    // Already a show-level card (EZTV /shows/…, SubsPlease show page, etc.)
    const prev = showCards.get(key)
    if (!prev || (item.releasedAt ?? 0) > (prev.releasedAt ?? 0) || (!prev.poster && item.poster)) {
      showCards.set(key, {
        ...item,
        title: cleanShowDisplayTitle(item.title) || item.title,
      })
    }
  }

  for (const [key, group] of episodeGroups) {
    if (showCards.has(key)) continue
    let best = group[0]
    for (const row of group) {
      const betterPoster = !best.poster && row.poster
      const newer = (row.releasedAt ?? 0) > (best.releasedAt ?? 0)
      const sharper = parseQuality(row.title) > parseQuality(best.title)
      if (betterPoster || newer || sharper) best = row
    }
    const showTitle = cleanShowDisplayTitle(best.title) || best.title
    const epCount = new Set(group.map((row) => parseEpisodeKey(row.title)).filter(Boolean)).size
    showCards.set(key, {
      ...best,
      title: showTitle,
      description: epCount > 0 ? `${epCount} episode${epCount === 1 ? '' : 's'}` : best.description,
      // Keep a magnet so /show/:id resolves; siblings still supply the full list.
      detailUrl: best.detailUrl,
    })
  }

  return [...passthrough, ...showCards.values()]
}

/** Origin for EZTV API calls from a catalog row (show page / API / magnet host). */
function eztvOriginForItem(item: StreamItem): string | null {
  for (const candidate of [item.detailUrl, item.url]) {
    if (!candidate || candidate.startsWith('magnet:')) continue
    try {
      if (isEztvUrl(candidate)) return new URL(candidate).origin
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Resolve the episode list for a TV / anime show card (detail scrape) or a
 * per-episode magnet row (sibling catalog grouping).
 */
export async function resolveShowEpisodes(
  item: StreamItem,
  catalog: StreamItem[],
): Promise<{ episodes: EpisodeChoice[]; error?: string }> {
  const preference = getViewingQuality()
  const downlink = getConnectionDownlinkMbps()
  // Auto still prefers 720p first (anime + series); explicit prefs win.
  const requestedQuality = preference === 'auto' ? 720 : preference
  const sourceLabel = item.source || 'torrent'

  const detail = item.detailUrl || item.url
  let isEztvDetail = false
  try {
    isEztvDetail =
      Boolean(detail) &&
      !detail.startsWith('magnet:') &&
      (isEztvShowUrl(detail) ||
        (isEztvApiUrl(detail) && Boolean(new URL(detail).searchParams.get('imdb_id'))))
  } catch {
    isEztvDetail = false
  }
  const eztvOrigin = eztvOriginForItem(item)
  const isSubsPleaseItem =
    isSubsPleaseUrl(detail || '') ||
    isSubsPleaseUrl(item.url || '') ||
    isSubsPleaseUrl(item.detailUrl || '')
  const isEztvItem =
    !isSubsPleaseItem &&
    (Boolean(eztvOrigin) ||
      isEztvSource(detail || '', sourceLabel) ||
      isEztvSource(item.url || '', sourceLabel))

  const toEpisodes = (results: TorrentResult[], seededOnly = false) =>
    buildEpisodeChoices(results, downlink, requestedQuality, {
      minDistinctEpisodes: 1,
      // Seed filter is EZTV-only — never apply to SubsPlease.
      seededOnly: seededOnly && isEztvItem && !isSubsPleaseItem,
    })

  const noSeededError =
    'No episodes with listed seeders right now. Dead magnets are hidden.'

  // EZTV happy path: TVMaze (catalog title) → open get-torrents API.
  // Do this before scraping /shows/… HTML (Cloudflare) or trusting a URL slug.
  if (isEztvItem && eztvOrigin && item.title.trim()) {
    const byTitle = await resolveEztvEpisodesByTitle(
      item.title,
      eztvOrigin,
      sourceLabel,
    )
    if (byTitle.length > 0) {
      const grouped = toEpisodes(byTitle, true)
      if (grouped.length > 0) return { episodes: grouped }
      return { episodes: [], error: noSeededError }
    }
  }

  // API/show detail URL (imdb_id API URLs stay challenge-free).
  if (isEztvItem && isEztvDetail) {
    const outcome = await scrapePage(detail, sourceLabel)
    if (outcome.results.length > 0) {
      const grouped = toEpisodes(outcome.results, true)
      if (grouped.length > 0) return { episodes: grouped }
      return { episodes: [], error: outcome.error || noSeededError }
    }
  }

  // Prefer catalog siblings next (SubsPlease / multi-ep shelves).
  // Never seed-filter — SubsPlease rows don't carry seeder counts.
  const fromCatalog = buildCatalogEpisodeChoices(item, catalog, downlink, requestedQuality, {
    minDistinctEpisodes: 1,
  })
  if (fromCatalog.length > 0) return { episodes: fromCatalog }

  // New Releases carry a single-ep magnet plus a show page — scrape the show
  // so the player still gets the full episode list when possible.
  let showPage: string | null = null
  try {
    if (
      item.detailUrl &&
      !item.detailUrl.startsWith('magnet:') &&
      isSubsPleaseUrl(item.detailUrl) &&
      /^\/shows\/[^/]+/i.test(new URL(item.detailUrl).pathname)
    ) {
      showPage = item.detailUrl
    }
  } catch {
    showPage = null
  }
  if (showPage) {
    const outcome = await scrapePage(showPage, sourceLabel)
    const grouped = toEpisodes(outcome.results)
    if (grouped.length > 0) return { episodes: grouped }
  }

  const uri = item.torrentUri ?? ''
  if (uri && isTorrentInput(uri)) {
    return {
      episodes: [
        {
          key: parseEpisodeKey(item.title) || 'E01',
          title: item.title,
          torrentUri: uri,
          quality: parseQuality(item.title),
        },
      ],
    }
  }

  if (!detail || detail.startsWith('magnet:')) {
    return { episodes: [], error: 'No episodes found for this title.' }
  }
  if (isEztvItem) {
    return {
      episodes: [],
      error: 'No playable episodes found for this title.',
    }
  }
  const outcome = await scrapePage(detail, sourceLabel)
  if (outcome.results.length === 0) {
    return { episodes: [], error: outcome.error || 'No episodes found for this title.' }
  }

  const grouped = toEpisodes(outcome.results)
  if (grouped.length > 0) return { episodes: grouped }

  return {
    episodes: [],
    error: outcome.error || 'No playable episodes found.',
  }
}

/**
 * Build an episode playlist from other catalog rows of the same show.
 * Used for TV Series (EZTV-style per-episode magnets) and anime shelves.
 */
export function buildCatalogEpisodeChoices(
  current: StreamItem,
  catalog: StreamItem[],
  downlinkMbps: number,
  preferredQuality?: number,
  options?: { minDistinctEpisodes?: number },
): EpisodeChoice[] {
  if (current.category !== 'series' && current.category !== 'anime') return []
  const showKey = normalizeShowKey(current.title)
  if (showKey.length < 2) return []

  const siblings = catalog.filter(
    (item) =>
      item.category === current.category &&
      Boolean(item.torrentUri && isTorrentInput(item.torrentUri)) &&
      normalizeShowKey(item.title) === showKey,
  )

  // Ensure the title being played is included even if it only has a detail URL.
  if (
    current.torrentUri &&
    isTorrentInput(current.torrentUri) &&
    !siblings.some((item) => item.id === current.id)
  ) {
    siblings.push(current)
  }

  if (siblings.length === 0) return []

  const asResults: TorrentResult[] = siblings.map((item) => ({
    title: item.title,
    uri: item.torrentUri!,
    kind: 'magnet',
    sizeBytes: 0,
    seeders: 0,
    sourceLabel: item.source || 'catalog',
  }))

  return buildEpisodeChoices(asResults, downlinkMbps, preferredQuality, {
    minDistinctEpisodes: options?.minDistinctEpisodes ?? 2,
  })
}

async function fetchText(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  // Prefer the browser-UA HTML fetch so torrent sites don't serve a block page
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url)
    return { ok: result.ok, content: result.content, error: result.error }
  }
  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(url)
    return { ok: result.ok, content: result.content, error: result.error }
  }
  try {
    const res = await fetch(url)
    const content = await res.text()
    return { ok: res.ok, content, error: res.ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, content: '', error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

export interface TorrentScrapeOutcome {
  results: TorrentResult[]
  links: TorrentPageLink[]
  pageTitle: string
  pageUrl: string
  nextPage: string | null
  prevPage: string | null
  /** URL template containing a query placeholder for site-wide search */
  searchTemplate: string | null
  error: string | null
}

const QUERY_TOKEN = '__JIYU_QUERY__'
const QUERY_PATH_TOKEN = '__JIYU_QUERY_PATH__'

/** Fill a search template with the user's query. */
export function buildSearchUrl(template: string, query: string): string {
  const q = query.trim()
  if (template.includes(QUERY_PATH_TOKEN)) {
    // Path-style routes (e.g. Torlock's /torrents/<slug>.html) use hyphens
    return template.replace(QUERY_PATH_TOKEN, encodeURIComponent(q.replace(/\s+/g, '-').toLowerCase()))
  }
  return template.replace(QUERY_TOKEN, encodeURIComponent(q))
}

/**
 * Work out how to search the whole site: a known route for sites we
 * recognize, otherwise the page's own search form (GET forms only).
 */
function findSearchTemplate(
  doc: Document,
  pageUrl: string,
  sourceLabel = '',
): string | null {
  let pageOrigin: string
  try {
    pageOrigin = new URL(pageUrl).origin
  } catch {
    return null
  }

  if (isTorlockUrl(pageUrl)) {
    const u = new URL('/torznab/api', pageOrigin)
    u.searchParams.set('t', 'search')
    u.searchParams.set('cat', String(TORLOCK_CAT.movies))
    u.searchParams.set('q', QUERY_TOKEN)
    u.searchParams.set('limit', String(TORLOCK_PAGE_SIZE))
    u.searchParams.set('offset', '0')
    return u.toString()
  }

  if (isYtsSource(pageUrl, sourceLabel)) {
    // HTML browse routes are Cloudflare-guarded; search via the open JSON API
    return ytsListApiUrl(pageOrigin, 1, QUERY_TOKEN)
  }

  for (const form of doc.querySelectorAll('form')) {
    const method = (form.getAttribute('method') || 'get').toLowerCase()
    if (method !== 'get') continue
    const input = form.querySelector(
      'input[type="search"], input[type="text"], input:not([type])',
    )
    const name = input?.getAttribute('name')
    if (!name) continue
    let action: URL
    try {
      action = new URL(form.getAttribute('action') || '', pageUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(action.protocol) || action.origin !== pageOrigin) continue
    const params = new URLSearchParams(action.search)
    for (const hidden of form.querySelectorAll('input[type="hidden"]')) {
      const hiddenName = hidden.getAttribute('name')
      if (hiddenName && hiddenName !== name) {
        params.set(hiddenName, hidden.getAttribute('value') ?? '')
      }
    }
    params.set(name, QUERY_TOKEN)
    action.search = params.toString()
    return action.toString()
  }
  return null
}

/** Find the site's own next/previous page links (pagination). */
function findPagination(
  doc: Document,
  pageUrl: string,
): { nextPage: string | null; prevPage: string | null } {
  const pageOrigin = new URL(pageUrl).origin
  const resolve = (raw: string | null | undefined): string | null => {
    if (!raw || raw.startsWith('#') || /^(?:javascript|magnet|mailto):/i.test(raw)) return null
    try {
      const url = new URL(raw, pageUrl)
      if (!/^https?:$/.test(url.protocol) || url.origin !== pageOrigin) return null
      return url.toString()
    } catch {
      return null
    }
  }

  const nextRe = /(?:^|\b)(?:next|older|more|»|›|→|>>)(?:\b|$)/i
  const prevRe = /(?:^|\b)(?:prev(?:ious)?|newer|«|‹|←|<<)(?:\b|$)/i

  let nextPage = resolve(doc.querySelector('link[rel~="next"], a[rel~="next"]')?.getAttribute('href'))
  let prevPage = resolve(doc.querySelector('link[rel~="prev"], a[rel~="prev"]')?.getAttribute('href'))

  if (!nextPage || !prevPage) {
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const label = `${anchor.textContent ?? ''} ${anchor.getAttribute('aria-label') ?? ''} ${
        anchor.getAttribute('title') ?? ''
      } ${anchor.className}`
      const href = anchor.getAttribute('href')
      if (!nextPage && nextRe.test(label)) nextPage = resolve(href)
      if (!prevPage && prevRe.test(label)) prevPage = resolve(href)
      if (nextPage && prevPage) break
    }
  }

  // Don't point back at the current page
  if (nextPage === pageUrl) nextPage = null
  if (prevPage === pageUrl) prevPage = null
  return { nextPage, prevPage }
}

/** SubsPlease is an anime-only source. */
export function isSubsPleaseUrl(pageUrl: string): boolean {
  try {
    return /(^|\.)subsplease\.org$/i.test(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

/** Full catalog listing (`/shows/`), not a single-show page. */
export function isSubsPleaseShowsListUrl(pageUrl: string): boolean {
  try {
    return isSubsPleaseUrl(pageUrl) && /^\/shows\/?$/i.test(new URL(pageUrl).pathname)
  } catch {
    return false
  }
}

/**
 * Homepage / latest feed — single-episode new releases (not `/shows/…` detail).
 */
export function isSubsPleaseLatestFeedUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    if (!isSubsPleaseUrl(pageUrl)) return false
    if (isSubsPleaseShowsListUrl(pageUrl)) return false
    if (/^\/shows\/[^/]+/i.test(url.pathname)) return false
    if (/\/api\/?/i.test(url.pathname) && /[?&]f=latest\b/i.test(url.search)) return true
    return url.pathname === '/' || url.pathname === ''
  } catch {
    return false
  }
}

export const ANIME_SHELF_NEW_RELEASES = 'new-releases'
export const ANIME_SHELF_FULL_SHOWS = 'full-shows'
/** EZTV Show List “Trending / Airing” (letter empty, status=landing). */
export const SERIES_SHELF_TRENDING = 'trending-airing'
/** YTS most-downloaded shelf. */
export const MOVIES_SHELF_POPULAR = 'popular-movies'
/** YTS recently uploaded (+ other untagged movie rows). */
export const MOVIES_SHELF_NEW = 'new-movies'

export function itemHasShelfTag(item: StreamItem, tag: string): boolean {
  return Boolean(item.tags?.some((t) => t.toLowerCase() === tag.toLowerCase()))
}

export function isAnimeNewReleaseItem(item: StreamItem): boolean {
  return itemHasShelfTag(item, ANIME_SHELF_NEW_RELEASES)
}

export function isAnimeFullShowItem(item: StreamItem): boolean {
  if (itemHasShelfTag(item, ANIME_SHELF_NEW_RELEASES)) return false
  if (itemHasShelfTag(item, ANIME_SHELF_FULL_SHOWS)) return true
  // Legacy SubsPlease / other torrent anime without a shelf tag → Full Shows.
  return item.category === 'anime' && (item.sourceKind === 'torrent' || item.transport === 'torrent')
}

export function isSeriesTrendingItem(item: StreamItem): boolean {
  return item.category === 'series' && itemHasShelfTag(item, SERIES_SHELF_TRENDING)
}

/** EZTV ALL-catalogue rows that are currently airing (summary from showlist). */
export function isSeriesAiringItem(item: StreamItem): boolean {
  return (
    item.category === 'series' &&
    (item.sourceKind === 'torrent' || item.transport === 'torrent') &&
    /\bAiring:/i.test(item.description || '')
  )
}

export function isSeriesFullShowItem(item: StreamItem): boolean {
  if (item.category !== 'series') return false
  if (itemHasShelfTag(item, ANIME_SHELF_FULL_SHOWS)) return true
  // Trending-only rows stay on the Trending tab until the ALL catalogue tags them.
  if (itemHasShelfTag(item, SERIES_SHELF_TRENDING)) return false
  // Legacy EZTV / other torrent series without a shelf tag → Full Shows.
  return item.sourceKind === 'torrent' || item.transport === 'torrent'
}

export function isMoviesPopularItem(item: StreamItem): boolean {
  return item.category === 'movies' && itemHasShelfTag(item, MOVIES_SHELF_POPULAR)
}

export function isMoviesNewItem(item: StreamItem): boolean {
  if (item.category !== 'movies') return false
  if (itemHasShelfTag(item, MOVIES_SHELF_NEW)) return true
  // Popular-only YTS rows stay on Popular; Torlock / IPTV / legacy → New Movies.
  if (itemHasShelfTag(item, MOVIES_SHELF_POPULAR)) return false
  return (
    item.sourceKind === 'torrent' ||
    item.transport === 'torrent' ||
    item.sourceKind === 'iptv' ||
    item.sourceKind === 'builtin'
  )
}

function subsPleaseShowSlug(show: string): string {
  return show
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function pickSubsPleaseDownload(
  downloads: SubsPleaseDownload[] | undefined,
): SubsPleaseDownload | null {
  const list = (downloads ?? []).filter((d) => /^magnet:\?/i.test(d.magnet))
  if (list.length === 0) return null
  const rank = (res: string) => {
    const n = Number(res) || 0
    if (n === 720) return 3
    if (n === 1080) return 2
    if (n === 480) return 1
    return 0
  }
  return [...list].sort((a, b) => rank(b.res) - rank(a.res))[0] ?? null
}

interface SubsPleaseDownload {
  res: string
  magnet: string
}

interface SubsPleaseRelease {
  release_date?: string
  show?: string
  episode?: string
  image_url?: string
  /** Show slug used on /shows/<page>/ when present */
  page?: string
  downloads?: SubsPleaseDownload[]
}

function emptyOutcome(pageUrl: string, sourceLabel: string, error: string): TorrentScrapeOutcome {
  return {
    results: [],
    links: [],
    pageTitle: sourceLabel,
    pageUrl,
    nextPage: null,
    prevPage: null,
    searchTemplate: null,
    error: `${sourceLabel}: ${error}`,
  }
}

function subsPleaseReleasesToResults(
  releases: SubsPleaseRelease[],
  sourceLabel: string,
): TorrentResult[] {
  const results: TorrentResult[] = []
  for (const release of releases) {
    const base = [release.show, release.episode ? `Episode ${release.episode}` : '']
      .filter(Boolean)
      .join(' · ')
    for (const download of release.downloads ?? []) {
      if (!/^magnet:\?/i.test(download.magnet)) continue
      const size = /[?&]xl=(\d+)/i.exec(download.magnet)?.[1]
      results.push({
        title: `${base} (${download.res}p)`,
        uri: download.magnet,
        kind: 'magnet',
        sizeBytes: Number(size) || 0,
        seeders: 0,
        sourceLabel,
      })
    }
  }
  return results
}

/**
 * Homepage “See more” uses `/api/?f=latest&p=N` (starts at p=1 after the
 * first 20). SubsPlease caps this around p=2 (~60 releases) then returns
 * `{ error: "limit_reached" }`.
 */
async function scrapeSubsPleaseLatest(
  origin: string,
  sourceLabel: string,
  pageUrl: string,
): Promise<TorrentScrapeOutcome> {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  let lastError = ''

  const pushRelease = (release: SubsPleaseRelease) => {
    if (!release?.show) return
    const episode = String(release.episode || '').trim()
    const dedupe = `${release.show.toLowerCase()}\0${episode.toLowerCase()}`
    if (seen.has(dedupe)) return
    const download = pickSubsPleaseDownload(release.downloads)
    if (!download) return
    seen.add(dedupe)
    const slug =
      (release.page && String(release.page).replace(/^\/+|\/+$/g, '')) ||
      subsPleaseShowSlug(release.show)
    if (!slug) return
    const showUrl = `${origin}/shows/${slug}`
    const isRange = /^\d+\s*-\s*\d+$/.test(episode)
    const title = episode
      ? `${release.show} · ${isRange ? 'Episodes' : 'Episode'} ${episode}`
      : release.show
    const releasedAt = release.release_date ? Date.parse(release.release_date) : undefined
    links.push({
      title,
      // Unique per episode so New Releases don't collapse onto one show id.
      url: `${showUrl}/#${encodeURIComponent(episode || 'latest')}`,
      summary: episode ? `New release · Episode ${episode}` : 'New release',
      poster: release.image_url
        ? new URL(release.image_url, origin).toString()
        : undefined,
      category: 'anime',
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
      torrentUri: download.magnet,
    })
  }

  // p=0 (or omitted) = first batch; p=1 / p=2 = See more pages.
  for (let page = 0; page <= 4; page += 1) {
    const apiUrl =
      page === 0
        ? `${origin}/api/?f=latest&tz=America%2FNew_York`
        : `${origin}/api/?f=latest&tz=America%2FNew_York&p=${page}`
    const latest = await fetchText(apiUrl)
    if (!latest.ok) {
      lastError = latest.error || 'latest releases could not load'
      if (links.length === 0) {
        return emptyOutcome(pageUrl, sourceLabel, lastError)
      }
      break
    }
    try {
      const payload = JSON.parse(latest.content) as
        | Record<string, SubsPleaseRelease>
        | { error?: string }
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const err = String((payload as { error?: string }).error || '')
        if (/limit_reached/i.test(err)) break
        lastError = err || 'latest API error'
        if (links.length === 0) {
          return emptyOutcome(pageUrl, sourceLabel, lastError)
        }
        break
      }
      const rows = Object.values(payload as Record<string, SubsPleaseRelease>)
      if (rows.length === 0) break
      const before = links.length
      for (const release of rows) pushRelease(release)
      // No new titles (duplicate page) — stop.
      if (links.length === before) break
    } catch {
      if (links.length === 0) {
        return emptyOutcome(pageUrl, sourceLabel, 'unexpected latest API response')
      }
      break
    }
  }

  links.sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0))
  return {
    results: [],
    links,
    pageTitle: `SubsPlease new releases (${links.length.toLocaleString()})`,
    pageUrl: origin + '/',
    nextPage: null,
    prevPage: null,
    searchTemplate: null,
    error: links.length === 0 ? `${sourceLabel}: no new releases found` : null,
  }
}

async function scrapeSubsPlease(pageUrl: string, sourceLabel: string): Promise<TorrentScrapeOutcome> {
  const url = new URL(pageUrl)

  // Homepage is JS-rendered — pull the same JSON the site uses for new releases.
  if (isSubsPleaseLatestFeedUrl(pageUrl)) {
    return scrapeSubsPleaseLatest(url.origin, sourceLabel, pageUrl)
  }

  const { ok, content, error } = await fetchText(pageUrl)
  if (!ok) return emptyOutcome(pageUrl, sourceLabel, error || 'could not load page')

  const doc = new DOMParser().parseFromString(content, 'text/html')
  const isShowList = /^\/shows\/?$/i.test(url.pathname)

  if (isShowList) {
    const imageByShow = new Map<string, string>()
    const latest = await fetchText(
      `${url.origin}/api/?f=latest&tz=America%2FNew_York`,
    )
    if (latest.ok) {
      try {
        const payload = JSON.parse(latest.content) as Record<string, SubsPleaseRelease>
        for (const release of Object.values(payload)) {
          if (!release.show || !release.image_url) continue
          imageByShow.set(
            release.show.toLowerCase(),
            new URL(release.image_url, url.origin).toString(),
          )
        }
      } catch {
        // The all-shows list still works if the optional image feed changes.
      }
    }
    const links: TorrentPageLink[] = []
    const seen = new Set<string>()
    for (const anchor of doc.querySelectorAll('a[href*="/shows/"]')) {
      let detail: URL
      try {
        detail = new URL(anchor.getAttribute('href') ?? '', pageUrl)
      } catch {
        continue
      }
      if (!/^\/shows\/[^/]+\/?$/i.test(detail.pathname)) continue
      const absolute = detail.toString().replace(/\/$/, '')
      if (seen.has(absolute)) continue
      const title = anchor.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      if (title.length < 2) continue
      seen.add(absolute)
      links.push({
        title,
        url: absolute,
        summary: 'Anime · 720p preferred',
        poster: imageByShow.get(title.toLowerCase()),
        category: 'anime',
      })
    }
    return {
      results: [],
      links,
      pageTitle: `All SubsPlease anime (${links.length.toLocaleString()})`,
      pageUrl,
      nextPage: null,
      prevPage: null,
      searchTemplate: null,
      error: links.length === 0 ? `${sourceLabel}: no anime titles found` : null,
    }
  }

  // A show detail page carries the numeric SID and its own poster. Resolve
  // all episodes through SubsPlease's JSON endpoint.
  const sid =
    doc.querySelector('[sid]')?.getAttribute('sid') ||
    /\bsid=["']?(\d+)/i.exec(content)?.[1] ||
    ''
  if (!sid) return emptyOutcome(pageUrl, sourceLabel, 'show identifier was not found')

  const apiUrl = `${url.origin}/api/?f=show&tz=America%2FNew_York&sid=${encodeURIComponent(sid)}`
  const api = await fetchText(apiUrl)
  if (!api.ok) return emptyOutcome(pageUrl, sourceLabel, api.error || 'show episodes could not load')

  try {
    const json = JSON.parse(api.content) as {
      batch?: Record<string, SubsPleaseRelease> | SubsPleaseRelease[]
      episode?: Record<string, SubsPleaseRelease> | SubsPleaseRelease[]
    }
    const values = (group: typeof json.batch): SubsPleaseRelease[] =>
      Array.isArray(group) ? group : group ? Object.values(group) : []
    const releases = [...values(json.episode), ...values(json.batch)]
    const results = subsPleaseReleasesToResults(releases, sourceLabel)
    return {
      results,
      links: [],
      pageTitle: doc.querySelector('h1')?.textContent?.trim() || sourceLabel,
      pageUrl,
      nextPage: null,
      prevPage: null,
      searchTemplate: null,
      error: results.length === 0 ? `${sourceLabel}: no episodes found` : null,
    }
  } catch {
    return emptyOutcome(pageUrl, sourceLabel, 'unexpected show API response')
  }
}

/**
 * YTS / YIFY HTML browse pages sit behind Cloudflare (403 "Just a moment..."),
 * but `/api/v2/list_movies.json` and `/api/v2/movie_details.json` stay open.
 * Every listing card points at the details API so quality picking still works.
 */
async function scrapeYtsPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let apiUrl: string
  let page = 1
  let query = ''
  let sortBy: YtsSortBy = 'date_added'

  try {
    const url = new URL(pageUrl)
    origin = url.origin
    sortBy = ytsSortFromUrl(pageUrl)
    if (isYtsApiUrl(pageUrl)) {
      apiUrl = pageUrl
      if (/list_movies\.json$/i.test(url.pathname)) {
        page = Math.max(1, Number(url.searchParams.get('page')) || 1)
        query = url.searchParams.get('query_term') || ''
      }
      if (/movie_details\.json$/i.test(url.pathname) && !url.searchParams.has('with_images')) {
        url.searchParams.set('with_images', 'true')
        apiUrl = url.toString()
      }
    } else if (/\/movies?\/[^/]+/i.test(url.pathname)) {
      const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '')
      query = slug.replace(/-/g, ' ')
      apiUrl = ytsListApiUrl(origin, 1, query, sortBy)
    } else {
      // Friendly /browse-movies URLs (and site roots) map back to the list API
      page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      query = url.searchParams.get('query') || url.searchParams.get('query_term') || ''
      apiUrl = ytsListApiUrl(origin, page, query || undefined, sortBy)
    }
  } catch {
    return emptyOutcome(pageUrl, sourceLabel, 'invalid YTS URL')
  }

  const failed = (error: string): TorrentScrapeOutcome => ({
    results: [],
    links: [],
    pageTitle: sourceLabel,
    pageUrl: apiUrl,
    nextPage: null,
    prevPage: null,
    searchTemplate: ytsListApiUrl(origin, 1, QUERY_TOKEN, sortBy),
    error: `${sourceLabel}: ${error}`,
  })

  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) return failed(fetchError || 'could not reach the YTS API')

  let movies: YtsApiMovie[] = []
  try {
    const json = JSON.parse(content) as {
      status?: string
      data?: { movies?: YtsApiMovie[]; movie?: YtsApiMovie; movie_count?: number }
    }
    if (json.data?.movie && json.data.movie.id) {
      movies = [json.data.movie]
    } else if (Array.isArray(json.data?.movies)) {
      movies = json.data.movies
    }
  } catch {
    return failed('unexpected response from the YTS API')
  }
  if (movies.length === 0) return failed('no movies returned')

  const results: TorrentResult[] = []
  const links: TorrentPageLink[] = []
  let isDetails = /movie_details\.json/i.test(apiUrl)

  // HTML /movies/<slug> lookups go through list_movies?query_term=… — if we
  // can pin a single title, treat it like a detail page (magnets only).
  if (!isDetails && query && movies.length >= 1) {
    const needle = query.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const exact = movies.find((movie) => {
      const slug = (movie.url || '').split('/').filter(Boolean).pop()?.toLowerCase() || ''
      const hay = `${movie.title || ''} ${movie.title_long || ''} ${slug}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
      return hay.includes(needle) || needle.includes(hay)
    })
    if (exact) {
      movies = [exact]
      isDetails = true
    }
  }

  let index = 0
  for (const movie of movies) {
    const movieId = Number(movie.id) || 0
    const title = ytsMovieTitle(movie)
    const { results: torrentResults, releasedAt } = ytsTorrentResults(movie, sourceLabel)

    // Detail pages expose quality magnets (same as opening a YTS movie HTML
    // page). Browse/search stays card-only like /browse-movies.
    if (isDetails) {
      results.push(...torrentResults)
      continue
    }
    if (!movieId) continue

    const overview = String(movie.summary || movie.description_full || '')
      .replace(/\s+/g, ' ')
      .trim()
    const shortOverview =
      overview.length > 220 ? `${overview.slice(0, 217).replace(/\s+\S*$/, '')}…` : overview
    const poster =
      movie.medium_cover_image || movie.large_cover_image || movie.small_cover_image || undefined
    // Preserve API list order for Popular (download_count); New uses upload time.
    const rankReleasedAt =
      sortBy === 'download_count' || sortBy === 'like_count'
        ? Date.now() - (page - 1) * 100_000 - index * 10
        : releasedAt
    index += 1
    links.push({
      title: title.slice(0, 180),
      // Details API — same click-to-play path as opening a YTS movie HTML page
      url: ytsDetailsApiUrl(origin, movieId),
      summary: shortOverview || (movie.year ? String(movie.year) : 'Movie'),
      poster,
      category: 'movies',
      releasedAt: rankReleasedAt,
      runtimeSeconds: ytsRuntimeSeconds(movie),
    })
  }

  const listPage = /list_movies\.json/i.test(apiUrl) ? page : 1
  const nextPage =
    !isDetails && movies.length >= YTS_PAGE_SIZE
      ? ytsListApiUrl(origin, listPage + 1, query || undefined, sortBy)
      : null
  const prevPage =
    !isDetails && listPage > 1
      ? ytsListApiUrl(origin, listPage - 1, query || undefined, sortBy)
      : null

  // Show familiar site URLs in the UI (API URLs still power next/prev/search).
  let displayUrl = apiUrl
  if (!isDetails) {
    displayUrl = `${origin}/browse-movies`
    if (query) displayUrl = `${origin}/browse-movies?query=${encodeURIComponent(query)}`
    if (listPage > 1) {
      displayUrl += `${displayUrl.includes('?') ? '&' : '?'}page=${listPage}`
    }
  } else if (movies[0]?.url) {
    displayUrl = movies[0].url
  }

  const listLabel =
    sortBy === 'download_count'
      ? 'popular movies'
      : sortBy === 'date_added'
        ? 'new movies'
        : 'movies'

  return {
    results,
    links,
    pageTitle: query
      ? `${sourceLabel} — “${query}”`
      : isDetails
        ? ytsMovieTitle(movies[0])
        : `${sourceLabel} — ${listLabel} (page ${listPage})`,
    pageUrl: displayUrl,
    nextPage,
    prevPage,
    searchTemplate: ytsListApiUrl(origin, 1, QUERY_TOKEN, sortBy),
    error:
      results.length === 0 && links.length === 0
        ? `${sourceLabel}: no playable torrents found`
        : null,
  }
}

/** EZTV and its mirrors (eztvx.to, eztv.re, eztv1.xyz, …) — TV shows only. */
export function isEztvUrl(pageUrl: string): boolean {
  try {
    return isEztvHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

export function isEztvHost(hostname: string): boolean {
  return /(^|\.)eztv[a-z0-9]*\.[a-z.]+$/i.test(hostname.replace(/^www\./i, ''))
}

/** True when the saved website label is an EZTV mirror (e.g. "eztvx.to"). */
export function isEztvLabel(label: string): boolean {
  return /\beztv/i.test(label.trim())
}

/** Host or label identifies EZTV — always shelve under TV Series. */
export function isEztvSource(pageUrl: string, sourceLabel = ''): boolean {
  return isEztvUrl(pageUrl) || isEztvLabel(sourceLabel)
}

const EZTV_PAGE_SIZE = 100
/** Show List ALL catalogue — ~100 shows per AJAX page. */
/** Show List ALL ≈ ~100 shows/page; ~200+ pages for the full catalogue. */
/** Curated Full Shows shelf: TMDB popular TV (2010+) present on EZTV. */
export const EZTV_TMDB_POPULAR_LIMIT = 3000
/** Now Airing shelf: TMDB on_the_air present on EZTV. */
export const EZTV_TMDB_AIRING_LIMIT = 500
const EZTV_TMDB_POPULAR_FEED_PREFIX = 'jiyu://eztv-tmdb-popular'
const EZTV_TMDB_AIRING_FEED_PREFIX = 'jiyu://eztv-tmdb-airing'

function eztvApiUrl(origin: string, page: number, imdbId?: string): string {
  const base = `${origin}/api/get-torrents?limit=${EZTV_PAGE_SIZE}&page=${page}`
  return imdbId ? `${base}&imdb_id=${encodeURIComponent(imdbId)}` : base
}

export function isEztvApiUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    return isEztvHost(url.hostname) && /\/api\/get-torrents/i.test(url.pathname)
  } catch {
    return false
  }
}

/**
 * EZTV Show List AJAX.
 * - Trending / Airing (site default): letter empty + status=landing
 * - Full ALL catalogue: letter=all + status=all
 */
function eztvShowlistAjaxUrl(
  origin: string,
  page: number,
  options?: { letter?: string; status?: string },
): string {
  const letter = options?.letter ?? 'all'
  const status = options?.status ?? 'all'
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('letter', letter)
  params.set('status', status)
  return `${origin}/showlist/ajax/?${params.toString()}`
}

export function eztvTmdbPopularFeedUrl(origin: string): string {
  return `${EZTV_TMDB_POPULAR_FEED_PREFIX}?origin=${encodeURIComponent(origin)}`
}

export function eztvTmdbAiringFeedUrl(origin: string): string {
  return `${EZTV_TMDB_AIRING_FEED_PREFIX}?origin=${encodeURIComponent(origin)}`
}

export function isEztvTmdbPopularFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(EZTV_TMDB_POPULAR_FEED_PREFIX)
}

export function isEztvTmdbAiringFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(EZTV_TMDB_AIRING_FEED_PREFIX)
}

export function isEztvTmdbFeedUrl(pageUrl: string): boolean {
  return isEztvTmdbPopularFeedUrl(pageUrl) || isEztvTmdbAiringFeedUrl(pageUrl)
}

export type EztvTmdbFeedKind = 'popular' | 'on_the_air'

async function mapPoolLimited<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await fn(items[index]!, index)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/**
 * Canonicalize EZTV show-page cards onto get-torrents?imdb_id= URLs so they
 * merge with the TMDB Full Shows shelf (same stable catalog id).
 */
async function canonicalizeEztvLinksToImdbApi(
  origin: string,
  links: TorrentPageLink[],
): Promise<TorrentPageLink[]> {
  return mapPoolLimited(links, 4, async (link) => {
    if (isEztvApiUrl(link.url) && new URL(link.url).searchParams.get('imdb_id')) {
      return link
    }
    const hit = await resolveTvMazeShow(link.title)
    if (!hit) return link
    return {
      ...link,
      url: eztvApiUrl(origin, 1, hit.imdbDigits),
      poster: link.poster || hit.poster,
    }
  })
}

/**
 * TMDB TV list → keep titles that exist on EZTV (open API).
 * No Cloudflare / Show List / system browser.
 */
export async function scrapeEztvTmdbFeed(
  origin: string,
  sourceLabel: string,
  kind: EztvTmdbFeedKind,
  onProgress?: (
    done: number,
    total: number,
    matched: number,
    phase?: 'tmdb' | 'probe',
  ) => void,
): Promise<TorrentScrapeOutcome> {
  const limit = kind === 'on_the_air' ? EZTV_TMDB_AIRING_LIMIT : EZTV_TMDB_POPULAR_LIMIT
  const catalog = window.signalDesktop?.tmdbTvCatalog
  const legacy = window.signalDesktop?.tmdbPopularTv
  if (!catalog && !(kind === 'popular' && legacy)) {
    return eztvFailed(sourceLabel, origin, 'TMDB sync needs the Jiyu desktop app')
  }
  onProgress?.(0, limit, 0, 'tmdb')
  const stopTmdbProgress = window.signalDesktop?.onTmdbProgress?.((p) => {
    if (p.phase === 'discover') {
      onProgress?.(p.done, p.total || limit, 0, 'tmdb')
    } else if (p.phase === 'ids' || p.phase === 'done') {
      onProgress?.(p.done, p.total || limit, 0, 'tmdb')
    }
  })
  let tmdb: Awaited<ReturnType<NonNullable<typeof catalog>>>
  try {
    tmdb = catalog ? await catalog(kind, limit) : await legacy!(limit)
  } finally {
    stopTmdbProgress?.()
  }
  if (!tmdb.ok) {
    return eztvFailed(sourceLabel, origin, tmdb.error || 'TMDB catalog failed')
  }
  const candidates = (tmdb.shows || []).filter((s) => s.imdbId && s.name.trim())
  if (candidates.length === 0) {
    return eztvFailed(sourceLabel, origin, 'TMDB returned no shows with IMDb ids')
  }

  let matchedCount = 0
  let done = 0
  onProgress?.(0, candidates.length, 0, 'probe')
  const matched = await mapPoolLimited(candidates, 5, async (show, index) => {
    const apiUrl = eztvApiUrl(origin, 1, show.imdbId)
    const api = await fetchText(apiUrl)
    done += 1
    if (!api.ok) {
      onProgress?.(done, candidates.length, matchedCount, 'probe')
      return null
    }
    let torrents: EztvApiTorrent[] = []
    let torrentsCount = 0
    try {
      const json = JSON.parse(api.content) as {
        torrents?: EztvApiTorrent[]
        torrents_count?: number
      }
      torrents = Array.isArray(json.torrents) ? json.torrents : []
      torrentsCount = Number(json.torrents_count) || torrents.length
    } catch {
      onProgress?.(done, candidates.length, matchedCount, 'probe')
      return null
    }
    if (torrents.length === 0 && torrentsCount <= 0) {
      onProgress?.(done, candidates.length, matchedCount, 'probe')
      return null
    }
    matchedCount += 1
    onProgress?.(done, candidates.length, matchedCount, 'probe')
    const sample = torrents[0]
    const screenshot = sample?.small_screenshot || sample?.large_screenshot || ''
    const eztvPoster = screenshot
      ? screenshot.startsWith('//')
        ? `https:${screenshot}`
        : screenshot
      : undefined
    const overview = (show.overview || '').replace(/\s+/g, ' ').trim()
    const shortOverview =
      overview.length > 220 ? `${overview.slice(0, 217).replace(/\s+\S*$/, '')}…` : overview
    // Preserve TMDB list order for Now Airing; Full Shows prefer release/torrent time.
    const releasedAt =
      kind === 'on_the_air'
        ? Date.now() - index * 10
        : sample?.date_released_unix
          ? sample.date_released_unix * 1000
          : show.firstAirDate
            ? Date.parse(show.firstAirDate) || undefined
            : undefined
    const link: TorrentPageLink = {
      title: show.name.slice(0, 180),
      url: apiUrl,
      summary: shortOverview,
      poster: show.poster || eztvPoster,
      category: 'series',
      releasedAt,
    }
    return link
  })

  const links = matched.filter((row): row is TorrentPageLink => Boolean(row))
  const label = kind === 'on_the_air' ? 'on the air' : 'popular'
  return {
    results: [],
    links,
    pageTitle: `${sourceLabel} — TMDB ${label} on EZTV (${links.length.toLocaleString()})`,
    pageUrl:
      kind === 'on_the_air' ? eztvTmdbAiringFeedUrl(origin) : eztvTmdbPopularFeedUrl(origin),
    nextPage: null,
    prevPage: null,
    searchTemplate: null,
    error:
      links.length === 0
        ? `${sourceLabel}: none of the TMDB ${label} shows are on EZTV`
        : null,
  }
}

/** @deprecated use scrapeEztvTmdbFeed(..., 'popular') */
export async function scrapeEztvTmdbPopularFeed(
  origin: string,
  sourceLabel: string,
  onProgress?: (done: number, total: number, matched: number) => void,
): Promise<TorrentScrapeOutcome> {
  return scrapeEztvTmdbFeed(origin, sourceLabel, 'popular', onProgress)
}

export function isEztvShowUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    return isEztvHost(url.hostname) && /\/shows\/\d+/i.test(url.pathname)
  } catch {
    return false
  }
}

export function isEztvShowlistUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    return isEztvHost(url.hostname) && /\/showlist\b/i.test(url.pathname)
  } catch {
    return false
  }
}

interface EztvApiTorrent {
  id: number
  hash: string
  title: string
  magnet_url: string
  season: string
  episode: string
  small_screenshot: string
  large_screenshot: string
  seeds: number
  peers: number
  date_released_unix: number
  size_bytes: string
  imdb_id?: string
}

interface EztvShowlistShow {
  title_id: number | string
  title_seo: string
  title: string
  title_list: string
  thumb_small?: string
  poster?: string
  air_status?: string
  air_days?: string
  rating?: string
  num_votes?: string
}

function eztvPosterUrl(origin: string, show: EztvShowlistShow): string | undefined {
  const thumb = (show.thumb_small || '').trim()
  if (thumb) {
    if (thumb.startsWith('//')) return `https:${thumb}`
    if (/^https?:\/\//i.test(thumb)) return thumb
    return `${origin}${thumb.startsWith('/') ? '' : '/'}${thumb}`
  }
  const poster = (show.poster || '').trim()
  if (!poster) return undefined
  if (poster.startsWith('//')) return `https:${poster}`
  if (/^https?:\/\//i.test(poster)) return poster
  // Site serves catalogue art under /ezimg/thumbs/<file>
  return `${origin}/ezimg/thumbs/${poster.replace(/^\/+/, '')}`
}

function eztvFailed(
  sourceLabel: string,
  pageUrl: string,
  error: string,
  prevPage: string | null = null,
): TorrentScrapeOutcome {
  return {
    results: [],
    links: [],
    pageTitle: sourceLabel,
    pageUrl,
    nextPage: null,
    prevPage,
    searchTemplate: null,
    error: `${sourceLabel}: ${error}`,
  }
}

function mapEztvTorrents(
  torrents: EztvApiTorrent[],
  sourceLabel: string,
): { results: TorrentResult[]; links: TorrentPageLink[] } {
  const results: TorrentResult[] = []
  const links: TorrentPageLink[] = []
  for (const t of torrents) {
    if (!t.magnet_url || !/^magnet:\?/i.test(t.magnet_url)) continue
    const title = (t.title || '').replace(/\s*(?:\[eztv\]|EZTV)\s*$/i, '').trim()
    if (!title) continue
    const sizeBytes = Number(t.size_bytes) || 0
    const seeders = Number(t.seeds) || 0
    const releasedAt = t.date_released_unix ? t.date_released_unix * 1000 : undefined
    const screenshot = t.small_screenshot || t.large_screenshot || ''
    const poster = screenshot
      ? screenshot.startsWith('//')
        ? `https:${screenshot}`
        : screenshot
      : undefined
    const season = Number(t.season) || 0
    const episode = Number(t.episode) || 0
    const epTag =
      season > 0 && episode > 0
        ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : ''
    const summary = [epTag, formatSize(sizeBytes), seeders > 0 ? `${seeders} seeds` : '']
      .filter(Boolean)
      .join(' · ')

    results.push({ title, uri: t.magnet_url, kind: 'magnet', sizeBytes, seeders, sourceLabel })
    links.push({
      title: title.slice(0, 180),
      url: t.magnet_url,
      summary,
      poster,
      category: 'series',
      releasedAt,
      torrentUri: t.magnet_url,
    })
  }
  return { results, links }
}

/**
 * EZTV Show List ALL catalogue via /showlist/ajax/ (letter=all&status=all).
 * Each card is a show; magnets resolve at play time from the show page → IMDb API.
 */
async function scrapeEztvShowlistPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let page = 1
  let letter = 'all'
  let status = 'all'
  try {
    const url = new URL(pageUrl)
    origin = url.origin
    page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    if (url.searchParams.has('letter')) letter = url.searchParams.get('letter') ?? ''
    if (url.searchParams.has('status')) status = url.searchParams.get('status') || 'all'
  } catch {
    return eztvFailed(sourceLabel, pageUrl, 'invalid show list URL')
  }
  const apiUrl = eztvShowlistAjaxUrl(origin, page, { letter, status })
  const isTrending = letter === '' && status === 'landing'

  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) return eztvFailed(sourceLabel, apiUrl, fetchError || 'could not reach EZTV show list')

  let shows: EztvShowlistShow[]
  let hasMore = false
  try {
    const json = JSON.parse(content) as { shows?: EztvShowlistShow[]; has_more?: boolean }
    shows = Array.isArray(json.shows) ? json.shows : []
    hasMore = Boolean(json.has_more)
  } catch {
    return eztvFailed(sourceLabel, apiUrl, 'unexpected response from EZTV show list')
  }
  if (shows.length === 0 && page === 1) {
    return eztvFailed(sourceLabel, apiUrl, 'no shows returned')
  }

  const links: TorrentPageLink[] = []
  let index = 0
  for (const show of shows) {
    const id = String(show.title_id || '').trim()
    const seo = String(show.title_seo || '').trim()
    const title = (show.title_list || show.title || '').trim()
    if (!id || !title) continue
    const showPath = seo ? `/shows/${id}/${seo}/` : `/shows/${id}/`
    const airStatus = (show.air_status || '').trim()
    const days = (show.air_days || '').trim()
    const rating = (show.rating || '').trim()
    const summary = [
      isTrending ? 'Trending / Airing' : '',
      airStatus === 'airing' && days ? `Airing: ${days}` : airStatus ? airStatus : '',
      rating ? `${rating}★` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    // Preserve EZTV trending rank via releasedAt (page 1 first).
    const releasedAt = isTrending
      ? Date.now() - (page - 1) * 100_000 - index * 10
      : undefined
    index += 1
    links.push({
      title: title.slice(0, 180),
      url: `${origin}${showPath}`,
      summary,
      poster: eztvPosterUrl(origin, show),
      category: 'series',
      releasedAt,
    })
  }

  const listLabel = isTrending ? 'trending / airing' : 'all shows'
  // Point Trending cards at imdb API URLs so they share ids with the TMDB shelf.
  const finalLinks = isTrending
    ? await canonicalizeEztvLinksToImdbApi(origin, links)
    : links
  return {
    results: [],
    links: finalLinks,
    pageTitle: `${sourceLabel} — ${listLabel} (page ${page})`,
    pageUrl: apiUrl,
    nextPage: hasMore ? eztvShowlistAjaxUrl(origin, page + 1, { letter, status }) : null,
    prevPage: page > 1 ? eztvShowlistAjaxUrl(origin, page - 1, { letter, status }) : null,
    searchTemplate: null,
    error: finalLinks.length === 0 ? `${sourceLabel}: no shows found` : null,
  }
}

/** True when release titles look like they belong to this show (not a wrong IMDb). */
function eztvTorrentsMatchShow(torrents: EztvApiTorrent[], showTitle: string): boolean {
  const showKey = normalizeShowKey(showTitle)
  if (showKey.length < 3 || torrents.length === 0) return false
  const sample = torrents.slice(0, 20)
  let hits = 0
  for (const t of sample) {
    const releaseKey = normalizeShowKey(t.title || '')
    if (!releaseKey) continue
    if (
      releaseKey === showKey ||
      releaseKey.startsWith(`${showKey} `) ||
      releaseKey.includes(` ${showKey} `)
    ) {
      hits += 1
    }
  }
  // Require a clear majority — wrong IMDb pages return a fully unrelated set.
  return hits >= Math.max(1, Math.ceil(sample.length * 0.5))
}

function extractEztvImdbCandidates(html: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (digits: string) => {
    const id = digits.replace(/^tt/i, '')
    if (!/^\d{5,8}$/.test(id) || seen.has(id)) return
    seen.add(id)
    found.push(id)
  }
  // Prefer explicit imdb.com title links / imdb_id fields — never bare tt######
  // (show pages embed unrelated IDs that used to steal the episode list).
  const linkRe = /imdb\.com\/title\/tt(\d+)/gi
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(html)) !== null) push(match[1])
  const fieldRe = /["']imdb_id["']\s*:\s*["']?(\d+)/gi
  while ((match = fieldRe.exec(html)) !== null) push(match[1])
  return found
}

async function fetchEztvTorrentsForImdb(
  origin: string,
  imdbId: string,
): Promise<EztvApiTorrent[]> {
  const allTorrents: EztvApiTorrent[] = []
  for (let page = 1; page <= 40; page++) {
    const apiUrl = eztvApiUrl(origin, page, imdbId)
    const api = await fetchText(apiUrl)
    if (!api.ok) {
      if (page === 1) return []
      break
    }
    let torrents: EztvApiTorrent[]
    try {
      const json = JSON.parse(api.content) as { torrents?: EztvApiTorrent[] }
      torrents = Array.isArray(json.torrents) ? json.torrents : []
    } catch {
      if (page === 1) return []
      break
    }
    if (torrents.length === 0) break
    allTorrents.push(...torrents)
    if (torrents.length < EZTV_PAGE_SIZE) break
  }
  return allTorrents
}

/**
 * Show detail: read IMDb id from the show page, then pull magnets from the
 * open get-torrents API (HTML magnet buttons are JS/Cloudflare-guarded).
 */
async function resolveImdbIdFromTitle(title: string): Promise<string> {
  const q = title.trim()
  if (!q) return ''
  const want = normalizeShowKey(q)
  try {
    const single = await fetch(
      `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(q)}`,
    )
    if (single.ok) {
      const json = (await single.json()) as {
        name?: string
        externals?: { imdb?: string | null }
      }
      const nameKey = normalizeShowKey(json.name || '')
      const imdb = (json.externals?.imdb || '').replace(/^tt/i, '')
      if (/^\d+$/.test(imdb) && (nameKey === want || nameKey.includes(want) || want.includes(nameKey))) {
        return imdb
      }
    }
    const search = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`,
    )
    if (!search.ok) return ''
    const rows = (await search.json()) as Array<{
      show?: { name?: string; externals?: { imdb?: string | null } }
    }>
    for (const row of rows) {
      const nameKey = normalizeShowKey(row.show?.name || '')
      const imdb = (row.show?.externals?.imdb || '').replace(/^tt/i, '')
      if (!/^\d+$/.test(imdb) || !nameKey) continue
      if (nameKey === want || nameKey.startsWith(want) || want.startsWith(nameKey)) return imdb
    }
    return ''
  } catch {
    return ''
  }
}

type TvMazeShowHit = {
  name: string
  imdbDigits: string
  poster?: string
}

async function resolveTvMazeShow(title: string): Promise<TvMazeShowHit | null> {
  const q = title.trim()
  if (!q) return null
  const want = normalizeShowKey(q)
  const fromJson = (json: {
    name?: string
    externals?: { imdb?: string | null }
    image?: { medium?: string | null; original?: string | null } | null
  }): TvMazeShowHit | null => {
    const imdb = (json.externals?.imdb || '').replace(/^tt/i, '')
    if (!/^\d+$/.test(imdb)) return null
    return {
      name: (json.name || q).trim(),
      imdbDigits: imdb,
      poster: json.image?.medium || json.image?.original || undefined,
    }
  }
  try {
    const response = await fetch(
      `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(q)}`,
    )
    if (response.ok) {
      const hit = fromJson(
        (await response.json()) as {
          name?: string
          externals?: { imdb?: string | null }
          image?: { medium?: string | null; original?: string | null } | null
        },
      )
      if (hit) return hit
    }
    // singlesearch 404s on some catalogue titles; search is more forgiving.
    const search = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`,
    )
    if (!search.ok) return null
    const rows = (await search.json()) as Array<{
      show?: {
        name?: string
        externals?: { imdb?: string | null }
        image?: { medium?: string | null; original?: string | null } | null
      }
    }>
    for (const row of rows) {
      if (!row.show) continue
      const nameKey = normalizeShowKey(row.show.name || '')
      if (
        !nameKey ||
        !(nameKey === want || nameKey.startsWith(want) || want.startsWith(nameKey) || nameKey.includes(want) || want.includes(nameKey))
      ) {
        continue
      }
      const hit = fromJson(row.show)
      if (hit) return hit
    }
    return null
  } catch {
    return null
  }
}

/**
 * Catalog title → TVMaze IMDb → EZTV get-torrents (no Cloudflare).
 * Prefer this over /shows/… HTML, which is challenge-gated and whose SEO slug
 * often fails the stricter IMDb title match.
 */
async function resolveEztvEpisodesByTitle(
  title: string,
  origin: string,
  sourceLabel: string,
): Promise<TorrentResult[]> {
  const cleaned = cleanShowDisplayTitle(title) || title.trim()
  if (!cleaned) return []

  const hit = await resolveTvMazeShow(cleaned)
  if (!hit) {
    // singlesearch can miss; try the looser search helper
    const imdb = await resolveImdbIdFromTitle(cleaned)
    if (!imdb) return []
    const torrents = await fetchEztvTorrentsForImdb(origin, imdb)
    if (torrents.length === 0) return []
    if (!eztvTorrentsMatchShow(torrents, cleaned)) return []
    return mapEztvTorrents(torrents, sourceLabel).results
  }

  const torrents = await fetchEztvTorrentsForImdb(origin, hit.imdbDigits)
  if (torrents.length === 0) return []

  // TVMaze singlesearch already picked a show for this title — accept unless
  // the EZTV IMDb bucket is clearly a different series.
  const matched =
    eztvTorrentsMatchShow(torrents, cleaned) ||
    eztvTorrentsMatchShow(torrents, hit.name) ||
    eztvTorrentsLooselyMatch(torrents, cleaned) ||
    eztvTorrentsLooselyMatch(torrents, hit.name)
  if (!matched) return []

  return mapEztvTorrents(torrents, sourceLabel).results
}

/** Token overlap fallback when punctuation/ampersands break exact show-key match. */
function eztvTorrentsLooselyMatch(torrents: EztvApiTorrent[], showTitle: string): boolean {
  const tokens = normalizeShowKey(showTitle)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^(the|and|with|for|season|series)$/i.test(t))
  if (tokens.length === 0) return false
  const sample = torrents.slice(0, 15)
  let hits = 0
  for (const t of sample) {
    const releaseKey = normalizeShowKey(t.title || '')
    const matchedTokens = tokens.filter((tok) => releaseKey.includes(tok)).length
    if (matchedTokens >= Math.min(tokens.length, Math.max(2, Math.ceil(tokens.length * 0.6)))) {
      hits += 1
    }
  }
  return hits >= Math.max(1, Math.ceil(sample.length * 0.4))
}

/**
 * Find a show that isn't on the recent-API shelf yet (e.g. Devious Maids) via
 * TVMaze → EZTV public API. No Cloudflare / Show List required.
 */
export async function lookupEztvShowCard(
  query: string,
  source: TorrentSource,
): Promise<TorrentPageLink | null> {
  if (!isEztvSource(source.url, source.label)) return null
  const hit = await resolveTvMazeShow(query)
  if (!hit) return null
  let origin: string
  try {
    origin = new URL(source.url).origin
  } catch {
    return null
  }
  const apiUrl = eztvApiUrl(origin, 1, hit.imdbDigits)
  const api = await fetchText(apiUrl)
  if (!api.ok) return null
  let torrents: EztvApiTorrent[] = []
  try {
    const json = JSON.parse(api.content) as { torrents?: EztvApiTorrent[]; torrents_count?: number }
    torrents = Array.isArray(json.torrents) ? json.torrents : []
    if (torrents.length === 0 && !(json.torrents_count && json.torrents_count > 0)) {
      return null
    }
  } catch {
    return null
  }
  const sample = torrents[0]
  const screenshot = sample?.small_screenshot || sample?.large_screenshot || ''
  const poster = hit.poster
    ? hit.poster
    : screenshot
      ? screenshot.startsWith('//')
        ? `https:${screenshot}`
        : screenshot
      : undefined
  return {
    title: hit.name.slice(0, 180),
    url: apiUrl,
    summary: 'TV series',
    poster,
    category: 'series',
    releasedAt: sample?.date_released_unix ? sample.date_released_unix * 1000 : undefined,
  }
}

async function scrapeEztvShowDetail(
  pageUrl: string,
  sourceLabel: string,
  hintTitle = '',
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let showTitle = ''
  try {
    const url = new URL(pageUrl)
    origin = url.origin
    const slug = url.pathname.split('/').filter(Boolean).pop() || ''
    showTitle = decodeURIComponent(slug).replace(/-/g, ' ').trim()
  } catch {
    return eztvFailed(sourceLabel, pageUrl, 'invalid show URL')
  }
  if (hintTitle.trim()) showTitle = cleanShowDisplayTitle(hintTitle) || hintTitle.trim()

  const triedIds = new Set<string>()
  const tryImdbIds = async (ids: string[]): Promise<EztvApiTorrent[]> => {
    for (const imdbId of ids) {
      if (!imdbId || triedIds.has(imdbId)) continue
      triedIds.add(imdbId)
      const torrents = await fetchEztvTorrentsForImdb(origin, imdbId)
      if (torrents.length === 0) continue
      if (
        !eztvTorrentsMatchShow(torrents, showTitle) &&
        !eztvTorrentsLooselyMatch(torrents, showTitle)
      ) {
        continue
      }
      return torrents
    }
    return []
  }

  // Prefer TVMaze → open get-torrents API (no Cloudflare / Chrome unlock).
  // Show HTML is CF-guarded and only used as a fallback for magnets / IMDb ids.
  const tvmaze = showTitle ? await resolveTvMazeShow(showTitle) : null
  let allTorrents = tvmaze
    ? await tryImdbIds([tvmaze.imdbDigits])
    : showTitle
      ? await tryImdbIds([await resolveImdbIdFromTitle(showTitle)])
      : []

  if (allTorrents.length > 0) {
    const { results, links } = mapEztvTorrents(allTorrents, sourceLabel)
    return {
      results,
      links,
      pageTitle: sourceLabel,
      pageUrl,
      nextPage: null,
      prevPage: null,
      searchTemplate: null,
      error: results.length === 0 ? `${sourceLabel}: no playable torrents for this show` : null,
    }
  }

  const page = await fetchText(pageUrl)
  if (page.ok) {
    const heading =
      page.content.match(/<h1[^>]*>([^<]+)/i)?.[1] ||
      page.content.match(/<title>([^|<]+)/i)?.[1] ||
      ''
    if (heading.trim()) showTitle = heading.replace(/\s*Torrent Download.*$/i, '').trim()
  }

  const showKey = normalizeShowKey(showTitle)

  // Show-page magnets. EZTV’s get-torrents API often returns a completely
  // different series for the IMDb id glued to the page.
  if (page.ok) {
    const fromHtml = scrapeTorrentLinks(page.content, sourceLabel, pageUrl)
    const matched = fromHtml.filter((r) => {
      const key = normalizeShowKey(r.title)
      return (
        key === showKey ||
        key.startsWith(`${showKey} `) ||
        (showKey.length >= 6 && key.includes(showKey))
      )
    })
    if (matched.length > 0) {
      return {
        results: matched,
        links: matched.map((r) => ({
          title: r.title.slice(0, 180),
          url: r.uri,
          summary: '',
          category: 'series' as const,
          torrentUri: r.uri,
        })),
        pageTitle: sourceLabel,
        pageUrl,
        nextPage: null,
        prevPage: null,
        searchTemplate: null,
        error: null,
      }
    }
    allTorrents = await tryImdbIds(extractEztvImdbCandidates(page.content))
  }

  if (allTorrents.length === 0) {
    return eztvFailed(
      sourceLabel,
      pageUrl,
      page.ok
        ? 'no matching torrents for this title (EZTV’s listing looks mislinked)'
        : page.error ||
            'no matching torrents for this title (EZTV’s listing looks mislinked)',
    )
  }

  const { results, links } = mapEztvTorrents(allTorrents, sourceLabel)
  return {
    results,
    links,
    pageTitle: sourceLabel,
    pageUrl,
    nextPage: null,
    prevPage: null,
    searchTemplate: null,
    error: results.length === 0 ? `${sourceLabel}: no playable torrents for this show` : null,
  }
}

/**
 * Latest-episode / per-show feed (open JSON API). Preserves imdb_id when present
 * so show cards opened from the shelf resolve the full episode list.
 */
async function scrapeEztvLatestPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let page = 1
  let imdbId: string | undefined
  try {
    const url = new URL(pageUrl)
    origin = url.origin
    if (/\/api\/get-torrents/i.test(url.pathname)) {
      page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const raw = (url.searchParams.get('imdb_id') || '').replace(/^tt/i, '')
      imdbId = /^\d+$/.test(raw) ? raw : undefined
    }
  } catch {
    origin = pageUrl
  }
  const apiUrl = eztvApiUrl(origin, page, imdbId)

  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) {
    return eztvFailed(
      sourceLabel,
      apiUrl,
      fetchError || 'could not reach the EZTV API',
      page > 1 ? eztvApiUrl(origin, page - 1, imdbId) : null,
    )
  }

  let torrents: EztvApiTorrent[]
  try {
    const json = JSON.parse(content) as { torrents?: EztvApiTorrent[] }
    torrents = Array.isArray(json.torrents) ? json.torrents : []
  } catch {
    return eztvFailed(sourceLabel, apiUrl, 'unexpected response from the EZTV API')
  }
  if (torrents.length === 0) return eztvFailed(sourceLabel, apiUrl, 'no torrents returned')

  const { results, links } = mapEztvTorrents(torrents, sourceLabel)
  return {
    results,
    links,
    pageTitle: `${sourceLabel} — ${imdbId ? 'show episodes' : 'latest episodes'} (page ${page})`,
    pageUrl: apiUrl,
    nextPage: torrents.length >= EZTV_PAGE_SIZE ? eztvApiUrl(origin, page + 1, imdbId) : null,
    prevPage: page > 1 ? eztvApiUrl(origin, page - 1, imdbId) : null,
    searchTemplate: null,
    error: links.length === 0 ? `${sourceLabel}: no playable torrents found` : null,
  }
}

/**
 * Build one shelf card per IMDb show from a get-torrents page (no Cloudflare).
 */
async function scrapeEztvApiShowIndexPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let page = 1
  try {
    const url = new URL(pageUrl)
    origin = url.origin
    page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  } catch {
    return eztvFailed(sourceLabel, pageUrl, 'invalid EZTV API URL')
  }

  const apiUrl = eztvApiUrl(origin, page)
  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) {
    return eztvFailed(sourceLabel, apiUrl, fetchError || 'could not reach the EZTV API')
  }

  let torrents: EztvApiTorrent[]
  try {
    const json = JSON.parse(content) as { torrents?: EztvApiTorrent[] }
    torrents = Array.isArray(json.torrents) ? json.torrents : []
  } catch {
    return eztvFailed(sourceLabel, apiUrl, 'unexpected response from the EZTV API')
  }
  if (torrents.length === 0 && page === 1) {
    return eztvFailed(sourceLabel, apiUrl, 'no torrents returned')
  }

  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  for (const t of torrents) {
    const imdb = String(t.imdb_id || '')
      .replace(/^tt/i, '')
      .trim()
    if (!/^\d+$/.test(imdb) || seen.has(imdb)) continue
    seen.add(imdb)
    const title = cleanShowDisplayTitle(t.title || '').slice(0, 180)
    if (!title) continue
    const screenshot = t.small_screenshot || t.large_screenshot || ''
    const poster = screenshot
      ? screenshot.startsWith('//')
        ? `https:${screenshot}`
        : screenshot
      : undefined
    links.push({
      title,
      url: eztvApiUrl(origin, 1, imdb),
      summary: 'TV series',
      poster,
      category: 'series',
      releasedAt: t.date_released_unix ? t.date_released_unix * 1000 : undefined,
    })
  }

  return {
    results: [],
    links,
    pageTitle: `${sourceLabel} — API shows (page ${page})`,
    pageUrl: apiUrl,
    nextPage: torrents.length >= EZTV_PAGE_SIZE ? eztvApiUrl(origin, page + 1) : null,
    prevPage: page > 1 ? eztvApiUrl(origin, page - 1) : null,
    searchTemplate: null,
    error: links.length === 0 ? `${sourceLabel}: no shows found` : null,
  }
}

async function scrapeEztvPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  if (isEztvTmdbFeedUrl(pageUrl)) {
    let origin = ''
    try {
      origin = new URL(pageUrl).searchParams.get('origin') || ''
    } catch {
      origin = ''
    }
    if (!origin) return eztvFailed(sourceLabel, pageUrl, 'missing EZTV origin')
    const kind: EztvTmdbFeedKind = isEztvTmdbAiringFeedUrl(pageUrl)
      ? 'on_the_air'
      : 'popular'
    return scrapeEztvTmdbFeed(origin, sourceLabel, kind)
  }
  if (isEztvShowUrl(pageUrl)) return scrapeEztvShowDetail(pageUrl, sourceLabel)
  if (isEztvApiUrl(pageUrl)) {
    try {
      const imdb = new URL(pageUrl).searchParams.get('imdb_id')
      if (imdb) return scrapeEztvLatestPage(pageUrl, sourceLabel)
    } catch {
      /* fall through */
    }
    return scrapeEztvApiShowIndexPage(pageUrl, sourceLabel)
  }
  if (isEztvShowlistUrl(pageUrl)) {
    return scrapeEztvShowlistPage(pageUrl, sourceLabel)
  }
  return scrapeEztvLatestPage(pageUrl, sourceLabel)
}

/** Fetch any source/detail page and extract playable plus ordinary links. */
export async function scrapePage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  if (isEztvTmdbFeedUrl(pageUrl)) {
    let origin = ''
    try {
      origin = new URL(pageUrl).searchParams.get('origin') || ''
    } catch {
      origin = ''
    }
    if (!origin) {
      return {
        results: [],
        links: [],
        pageTitle: sourceLabel,
        pageUrl,
        nextPage: null,
        prevPage: null,
        searchTemplate: null,
        error: `${sourceLabel}: missing EZTV origin`,
      }
    }
    const kind: EztvTmdbFeedKind = isEztvTmdbAiringFeedUrl(pageUrl)
      ? 'on_the_air'
      : 'popular'
    return scrapeEztvTmdbFeed(origin, sourceLabel, kind)
  }
  if (isSubsPleaseUrl(pageUrl)) return scrapeSubsPlease(pageUrl, sourceLabel)
  // EZTV HTML (including /showlist/) is Cloudflare-blocked; use the JSON API.
  if (isEztvSource(pageUrl, sourceLabel)) return scrapeEztvPage(pageUrl, sourceLabel)
  // YTS HTML is Cloudflare-blocked; use the JSON API (same pattern as EZTV).
  // Match by host, API path, or a source label that contains "yts" / "yify".
  if (isYtsSource(pageUrl, sourceLabel)) return scrapeYtsPage(pageUrl, sourceLabel)
  // Torlock HTML obfuscates listing titles; use their public Torznab API.
  if (isTorlockUrl(pageUrl) || isTorlockTorznabUrl(pageUrl)) {
    return scrapeTorlockPage(pageUrl, sourceLabel)
  }
  const { ok, content, error: fetchError } = await fetchText(pageUrl)
  if (!ok) {
    return {
      results: [],
      links: [],
      pageTitle: sourceLabel,
      pageUrl,
      nextPage: null,
      prevPage: null,
      searchTemplate: null,
      error: `${sourceLabel}: ${fetchError || 'could not load page'}`,
    }
  }
  const doc = new DOMParser().parseFromString(content, 'text/html')
  const pageTitle = doc.querySelector('title')?.textContent?.trim() || sourceLabel
  const results = scrapeTorrentLinks(content, sourceLabel, pageUrl)
  const links = scrapePageLinks(content, pageUrl)
  const { nextPage, prevPage } = findPagination(doc, pageUrl)
  const searchTemplate = findSearchTemplate(doc, pageUrl, sourceLabel)
  const scrapeError =
    results.length === 0 && links.length === 0
      ? `${sourceLabel}: no readable links found (the page may require JavaScript or block automated loading)`
      : null
  return { results, links, pageTitle, pageUrl, nextPage, prevPage, searchTemplate, error: scrapeError }
}

/** Fetch a saved website's front page. */
export function scrapeWebsite(source: TorrentSource): Promise<TorrentScrapeOutcome> {
  if (isTorlockUrl(source.url)) {
    const origin = new URL(source.url).origin
    return scrapePage(torlockTorznabUrl(origin, 'movies', 0), source.label)
  }
  if (isYtsSource(source.url, source.label)) {
    const origin = new URL(source.url).origin
    // /browse-movies is Cloudflare-guarded on yts.gg and mirrors; the JSON
    // list API returns the same catalog with magnets included.
    return scrapePage(ytsListApiUrl(origin, 1), source.label)
  }
  if (isEztvSource(source.url, source.label)) {
    const origin = new URL(source.url).origin
    // Show List ALL catalogue (not Trending / Airing). Magnets resolve per show.
    return scrapePage(eztvShowlistAjaxUrl(origin, 1), source.label)
  }
  return scrapePage(source.url, source.label)
}

export interface CatalogFeed {
  url: string
  category: 'movies' | 'series' | 'anime'
  /** How many listing pages to crawl for this feed */
  maxPages: number
  /** Extra shelf tag (e.g. anime New Releases vs Full Shows) */
  shelfTag?: string
}

/**
 * Listing feeds to extract into Movies / TV Series / Anime shelves when a
 * torrent website is added or refreshed.
 */
export function catalogFeedsForSource(source: TorrentSource): CatalogFeed[] {
  try {
    const origin = new URL(source.url).origin
    if (isTorlockUrl(source.url)) {
      return [
        {
          url: torlockTorznabUrl(origin, 'movies', 0),
          category: 'movies',
          maxPages: 1,
        },
        {
          url: torlockTorznabUrl(origin, 'series', 0),
          category: 'series',
          maxPages: 1,
        },
        {
          url: torlockTorznabUrl(origin, 'anime', 0),
          category: 'anime',
          maxPages: 1,
        },
      ]
    }
    if (isYtsSource(source.url, source.label)) {
      return [
        {
          url: ytsListApiUrl(origin, 1, undefined, 'download_count'),
          category: 'movies',
          maxPages: YTS_POPULAR_MAX_PAGES,
          shelfTag: MOVIES_SHELF_POPULAR,
        },
        {
          url: ytsListApiUrl(origin, 1, undefined, 'date_added'),
          category: 'movies',
          maxPages: YTS_NEW_MAX_PAGES,
          shelfTag: MOVIES_SHELF_NEW,
        },
      ]
    }
    if (isEztvSource(source.url, source.label)) {
      return [
        {
          // Full Shows: TMDB top popular (2010+) present on EZTV API.
          url: eztvTmdbPopularFeedUrl(origin),
          category: 'series',
          maxPages: 1,
          shelfTag: ANIME_SHELF_FULL_SHOWS,
        },
        {
          // Now Airing: TMDB on_the_air present on EZTV API (no Cloudflare).
          url: eztvTmdbAiringFeedUrl(origin),
          category: 'series',
          maxPages: 1,
          shelfTag: SERIES_SHELF_TRENDING,
        },
      ]
    }
    if (isSubsPleaseUrl(source.url)) {
      // Root URL → New Releases; /shows/ → Full Shows catalog.
      if (isSubsPleaseLatestFeedUrl(source.url)) {
        return [
          {
            url: `${origin}/`,
            category: 'anime',
            maxPages: 1,
            shelfTag: ANIME_SHELF_NEW_RELEASES,
          },
        ]
      }
      return [
        {
          url: `${origin}/shows/`,
          category: 'anime',
          maxPages: 1,
          shelfTag: ANIME_SHELF_FULL_SHOWS,
        },
      ]
    }
  } catch {
    /* fall through */
  }
  return [{ url: source.url, category: inferTorrentCategory(source.url), maxPages: 5 }]
}

/** Turn a scraped listing card into a durable catalog StreamItem. */
export function linkToCatalogItem(
  link: TorrentPageLink,
  source: TorrentSource,
  fallbackCategory?: 'movies' | 'series' | 'anime',
  shelfTag?: string,
): StreamItem {
  // EZTV is exclusively episodic television. Force its entries into TV
  // Series even if generic URL/title inference would choose another shelf.
  // YTS / YIFY is movies-only — every title belongs on the Movies shelf.
  const category = isEztvSource(source.url, source.label)
    ? 'series'
    : isSubsPleaseUrl(source.url)
      ? 'anime'
      : isYtsSource(source.url, source.label)
        ? 'movies'
        : link.category ??
          fallbackCategory ??
          inferTorrentCategory(link.url, link.title, link.summary)
  const tags = [category]
  if (shelfTag && !tags.includes(shelfTag)) tags.push(shelfTag)
  // New-release magnets still keep the show page for full episode lists.
  const showPage =
    shelfTag === ANIME_SHELF_NEW_RELEASES
      ? link.url.replace(/#.*$/, '').replace(/\/$/, '')
      : undefined
  return {
    id: stableTorrentItemId(link.url),
    title: link.title,
    description: link.summary || '',
    category,
    url: link.url,
    poster: link.poster,
    // Category (+ optional shelf) — never put origin hostnames in shelf-facing fields.
    tags,
    source: 'Web catalog',
    sourceKind: 'torrent',
    transport: 'torrent',
    torrentUri: link.torrentUri,
    detailUrl: link.torrentUri ? showPage : link.url,
    releasedAt: link.releasedAt,
    runtimeSeconds: link.runtimeSeconds,
    torrentSourceId: source.id,
  }
}
