/**
 * NetMirror (ww1.surf/netmirror) — iframe front for freemovies.lol.
 * Catalog from TV Series listings; episode picker via TMDB meta on the detail
 * page; play opens the freemovies player URL in Jiyu’s Web Browser (no native
 * HLS/MP4 from embed hosts).
 */

import type { TorrentPageLink } from './torrents'

export const NETMIRROR_SERIES_FEED_PREFIX = 'jiyu://netmirror-series'
export const NETMIRROR_CATALOG_ORIGIN = 'https://freemovies.lol'
export const NETMIRROR_TV_CATEGORY_PATH = '/category/tv-series'
/** ~32 titles/page on freemovies.lol category listings (~146 pages / ~4650 titles). */
export const NETMIRROR_CATALOG_PAGES = 146
export const NETMIRROR_REQUEST_GAP_MS = 350
/** Default embed host label used by freemovies `sv=` (Vidsrc / vsembed.ru). */
export const NETMIRROR_DEFAULT_SERVER = 'embedru'

export interface NetMirrorEpisodeInfo {
  key: string
  season: number
  episode: number
  title: string
}

export interface NetMirrorShowMeta {
  postId: string
  tmdbId: string
  imdbId?: string
  apiKey: string
  tvPlayer: string
  title?: string
  overview?: string
}

export type NetMirrorPlayResolveResult =
  | {
      ok: true
      url: string
      postId: string
      tmdbId: string
      season: number
      episode: number
    }
  | { ok: false; error: string }

export function isNetMirrorUrl(pageUrl: string): boolean {
  if (pageUrl.startsWith(NETMIRROR_SERIES_FEED_PREFIX)) return true
  try {
    const host = new URL(pageUrl).hostname.toLowerCase()
    return (
      host === 'freemovies.lol' ||
      host.endsWith('.freemovies.lol') ||
      /(^|\.)ww\d*\.surf$/i.test(host) ||
      /(^|\.)ww\d*\.lat$/i.test(host) ||
      host === 'netmirror-app.pages.dev' ||
      /netmirror/i.test(host)
    )
  } catch {
    return /freemovies\.lol|netmirror|ww\d*\.surf/i.test(pageUrl)
  }
}

export function isNetMirrorCatalogItem(item: {
  url?: string
  detailUrl?: string
}): boolean {
  if (item.url && isNetMirrorUrl(item.url)) return true
  if (item.detailUrl && isNetMirrorUrl(item.detailUrl)) return true
  return false
}

export function isNetMirrorSeriesFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(NETMIRROR_SERIES_FEED_PREFIX)
}

export function netmirrorSeriesFeedUrl(origin = NETMIRROR_CATALOG_ORIGIN): string {
  return `${NETMIRROR_SERIES_FEED_PREFIX}?origin=${encodeURIComponent(origin)}`
}

export function netmirrorFeedOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('origin') || NETMIRROR_CATALOG_ORIGIN
  } catch {
    return NETMIRROR_CATALOG_ORIGIN
  }
}

export function netmirrorTvListPageUrl(origin: string, page = 1): string {
  const base = `${origin.replace(/\/$/, '')}${NETMIRROR_TV_CATEGORY_PATH}/`
  if (page <= 1) return base
  return `${base}page/${page}/`
}

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

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function parseNetMirrorListHtml(html: string): TorrentPageLink[] {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  const re =
    /id="post-(\d+)"[\s\S]*?<a href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>\s*<img[^>]+data-src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<span>(\d{4})<\/span>\s*<span class="type">([^<]*)<\/span>\s*<span>([^<]*)<\/span>/gi

  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const url = match[2]
    if (seen.has(url)) continue
    seen.add(url)
    const title = decodeHtmlEntities(match[4] || '').slice(0, 180)
    if (!title) continue
    const year = match[5]
    const season = match[6].trim()
    const episode = match[7].trim()
    const summary = ['TV Series', year, season, episode].filter(Boolean).join(' · ')
    const releasedAt = Date.parse(`${year}-01-01T00:00:00Z`)
    links.push({
      title,
      url,
      summary,
      poster: match[3],
      category: 'series',
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
    })
  }
  return links
}

async function fetchHtml(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url)
    return {
      ok: result.ok,
      content: result.content || '',
      error: result.error || '',
    }
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html',
        Referer: 'https://ww1.surf/netmirror/',
      },
    })
    const content = await res.text()
    return {
      ok: res.ok,
      content,
      error: res.ok ? '' : `HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      content: '',
      error: err instanceof Error ? err.message : 'NetMirror fetch failed',
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** Paginate freemovies.lol TV Series category listings. */
export async function fetchNetMirrorCatalogLinks(
  origin = NETMIRROR_CATALOG_ORIGIN,
  maxPages = NETMIRROR_CATALOG_PAGES,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  let lastError: string | null = null

  for (let page = 1; page <= maxPages; page += 1) {
    const listUrl = netmirrorTvListPageUrl(origin, page)
    const result = await fetchHtml(listUrl)
    if (!result.ok || !result.content) {
      lastError = result.error || 'NetMirror page unavailable'
      if (page === 1) break
      continue
    }
    const parsed = parseNetMirrorListHtml(result.content)
    let added = 0
    for (const link of parsed) {
      if (seen.has(link.url)) continue
      seen.add(link.url)
      links.push(link)
      added += 1
    }
    if (added === 0) break
    if (page < maxPages) await sleep(NETMIRROR_REQUEST_GAP_MS)
  }

  return {
    links,
    error: links.length === 0 ? lastError : null,
  }
}

function parseDescriptionFromHtml(html: string): string | null {
  const desc =
    html.match(
      /<div[^>]+class="[^"]*(?:description|desc|plot|overview)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    )?.[1] ||
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1]
  if (!desc) return null
  const text = stripTags(desc)
  return text.length > 20 ? text.slice(0, 600) : null
}

/** Decode `episodes-js-extra` data-URI (var Episodes={…}) from a detail page. */
export function parseNetMirrorMetaFromHtml(html: string): NetMirrorShowMeta | null {
  const dataUri = html.match(
    /id=["']episodes-js-extra["'][^>]*src=["']data:text\/javascript;base64,([A-Za-z0-9+/=]+)["']/i,
  )
  let raw = ''
  if (dataUri?.[1]) {
    try {
      raw = atob(dataUri[1])
    } catch {
      raw = ''
    }
  }
  if (!raw) {
    const inline = html.match(/var\s+Episodes\s*=\s*(\{[\s\S]*?\})\s*;/)
    raw = inline?.[1] ? `var Episodes=${inline[1]};` : ''
  }
  if (!raw) return null

  const objMatch = raw.match(/var\s+Episodes\s*=\s*(\{[\s\S]*?\})\s*;/)
  if (!objMatch?.[1]) return null
  try {
    const data = JSON.parse(objMatch[1]) as Record<string, unknown>
    const postId = String(data.post_id || '').trim()
    const tmdbId = String(data.tvid || '').trim()
    const apiKey = String(data.tvapikey || '').trim()
    const tvPlayer = String(data.tvplayer || `${NETMIRROR_CATALOG_ORIGIN}/?player_tv=`).trim()
    if (!postId || !tmdbId || !apiKey) return null
    return {
      postId,
      tmdbId,
      imdbId: String(data.tvimdbid || '').trim() || undefined,
      apiKey,
      tvPlayer,
      title: String(data.tvtitle || '').trim() || undefined,
      overview: parseDescriptionFromHtml(html) || undefined,
    }
  } catch {
    return null
  }
}

/** freemovies player URL that loads getPlayTV → embed for S/E. */
export function netmirrorEpisodePlayerUrl(
  meta: Pick<NetMirrorShowMeta, 'postId' | 'tvPlayer'>,
  season: number,
  episode: number,
  server = NETMIRROR_DEFAULT_SERVER,
): string {
  const base = (meta.tvPlayer || `${NETMIRROR_CATALOG_ORIGIN}/?player_tv=`).replace(/\s+$/, '')
  const se = Math.max(1, season)
  const ep = Math.max(1, episode)
  return `${base}${meta.postId}&s=${se}&e=${ep}&sv=${encodeURIComponent(server)}&tv=true`
}

async function fetchJson(url: string): Promise<{ ok: boolean; data: unknown; error: string }> {
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, `${NETMIRROR_CATALOG_ORIGIN}/`)
    if (!result.ok) {
      return { ok: false, data: null, error: result.error || `HTTP ${result.status}` }
    }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null'), error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json(), error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'TMDB request failed',
    }
  }
}

function tmdbTvUrl(tmdbId: string, apiKey: string, path = ''): string {
  const base = `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}${path}`
  return `${base}?api_key=${encodeURIComponent(apiKey)}&language=en-US`
}

function episodeAired(airDate: string | null | undefined): boolean {
  if (!airDate) return false
  const t = Date.parse(`${airDate}T23:59:59Z`)
  return Number.isFinite(t) && t <= Date.now()
}

/** Fetch detail meta + TMDB seasons into an episode list for the show picker. */
export async function fetchNetMirrorEpisodeList(
  detailUrl: string,
  known?: { postId?: string; tmdbId?: string },
): Promise<{
  postId: string
  tmdbId: string
  episodes: NetMirrorEpisodeInfo[]
  description?: string
  error?: string
}> {
  const result = await fetchHtml(detailUrl)
  if (!result.ok || !result.content) {
    return {
      postId: known?.postId || '',
      tmdbId: known?.tmdbId || '',
      episodes: [],
      error: result.error || 'Could not load NetMirror detail page',
    }
  }

  const meta = parseNetMirrorMetaFromHtml(result.content)
  const postId = known?.postId || meta?.postId || ''
  const tmdbId = known?.tmdbId || meta?.tmdbId || ''
  const apiKey = meta?.apiKey || ''
  const description = meta?.overview || parseDescriptionFromHtml(result.content) || undefined

  if (!meta || !apiKey || !tmdbId) {
    return {
      postId,
      tmdbId,
      episodes: postId
        ? [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }]
        : [],
      description,
      error: postId ? undefined : 'Could not read NetMirror episode meta',
    }
  }

  const show = await fetchJson(tmdbTvUrl(tmdbId, apiKey))
  if (!show.ok || !show.data || typeof show.data !== 'object') {
    return {
      postId,
      tmdbId,
      episodes: [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }],
      description,
      error: show.error || 'TMDB show unavailable',
    }
  }

  const showObj = show.data as {
    number_of_seasons?: number
    overview?: string
    seasons?: Array<{ season_number?: number; episode_count?: number }>
  }
  const overview =
    description ||
    (typeof showObj.overview === 'string' && showObj.overview.trim().length > 20
      ? showObj.overview.trim().slice(0, 600)
      : undefined)

  const seasonNums: number[] = []
  if (Array.isArray(showObj.seasons)) {
    for (const row of showObj.seasons) {
      const n = Number(row.season_number)
      if (Number.isFinite(n) && n >= 1) seasonNums.push(n)
    }
  }
  if (seasonNums.length === 0) {
    const count = Math.max(1, Number(showObj.number_of_seasons) || 1)
    for (let s = 1; s <= count; s += 1) seasonNums.push(s)
  }

  const episodes: NetMirrorEpisodeInfo[] = []
  for (const season of seasonNums) {
    const seasonJson = await fetchJson(tmdbTvUrl(tmdbId, apiKey, `/season/${season}`))
    if (!seasonJson.ok || !seasonJson.data || typeof seasonJson.data !== 'object') continue
    const eps = (seasonJson.data as { episodes?: Array<Record<string, unknown>> }).episodes
    if (!Array.isArray(eps)) continue
    for (const ep of eps) {
      const episode = Number(ep.episode_number)
      if (!Number.isFinite(episode) || episode < 1) continue
      if (!episodeAired(typeof ep.air_date === 'string' ? ep.air_date : null)) continue
      const name = typeof ep.name === 'string' ? ep.name.trim() : ''
      episodes.push({
        key: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
        season,
        episode,
        title: name || `Episode ${episode}`,
      })
    }
  }

  if (episodes.length === 0) {
    return {
      postId,
      tmdbId,
      episodes: [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }],
      description: overview,
      error: 'No aired episodes found',
    }
  }

  return { postId, tmdbId, episodes, description: overview }
}

/**
 * Resolve a NetMirror detail page to the in-app Web Browser player URL for S/E.
 * Embed hosts do not expose a stable native HLS/MP4 for Jiyu’s player.
 */
export async function resolveNetMirrorPlay(
  detailUrl: string,
  options?: {
    postId?: string
    tmdbId?: string
    season?: number
    episode?: number
    server?: string
  },
): Promise<NetMirrorPlayResolveResult> {
  const season = Math.max(1, options?.season ?? 1)
  const episode = Math.max(1, options?.episode ?? 1)

  let postId = options?.postId?.trim() || ''
  let tmdbId = options?.tmdbId?.trim() || ''
  let tvPlayer = `${NETMIRROR_CATALOG_ORIGIN}/?player_tv=`

  if (!postId) {
    const result = await fetchHtml(detailUrl)
    if (!result.ok || !result.content) {
      return { ok: false, error: result.error || 'Could not load NetMirror detail page' }
    }
    const meta = parseNetMirrorMetaFromHtml(result.content)
    if (!meta) {
      return { ok: false, error: 'Could not read NetMirror player meta' }
    }
    postId = meta.postId
    tmdbId = meta.tmdbId || tmdbId
    tvPlayer = meta.tvPlayer
  }

  return {
    ok: true,
    url: netmirrorEpisodePlayerUrl({ postId, tvPlayer }, season, episode, options?.server),
    postId,
    tmdbId,
    season,
    episode,
  }
}

/** Optional: enrich description from a single detail page. */
export async function fetchNetMirrorDescription(detailUrl: string): Promise<string | null> {
  const result = await fetchHtml(detailUrl)
  if (!result.ok) return null
  return parseDescriptionFromHtml(result.content)
}
