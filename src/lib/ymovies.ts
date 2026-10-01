/**
 * YMovies (ww.ymovies.vip) — Yify-style TV catalog with AJAX episode lists.
 * Catalog from /movie/filter/series/; play prefers the fstream365 embed (same
 * in-app Web Browser path as NetMirror — no stable native HLS/MP4 API).
 */

import type { TorrentPageLink } from './torrents'

export const YMOVIES_SERIES_FEED_PREFIX = 'jiyu://ymovies-series'
export const YMOVIES_CATALOG_ORIGIN = 'https://ww.ymovies.vip'
export const YMOVIES_TV_FILTER_PATH = '/movie/filter/series'
/**
 * Sync cap: ~40 titles/page → ~4,000 shows.
 * Full site is ~512 pages; staying under that volume reduces CF unlock prompts.
 */
export const YMOVIES_CATALOG_PAGES = 100
export const YMOVIES_REQUEST_GAP_MS = 300
export const YMOVIES_DEFAULT_SERVER = '11'

export interface YmoviesEpisodeInfo {
  key: string
  season: number
  episode: number
  title: string
}

export type YmoviesPlayResolveResult =
  | {
      ok: true
      url: string
      ymoviesId: string
      season: number
      episode: number
      /** True when url is the fstream365 embed (preferred over site watching page). */
      embed?: boolean
    }
  | { ok: false; error: string }

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

export function isYmoviesUrl(pageUrl: string): boolean {
  if (pageUrl.startsWith(YMOVIES_SERIES_FEED_PREFIX)) return true
  // Cheap reject before URL parsing (hot path on large shelves).
  if (!/ymovies\.vip/i.test(pageUrl)) return false
  try {
    const host = new URL(pageUrl).hostname.toLowerCase()
    return host === 'ww.ymovies.vip' || host.endsWith('.ymovies.vip')
  } catch {
    return true
  }
}

export function isYmoviesCatalogItem(item: {
  url?: string
  detailUrl?: string
  ymoviesId?: string
  torrentSourceId?: string
}): boolean {
  if (item.ymoviesId) return true
  if (item.torrentSourceId === 'builtin-ymovies') return true
  if (item.url && isYmoviesUrl(item.url)) return true
  if (item.detailUrl && isYmoviesUrl(item.detailUrl)) return true
  return false
}

export function isYmoviesSeriesFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(YMOVIES_SERIES_FEED_PREFIX)
}

export function ymoviesSeriesFeedUrl(origin = YMOVIES_CATALOG_ORIGIN): string {
  return `${YMOVIES_SERIES_FEED_PREFIX}?origin=${encodeURIComponent(origin)}`
}

export function ymoviesFeedOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('origin') || YMOVIES_CATALOG_ORIGIN
  } catch {
    return YMOVIES_CATALOG_ORIGIN
  }
}

export function ymoviesTvListPageUrl(origin: string, page = 1): string {
  const base = `${origin.replace(/\/$/, '')}${YMOVIES_TV_FILTER_PATH}/`
  if (page <= 1) return base
  return `${base}${page}/`
}

/** Page number from a YMovies TV filter listing URL (1 if missing). */
export function ymoviesListPageNumber(pageUrl: string): number {
  try {
    const path = new URL(pageUrl).pathname.replace(/\/+$/, '')
    const m = path.match(/\/movie\/filter\/series\/(\d+)$/i)
    if (m?.[1]) {
      const n = Number(m[1])
      return Number.isFinite(n) && n >= 1 ? n : 1
    }
  } catch {
    /* fall through */
  }
  return 1
}

export function isYmoviesTvListUrl(pageUrl: string): boolean {
  try {
    if (!isYmoviesUrl(pageUrl) || isYmoviesSeriesFeedUrl(pageUrl)) return false
    return /\/movie\/filter\/series(?:\/\d+)?\/?$/i.test(new URL(pageUrl).pathname)
  } catch {
    return /\/movie\/filter\/series/i.test(pageUrl)
  }
}

export function ymoviesIdFromUrl(pageUrl: string): string {
  const m = pageUrl.match(/-(s[a-z0-9]+)(?:\/|$|\?)/i)
  return m?.[1] || ''
}

export function ymoviesWatchUrl(detailUrl: string, season: number, episode: number): string {
  const base = detailUrl.replace(/\/watching\.html.*$/i, '').replace(/\/$/, '')
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  return `${base}/watching.html?ep=${s}_${e}`
}

export function parseYmoviesListHtml(html: string, origin = YMOVIES_CATALOG_ORIGIN): TorrentPageLink[] {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  // Cards are <div class="ml-item">…</div>. Matching href→data-original across the
  // whole page pairs a title with the *next* card's poster (duplicate wrong thumbs).
  const parts = html.split(/<div class="ml-item">/i).slice(1)

  for (const part of parts) {
    const mask =
      part.match(
        /<a[^>]*class="[^"]*ml-mask[^"]*"[^>]*href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
      ) ||
      part.match(
        /href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
      )
    if (!mask) continue
    const path = mask[1]
    const url = path.startsWith('http') ? path : `${origin.replace(/\/$/, '')}${path}`
    if (seen.has(url)) continue
    seen.add(url)
    const title = decodeHtmlEntities(mask[2] || '').slice(0, 180)
    if (!title) continue
    const poster = mask[3]
    const seasons = part.match(/SS\s*(\d+)/i)?.[1] || ''
    const eps = part.match(/EPS\s*(\d+)/i)?.[1] || ''
    const summary = ['TV Series', seasons ? `SS ${seasons}` : '', eps ? `EPS ${eps}` : '']
      .filter(Boolean)
      .join(' · ')
    links.push({
      title,
      url,
      summary,
      poster,
      category: 'series',
      ymoviesId: ymoviesIdFromUrl(url),
    })
  }
  return links
}

async function fetchText(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  const { nativeFetchText } = await import('./nativeHttp')
  // Never auto-pop Verify — it hijacks the sports/embed WebView mid-watch.
  const result = await nativeFetchText(url, {
    quiet: true,
    preferWebView: true,
    allowUnlock: false,
    headers: {
      Accept: 'text/html,application/json',
      Referer: `${YMOVIES_CATALOG_ORIGIN}/`,
    },
  })
  return { ok: result.ok, content: result.content, error: result.error }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function parseAjaxHtml(jsonText: string): string {
  try {
    const data = JSON.parse(jsonText) as { html?: string }
    return typeof data.html === 'string' ? data.html : ''
  } catch {
    return ''
  }
}

function parseSeasonIds(html: string): number[] {
  const seasons: number[] = []
  // data-id may appear before or after class="…ss-item…"
  const re =
    /(?:class="[^"]*ss-item[^"]*"[^>]*data-id="(\d+)"|data-id="(\d+)"[^>]*class="[^"]*ss-item[^"]*")/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const n = Number(m[1] || m[2])
    if (Number.isFinite(n) && n >= 1) seasons.push(n)
  }
  if (seasons.length === 0) {
    for (const hit of html.matchAll(/id="ss-(\d+)"/gi)) {
      const n = Number(hit[1])
      if (Number.isFinite(n) && n >= 1) seasons.push(n)
    }
  }
  if (seasons.length === 0) seasons.push(1)
  return [...new Set(seasons)].sort((a, b) => a - b)
}

function parseEpisodeRows(html: string): Array<{ season: number; episode: number; title: string }> {
  const rows: Array<{ season: number; episode: number; title: string }> = []
  const re = /data-id="(\d+)_(\d+)"[^>]*title="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const season = Number(m[1])
    const episode = Number(m[2])
    if (!Number.isFinite(season) || !Number.isFinite(episode) || season < 1 || episode < 1) continue
    const title = decodeHtmlEntities(m[3] || '').replace(/^Eps\s*\d+:\s*/i, '').trim()
    rows.push({
      season,
      episode,
      title: title || `Episode ${episode}`,
    })
  }
  return rows
}

/** Paginate YMovies TV series filter listings. */
export async function fetchYmoviesCatalogLinks(
  origin = YMOVIES_CATALOG_ORIGIN,
  maxPages = YMOVIES_CATALOG_PAGES,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  let lastError: string | null = null

  for (let page = 1; page <= maxPages; page += 1) {
    const listUrl = ymoviesTvListPageUrl(origin, page)
    const result = await fetchText(listUrl)
    if (!result.ok || !result.content) {
      lastError = result.error || 'YMovies page unavailable'
      if (page === 1) break
      continue
    }
    const parsed = parseYmoviesListHtml(result.content, origin)
    let added = 0
    for (const link of parsed) {
      if (seen.has(link.url)) continue
      seen.add(link.url)
      links.push(link)
      added += 1
    }
    if (added === 0) break
    if (page < maxPages) await sleep(YMOVIES_REQUEST_GAP_MS)
  }

  return {
    links,
    error: links.length === 0 ? lastError : null,
  }
}

/** Fetch seasons/episodes via YMovies AJAX endpoints. */
export async function fetchYmoviesEpisodeList(
  detailUrl: string,
  knownId?: string,
): Promise<{
  ymoviesId: string
  episodes: YmoviesEpisodeInfo[]
  description?: string
  error?: string
}> {
  const ymoviesId = knownId?.trim() || ymoviesIdFromUrl(detailUrl)
  if (!ymoviesId) {
    return { ymoviesId: '', episodes: [], error: 'Could not read YMovies show id' }
  }

  const origin = YMOVIES_CATALOG_ORIGIN
  const episodes: YmoviesEpisodeInfo[] = []

  // Season 1 + seasons list in parallel — sequential calls made show pages feel stuck.
  const [seasonsResult, season1Result] = await Promise.all([
    fetchText(`${origin}/ajax/movie/seasons/${ymoviesId}`),
    fetchText(`${origin}/ajax/movie/season/episodes/${ymoviesId}_1`),
  ])

  let seasonIds = [1]
  if (seasonsResult.ok) {
    const parsed = parseSeasonIds(parseAjaxHtml(seasonsResult.content))
    if (parsed.length > 0) seasonIds = parsed
  }

  if (season1Result.ok) {
    for (const row of parseEpisodeRows(parseAjaxHtml(season1Result.content))) {
      episodes.push({
        key: `S${String(row.season).padStart(2, '0')}E${String(row.episode).padStart(2, '0')}`,
        season: row.season,
        episode: row.episode,
        title: row.title,
      })
    }
  }

  for (const season of seasonIds) {
    if (season === 1) continue
    const epResult = await fetchText(`${origin}/ajax/movie/season/episodes/${ymoviesId}_${season}`)
    if (!epResult.ok) continue
    for (const row of parseEpisodeRows(parseAjaxHtml(epResult.content))) {
      episodes.push({
        key: `S${String(row.season).padStart(2, '0')}E${String(row.episode).padStart(2, '0')}`,
        season: row.season,
        episode: row.episode,
        title: row.title,
      })
    }
  }

  if (episodes.length === 0) {
    return {
      ymoviesId,
      episodes: [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }],
      error:
        season1Result.error ||
        seasonsResult.error ||
        'No episodes found',
    }
  }

  return { ymoviesId, episodes }
}

/** Resolve YMovies episode to an in-app player URL (embed preferred; site fallback). */
export async function resolveYmoviesPlay(
  detailUrl: string,
  options?: {
    ymoviesId?: string
    season?: number
    episode?: number
    serverId?: string
  },
): Promise<YmoviesPlayResolveResult> {
  const season = Math.max(1, options?.season ?? 1)
  const episode = Math.max(1, options?.episode ?? 1)
  const ymoviesId = options?.ymoviesId?.trim() || ymoviesIdFromUrl(detailUrl)
  if (!detailUrl && !ymoviesId) {
    return { ok: false, error: 'Missing YMovies detail URL' }
  }

  // Prefer the fstream365 embed — same idea as NetMirror's player page (no full
  // YMovies chrome). Native HLS like M2Box isn't available: sources are encrypted.
  if (ymoviesId) {
    const embed = await resolveYmoviesEmbedSrc(
      ymoviesId,
      season,
      episode,
      options?.serverId || YMOVIES_DEFAULT_SERVER,
    )
    if (embed.ok) {
      return {
        ok: true,
        url: embed.src,
        ymoviesId,
        season,
        episode,
        embed: true,
      }
    }
  }

  const watchBase = (detailUrl || '').replace(/\/watching\.html.*$/i, '').replace(/\/$/, '')
  if (!watchBase) {
    return { ok: false, error: 'Invalid YMovies detail URL' }
  }
  return {
    ok: true,
    url: ymoviesWatchUrl(watchBase, season, episode),
    ymoviesId,
    season,
    episode,
    embed: false,
  }
}

/** Resolve fstream365 embed via server/sources AJAX (short-lived URLs). */
export async function resolveYmoviesEmbedSrc(
  ymoviesId: string,
  season: number,
  episode: number,
  serverId = YMOVIES_DEFAULT_SERVER,
): Promise<{ ok: true; src: string } | { ok: false; error: string }> {
  const origin = YMOVIES_CATALOG_ORIGIN
  const serversResult = await fetchText(
    `${origin}/ajax/movie/episode/servers/${ymoviesId}_${season}_${episode}`,
  )
  if (!serversResult.ok) {
    return { ok: false, error: serversResult.error || 'Could not load servers' }
  }
  const serverHtml = parseAjaxHtml(serversResult.content)
  // Prefer matching Server A1/A2 (data-name="11"/"12"); attributes may be in either order.
  let token = ''
  let resolvedServer = serverId
  const re = /<a\b([^>]*data-id="([^"]+)"[^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(serverHtml))) {
    const attrs = m[1]
    const id = m[2]
    const name = attrs.match(/data-name="(\d+)"/i)?.[1]
    if (name === serverId) {
      token = id
      resolvedServer = name
      break
    }
    if (!token) {
      token = id
      if (name) resolvedServer = name
    }
  }
  if (!token) return { ok: false, error: 'No server token' }

  const srcResult = await fetchText(
    `${origin}/ajax/movie/episode/server/sources/${token}_${resolvedServer}`,
  )
  if (!srcResult.ok) {
    return { ok: false, error: srcResult.error || 'Could not resolve embed' }
  }
  try {
    const data = JSON.parse(srcResult.content) as { status?: boolean; src?: string }
    if (data.status && data.src) return { ok: true, src: data.src }
  } catch {
    /* fall through */
  }
  return { ok: false, error: 'Invalid embed response' }
}
