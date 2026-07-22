/**
 * Torrent websites (user-supplied pages that contain magnet or .torrent links)
 * and link scraping. Page fetches go through the desktop bridge to avoid CORS; the list
 * of added websites persists in localStorage.
 */

import { stableTorrentItemId } from './torrentCatalogStore'
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
}

const SOURCES_KEY = 'jiyu.torrent.sources'
const SUBSPLEASE_SOURCE: TorrentSource = {
  id: 'builtin-subsplease',
  label: 'subsplease.org',
  url: 'https://subsplease.org/shows/',
}

export function loadTorrentSources(): TorrentSource[] {
  try {
    const raw = localStorage.getItem(SOURCES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    const sources: TorrentSource[] = Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.url === 'string')
      : []
    if (!sources.some((source) => isSubsPleaseUrl(source.url))) {
      sources.push(SUBSPLEASE_SOURCE)
      localStorage.setItem(SOURCES_KEY, JSON.stringify(sources))
    }
    return sources
  } catch {
    return [SUBSPLEASE_SOURCE]
  }
}

export function saveTorrentSources(sources: TorrentSource[]) {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources))
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

export function isYtsUrl(pageUrl: string): boolean {
  try {
    return isYifyHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

/** YTS / YIFY and its many mirror domains (yts.mx, en.yts-official.biz, …) */
export function isYifyHost(hostname: string): boolean {
  return /(^|[.-])(yts|yify)([.-]|$)/i.test(hostname) || /yts-official|yifymovies/i.test(hostname)
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
 * Torlock uses table links for headings, sorting and navigation. Only its
 * /torrent/<id>/<slug>.html links represent playable detail pages.
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
    if (!/(^|\.)torlock\.com$/i.test(url.hostname)) continue
    if (!/^\/torrent\/\d+\/[^/]+\.html$/i.test(url.pathname)) continue

    url.hash = ''
    const absolute = url.toString()
    if (seen.has(absolute)) continue

    const row = anchor.closest('tr, article, li, .torrent, .item')
    const title = cleanMovieTitle(
      anchor.getAttribute('title')?.trim() ||
        anchor.textContent?.replace(/\s+/g, ' ').trim() ||
        '',
    )
    if (title.length < 2) continue

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

/** Highest quality a connection can comfortably sustain. */
export function targetQualityForSpeed(downlinkMbps: number): number {
  if (downlinkMbps <= 0) return 1080 // unknown → assume a solid broadband line
  if (downlinkMbps >= 25) return 2160
  if (downlinkMbps >= 8) return 1080
  return 720
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
    atOrBelow.sort(
      (a, b) =>
        b.quality - a.quality ||
        b.result.seeders - a.result.seeders ||
        b.result.sizeBytes - a.result.sizeBytes,
    )
    return { result: atOrBelow[0].result, quality: atOrBelow[0].quality, target }
  }

  // Everything is above the target — take the lowest quality available
  known.sort((a, b) => a.quality - b.quality || b.result.seeders - a.result.seeders)
  return { result: known[0].result, quality: known[0].quality, target }
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface EpisodeChoice {
  key: string
  title: string
  torrentUri: string
  quality: number
}

/**
 * Collapse a flat magnet list (many qualities × many episodes) into one
 * best-quality pick per episode, ordered naturally for the player drawer.
 */
export function buildEpisodeChoices(
  results: TorrentResult[],
  downlinkMbps: number,
  preferredQuality?: number,
): EpisodeChoice[] {
  const byEpisode = new Map<string, TorrentResult[]>()
  for (const result of results) {
    const key = parseEpisodeKey(result.title)
    if (!key) continue
    const list = byEpisode.get(key)
    if (list) list.push(result)
    else byEpisode.set(key, [result])
  }

  // Need at least two distinct episodes to bother with a show playlist.
  if (byEpisode.size < 2) return []

  const episodes: EpisodeChoice[] = []
  for (const [key, group] of byEpisode) {
    const pick = pickBestStream(group, downlinkMbps, preferredQuality)
    if (!pick) continue
    const showTitle = pick.result.title
      .replace(/\s*\(\d{3,4}p\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    episodes.push({
      key,
      title: showTitle || `Episode ${key}`,
      torrentUri: pick.result.uri,
      quality: pick.quality,
    })
  }

  episodes.sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }),
  )
  return episodes
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

  if (siblings.length < 2) return []

  const asResults: TorrentResult[] = siblings.map((item) => ({
    title: item.title,
    uri: item.torrentUri!,
    kind: 'magnet',
    sizeBytes: 0,
    seeders: 0,
    sourceLabel: item.source || 'catalog',
  }))

  return buildEpisodeChoices(asResults, downlinkMbps, preferredQuality)
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
function findSearchTemplate(doc: Document, pageUrl: string): string | null {
  let pageOrigin: string
  try {
    pageOrigin = new URL(pageUrl).origin
  } catch {
    return null
  }

  if (isTorlockUrl(pageUrl)) {
    // Search within Torlock's Movies category
    return `${pageOrigin}/movie/torrents/${QUERY_PATH_TOKEN}.html`
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

interface SubsPleaseDownload {
  res: string
  magnet: string
}

interface SubsPleaseRelease {
  release_date?: string
  show?: string
  episode?: string
  image_url?: string
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

async function scrapeSubsPlease(pageUrl: string, sourceLabel: string): Promise<TorrentScrapeOutcome> {
  const { ok, content, error } = await fetchText(pageUrl)
  if (!ok) return emptyOutcome(pageUrl, sourceLabel, error || 'could not load page')

  const doc = new DOMParser().parseFromString(content, 'text/html')
  const url = new URL(pageUrl)
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
        summary: 'Anime · SubsPlease · 720p preferred',
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

/** EZTV and its mirrors (eztvx.to, eztv.re, eztv1.xyz, …) — TV shows only. */
export function isEztvUrl(pageUrl: string): boolean {
  try {
    return /(^|\.)eztv[a-z0-9]*\.[a-z]+$/i.test(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

const EZTV_PAGE_SIZE = 100

function eztvApiUrl(origin: string, page: number): string {
  return `${origin}/api/get-torrents?limit=${EZTV_PAGE_SIZE}&page=${page}`
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
}

/**
 * EZTV's HTML pages sit behind a Cloudflare challenge, but its JSON API is
 * open. Every listing "page" is an API page of the latest episode torrents,
 * each of which already carries its magnet link.
 */
async function scrapeEztvPage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  let origin: string
  let page = 1
  try {
    const url = new URL(pageUrl)
    origin = url.origin
    if (/\/api\/get-torrents/i.test(url.pathname)) {
      page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    }
  } catch {
    origin = pageUrl
  }
  const apiUrl = eztvApiUrl(origin, page)

  const failed = (error: string): TorrentScrapeOutcome => ({
    results: [],
    links: [],
    pageTitle: sourceLabel,
    pageUrl: apiUrl,
    nextPage: null,
    prevPage: page > 1 ? eztvApiUrl(origin, page - 1) : null,
    searchTemplate: null,
    error: `${sourceLabel}: ${error}`,
  })

  const { ok, content, error: fetchError } = await fetchText(apiUrl)
  if (!ok) return failed(fetchError || 'could not reach the EZTV API')

  let torrents: EztvApiTorrent[]
  try {
    const json = JSON.parse(content) as { torrents?: EztvApiTorrent[] }
    torrents = Array.isArray(json.torrents) ? json.torrents : []
  } catch {
    return failed('unexpected response from the EZTV API')
  }
  if (torrents.length === 0) return failed('no torrents returned')

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
    const poster = screenshot ? (screenshot.startsWith('//') ? `https:${screenshot}` : screenshot) : undefined
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
      // Magnet doubles as a stable unique key; playback uses torrentUri
      url: t.magnet_url,
      summary,
      poster,
      category: 'series',
      releasedAt,
      torrentUri: t.magnet_url,
    })
  }

  return {
    results,
    links,
    pageTitle: `${sourceLabel} — latest episodes (page ${page})`,
    pageUrl: apiUrl,
    nextPage: torrents.length >= EZTV_PAGE_SIZE ? eztvApiUrl(origin, page + 1) : null,
    prevPage: page > 1 ? eztvApiUrl(origin, page - 1) : null,
    searchTemplate: null,
    error: links.length === 0 ? `${sourceLabel}: no playable torrents found` : null,
  }
}

/** Fetch any source/detail page and extract playable plus ordinary links. */
export async function scrapePage(
  pageUrl: string,
  sourceLabel: string,
): Promise<TorrentScrapeOutcome> {
  if (isSubsPleaseUrl(pageUrl)) return scrapeSubsPlease(pageUrl, sourceLabel)
  if (isEztvUrl(pageUrl)) return scrapeEztvPage(pageUrl, sourceLabel)
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
  const searchTemplate = findSearchTemplate(doc, pageUrl)
  const scrapeError =
    results.length === 0 && links.length === 0
      ? `${sourceLabel}: no readable links found (the page may require JavaScript or block automated loading)`
      : null
  return { results, links, pageTitle, pageUrl, nextPage, prevPage, searchTemplate, error: scrapeError }
}

/** Fetch a saved website's front page. */
export function scrapeWebsite(source: TorrentSource): Promise<TorrentScrapeOutcome> {
  if (isTorlockUrl(source.url)) {
    const sourceUrl = new URL(source.url)
    // Torlock's /all/ route mixes matching software, music and other
    // categories into the results. Its /movie/ route applies the site's own
    // Movies category filter before Jiyu parses the page.
    sourceUrl.pathname = '/movie/torrents/movie.html'
    sourceUrl.search = ''
    sourceUrl.hash = ''
    return scrapePage(sourceUrl.toString(), source.label)
  }
  if (isYtsUrl(source.url)) {
    const sourceUrl = new URL(source.url)
    // Plain /browse-movies defaults to latest-first on yts.mx and its
    // mirrors; query params differ between mirrors so don't rely on them.
    sourceUrl.pathname = '/browse-movies'
    sourceUrl.search = ''
    sourceUrl.hash = ''
    return scrapePage(sourceUrl.toString(), source.label)
  }
  return scrapePage(source.url, source.label)
}

export interface CatalogFeed {
  url: string
  category: 'movies' | 'series' | 'anime'
  /** How many listing pages to crawl for this feed */
  maxPages: number
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
          url: `${origin}/movie/torrents/movie.html?sort=added`,
          category: 'movies',
          maxPages: 8,
        },
        {
          url: `${origin}/television/torrents/television.html?sort=added`,
          category: 'series',
          maxPages: 6,
        },
        {
          url: `${origin}/anime/torrents/anime.html?sort=added`,
          category: 'anime',
          maxPages: 6,
        },
      ]
    }
    if (isYtsUrl(source.url)) {
      return [
        {
          url: `${origin}/browse-movies`,
          category: 'movies',
          // YIFY/YTS is movies-only — expand deeply across listing pages
          maxPages: 50,
        },
      ]
    }
    if (isEztvUrl(source.url)) {
      return [
        {
          // EZTV's HTML is Cloudflare-guarded; its open JSON API lists the
          // latest episode torrents (100 per page), magnets included.
          url: `${origin}/api/get-torrents?limit=100&page=1`,
          category: 'series',
          maxPages: 20,
        },
      ]
    }
    if (isSubsPleaseUrl(source.url)) {
      return [
        {
          url: `${origin}/shows/`,
          category: 'anime',
          maxPages: 1,
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
): StreamItem {
  // EZTV is exclusively episodic television. Force its entries into TV
  // Series even if generic URL/title inference would choose another shelf.
  const category = isEztvUrl(source.url)
    ? 'series'
    : isSubsPleaseUrl(source.url)
      ? 'anime'
      : link.category ??
      fallbackCategory ??
      inferTorrentCategory(link.url, link.title, link.summary)
  return {
    id: stableTorrentItemId(link.url),
    title: link.title,
    description: link.summary || `${source.label} torrent`,
    category,
    url: link.url,
    poster: link.poster,
    tags: [category, source.label],
    source: source.label,
    sourceKind: 'torrent',
    transport: 'torrent',
    torrentUri: link.torrentUri,
    detailUrl: link.torrentUri ? undefined : link.url,
    releasedAt: link.releasedAt,
    torrentSourceId: source.id,
  }
}
