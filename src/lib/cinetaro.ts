/**
 * Cinetaro (cinetaro.to) — TMDB-backed TV catalog.
 * Listing HTML is Cloudflare-guarded; Android sync falls back to TMDB discover
 * mapped onto /details/{id}?tv URLs. Play prefers cinextream embeds (no CF).
 */

import type { TorrentPageLink } from './torrents'
import { fetchTmdbTvEpisodeList } from './tmdbTv'

export const CINETARO_SERIES_FEED_PREFIX = 'jiyu://cinetaro-series'
export const CINETARO_CATALOG_ORIGIN = 'https://cinetaro.to'
export const CINETARO_TV_LIST_PATH = '/movie/tv-series'
/** ~20 titles/page; site claims 11k+ pages — cap keeps sync reasonable. */
export const CINETARO_CATALOG_PAGES = 100
/**
 * TMDB-backed Cinetaro shelf size (popular + on_the_air, deduped).
 * Match Electron popular default (~3000) so Android Series isn't short.
 */
export const CINETARO_TMDB_LIMIT = 3000
export const CINETARO_REQUEST_GAP_MS = 280
export const CINETARO_EMBED_ORIGIN = 'https://cinextream.cc'
export const CINETARO_DEFAULT_SERVER = 'maple'

export interface CinetaroEpisodeInfo {
  key: string
  season: number
  episode: number
  title: string
}

export interface CinetaroServer {
  serverId: string
  serverName: string
  serverType: 'sub' | 'dub'
  available: boolean
}

export type CinetaroPlayResolveResult =
  | {
      ok: true
      url: string
      tmdbId: string
      season: number
      episode: number
      /** True when url is the cinextream embed (preferred). */
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

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function isCinetaroUrl(pageUrl: string): boolean {
  if (pageUrl.startsWith(CINETARO_SERIES_FEED_PREFIX)) return true
  if (!/cinetaro\.to|cinextream\.cc/i.test(pageUrl)) return false
  try {
    const host = new URL(pageUrl).hostname.toLowerCase()
    return (
      host === 'cinetaro.to' ||
      host.endsWith('.cinetaro.to') ||
      host === 'cinextream.cc' ||
      host.endsWith('.cinextream.cc')
    )
  } catch {
    return true
  }
}

export function isCinetaroCatalogItem(item: {
  url?: string
  detailUrl?: string
  cinetaroTmdbId?: string
  torrentSourceId?: string
}): boolean {
  if (item.cinetaroTmdbId) return true
  if (item.torrentSourceId === 'builtin-cinetaro') return true
  if (item.url && isCinetaroUrl(item.url) && !/cinextream\.cc/i.test(item.url)) return true
  if (item.detailUrl && isCinetaroUrl(item.detailUrl) && !/cinextream\.cc/i.test(item.detailUrl)) {
    return true
  }
  return false
}

export function isCinetaroSeriesFeedUrl(pageUrl: string): boolean {
  return pageUrl.startsWith(CINETARO_SERIES_FEED_PREFIX)
}

export function cinetaroSeriesFeedUrl(origin = CINETARO_CATALOG_ORIGIN): string {
  return `${CINETARO_SERIES_FEED_PREFIX}?origin=${encodeURIComponent(origin)}`
}

export function cinetaroFeedOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).searchParams.get('origin') || CINETARO_CATALOG_ORIGIN
  } catch {
    return CINETARO_CATALOG_ORIGIN
  }
}

export function cinetaroTvListPageUrl(origin: string, page = 1): string {
  const base = `${origin.replace(/\/$/, '')}${CINETARO_TV_LIST_PATH}`
  if (page <= 1) return `${base}?page=1`
  return `${base}?page=${page}`
}

export function cinetaroListPageNumber(pageUrl: string): number {
  try {
    const n = Number(new URL(pageUrl).searchParams.get('page') || '1')
    return Number.isFinite(n) && n >= 1 ? n : 1
  } catch {
    return 1
  }
}

export function isCinetaroTvListUrl(pageUrl: string): boolean {
  try {
    if (!isCinetaroUrl(pageUrl) || isCinetaroSeriesFeedUrl(pageUrl)) return false
    return /\/movie\/tv-series\/?$/i.test(new URL(pageUrl).pathname)
  } catch {
    return /\/movie\/tv-series/i.test(pageUrl)
  }
}

export function cinetaroTmdbIdFromUrl(pageUrl: string): string {
  const m =
    pageUrl.match(/\/(?:details|watch)\/(\d+)/i) ||
    pageUrl.match(/\/embed\/(?:tv|movie)\/(\d+)/i) ||
    pageUrl.match(/\/api\/embed\/(?:tv|movie)\/(\d+)/i)
  return m?.[1] || ''
}

/** cinetaro.to catalog/watch pages. The in-app player is cinextream.cc. */
export function isCinetaroCatalogPageUrl(pageUrl: string): boolean {
  if (!pageUrl || /cinextream\.cc/i.test(pageUrl)) return false
  try {
    const host = new URL(pageUrl).hostname.toLowerCase()
    return host === 'cinetaro.to' || host.endsWith('.cinetaro.to')
  } catch {
    return /cinetaro\.to/i.test(pageUrl)
  }
}

/**
 * Playback URL for a Cinetaro page. Catalog/watch links become the cinextream
 * embed so the in-app browser never loads the Cloudflare wall on cinetaro.to.
 */
export function cinetaroPlaybackUrl(pageUrl: string): string {
  const raw = pageUrl.trim()
  if (!raw || !isCinetaroCatalogPageUrl(raw)) return raw
  const tmdbId = cinetaroTmdbIdFromUrl(raw)
  if (!tmdbId) return raw
  let season = 1
  let episode = 1
  try {
    const u = new URL(raw)
    season = Math.max(1, Number(u.searchParams.get('s') || '1') || 1)
    episode = Math.max(1, Number(u.searchParams.get('ep') || u.searchParams.get('e') || '1') || 1)
  } catch {
    /* defaults */
  }
  return cinetaroCinextreamEmbedUrl(tmdbId, season, episode)
}

export function cinetaroDetailUrl(
  tmdbId: string | number,
  origin = CINETARO_CATALOG_ORIGIN,
): string {
  return `${origin.replace(/\/$/, '')}/details/${encodeURIComponent(String(tmdbId))}?tv`
}

export function cinetaroWatchUrl(
  tmdbId: string | number,
  season: number,
  episode: number,
  origin = CINETARO_CATALOG_ORIGIN,
): string {
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  return `${origin.replace(/\/$/, '')}/watch/${encodeURIComponent(String(tmdbId))}?tv&s=${s}&ep=${e}`
}

export function cinetaroEpisodeId(
  tmdbId: string | number,
  season: number,
  episode: number,
): string {
  return `${tmdbId}-${Math.max(1, season)}-${Math.max(1, episode)}`
}

/** Direct Primus / cinextream embed (preferred in-app player URL). */
export function cinetaroCinextreamEmbedUrl(
  tmdbId: string | number,
  season: number,
  episode: number,
  options?: { noads?: boolean; autoPlay?: boolean },
): string {
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  const noads = options?.noads === true ? 1 : 0
  const autoPlay = options?.autoPlay === false ? 0 : 1
  return (
    `${CINETARO_EMBED_ORIGIN}/api/embed/tv/${encodeURIComponent(String(tmdbId))}/${s}/${e}` +
    `?noads=${noads}&autoPlay=${autoPlay}&autoplay=${autoPlay ? 'true' : 'false'}&asi=0`
  )
}

/** Movie detail page on Cinetaro (no `?tv`). */
export function cinetaroMovieDetailUrl(
  tmdbId: string | number,
  origin = CINETARO_CATALOG_ORIGIN,
): string {
  return `${origin.replace(/\/$/, '')}/details/${encodeURIComponent(String(tmdbId))}`
}

/** Cinextream movie embed — used when YTS has no torrent for a title. */
export function cinetaroCinextreamMovieEmbedUrl(
  tmdbId: string | number,
  options?: { noads?: boolean; autoPlay?: boolean },
): string {
  const noads = options?.noads === true ? 1 : 0
  const autoPlay = options?.autoPlay === false ? 0 : 1
  return (
    `${CINETARO_EMBED_ORIGIN}/api/embed/movie/${encodeURIComponent(String(tmdbId))}` +
    `?noads=${noads}&autoPlay=${autoPlay}&autoplay=${autoPlay ? 'true' : 'false'}&asi=0`
  )
}

export function cinetaroPlayerUrl(
  episodeId: string,
  serverId: string,
  serverType: 'sub' | 'dub',
  episode: number,
  origin = CINETARO_CATALOG_ORIGIN,
): string {
  const ep = Math.max(1, episode)
  return (
    `${origin.replace(/\/$/, '')}/src/player/${serverType}.php` +
    `?id=${encodeURIComponent(episodeId)}&server=${encodeURIComponent(serverId)}` +
    `&embed=true&ep=${ep}&skip=false&autoPlay=1&asi=0`
  )
}

export function parseCinetaroListHtml(
  html: string,
  origin = CINETARO_CATALOG_ORIGIN,
): TorrentPageLink[] {
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  const parts = html.split(/class="[^"]*flw-item[^"]*"/i).slice(1)

  for (const part of parts) {
    const href = part.match(/href="(\/details\/(\d+)\?tv)"/i)
    if (!href) continue
    const tmdbId = href[2]
    const path = href[1]
    const url = path.startsWith('http') ? path : `${origin.replace(/\/$/, '')}${path}`
    if (seen.has(url)) continue
    seen.add(url)

    const titleRaw =
      part.match(/data-title="([^"]+)"/i)?.[1] ||
      part.match(/class="[^"]*film-name[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      ''
    const title = stripTags(titleRaw).slice(0, 180)
    if (!title) continue

    const poster =
      part.match(/data-src="(https?:\/\/[^"]+)"/i)?.[1] ||
      part.match(/src="(https?:\/\/image\.tmdb\.org[^"]+)"/i)?.[1]

    const year =
      [...part.matchAll(/<span class="fdi-item">(\d{4})<\/span>/gi)].map((m) => m[1]).find(Boolean) ||
      ''
    const status =
      part.match(/<span class="fdi-item">(Ongoing Series|Completed Series|Returning Series)<\/span>/i)?.[1] ||
      ''
    const summary = ['TV Series', year, status].filter(Boolean).join(' · ')
    const releasedAt = year ? Date.parse(`${year}-01-01T00:00:00Z`) : undefined

    links.push({
      title,
      url,
      summary,
      poster,
      category: 'series',
      releasedAt: Number.isFinite(releasedAt) ? releasedAt : undefined,
      cinetaroTmdbId: tmdbId,
      rivestreamTmdbId: tmdbId,
    })
  }

  // JSON-LD fallback when flw-item markup changes.
  if (links.length === 0) {
    for (const block of html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    )) {
      try {
        const data = JSON.parse(block[1]) as {
          itemListElement?: Array<{ item?: { name?: string; url?: string; image?: string } }>
        }
        if (!Array.isArray(data.itemListElement)) continue
        for (const row of data.itemListElement) {
          const item = row.item
          if (!item?.url || !item.name) continue
          const tmdbId = cinetaroTmdbIdFromUrl(item.url)
          if (!tmdbId || seen.has(item.url)) continue
          seen.add(item.url)
          links.push({
            title: String(item.name).slice(0, 180),
            url: item.url.startsWith('http')
              ? item.url
              : `${origin.replace(/\/$/, '')}${item.url}`,
            summary: 'TV Series',
            poster: typeof item.image === 'string' ? item.image : undefined,
            category: 'series',
            cinetaroTmdbId: tmdbId,
            rivestreamTmdbId: tmdbId,
          })
        }
      } catch {
        /* ignore bad JSON-LD */
      }
    }
  }

  return links
}

async function fetchText(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  const { nativeFetchText } = await import('./nativeHttp')
  // Never pop Cloudflare Verify here — it steals the sports/embed WebView.
  // List scrapes fall back to TMDB when CF blocks.
  const result = await nativeFetchText(url, {
    quiet: true,
    preferWebView: true,
    allowUnlock: false,
    headers: {
      Accept: 'text/html,application/json',
      Referer: `${CINETARO_CATALOG_ORIGIN}/`,
    },
  })
  return { ok: result.ok, content: result.content, error: result.error }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** Build Cinetaro shelf links from TMDB (bypasses Cloudflare on list pages). */
export async function fetchCinetaroCatalogViaTmdb(
  origin = CINETARO_CATALOG_ORIGIN,
  maxTitles = CINETARO_TMDB_LIMIT,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  const { fetchTmdbTvCatalogLinks } = await import('./tmdbTv')
  const popular = await fetchTmdbTvCatalogLinks('popular')
  const airing = await fetchTmdbTvCatalogLinks('on_the_air')
  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  for (const src of [...(popular.links || []), ...(airing.links || [])]) {
    const tmdbId = String(src.rivestreamTmdbId || '').trim()
    if (!tmdbId || seen.has(tmdbId)) continue
    seen.add(tmdbId)
    links.push({
      title: src.title,
      url: cinetaroDetailUrl(tmdbId, origin),
      summary: [src.summary?.replace(/\s*·\s*TMDB\s*·\s*Rive/i, ''), 'Cinetaro', 'TMDB']
        .filter(Boolean)
        .join(' · '),
      poster: src.poster,
      category: 'series',
      releasedAt: src.releasedAt,
      cinetaroTmdbId: tmdbId,
      rivestreamTmdbId: tmdbId,
    })
    if (links.length >= maxTitles) break
  }
  return {
    links,
    error:
      links.length === 0
        ? popular.error || airing.error || 'TMDB returned no series for Cinetaro'
        : null,
  }
}

/** Paginate Cinetaro TV series listings (capped). Falls back to TMDB on CF block. */
export async function fetchCinetaroCatalogLinks(
  origin = CINETARO_CATALOG_ORIGIN,
  maxPages = CINETARO_CATALOG_PAGES,
): Promise<{ links: TorrentPageLink[]; error: string | null }> {
  // Android: skip HTML crawl (CF) and build the shelf from TMDB — same detail ids.
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      return fetchCinetaroCatalogViaTmdb(origin)
    }
  } catch {
    /* Electron / web — try HTML first */
  }

  const links: TorrentPageLink[] = []
  const seen = new Set<string>()
  let lastError: string | null = null

  for (let page = 1; page <= maxPages; page += 1) {
    const listUrl = cinetaroTvListPageUrl(origin, page)
    const result = await fetchText(listUrl)
    if (!result.ok || !result.content) {
      lastError = result.error || 'Cinetaro page unavailable'
      if (page === 1) break
      continue
    }
    const parsed = parseCinetaroListHtml(result.content, origin)
    let added = 0
    for (const link of parsed) {
      if (seen.has(link.url)) continue
      seen.add(link.url)
      links.push(link)
      added += 1
    }
    if (added === 0) break
    if (page < maxPages) await sleep(CINETARO_REQUEST_GAP_MS)
  }

  if (links.length === 0) {
    const viaTmdb = await fetchCinetaroCatalogViaTmdb(origin)
    if (viaTmdb.links.length > 0) return viaTmdb
    return { links: [], error: lastError || viaTmdb.error }
  }

  return {
    links,
    error: null,
  }
}

/** Episode list via TMDB (same ids Cinetaro uses). */
export async function fetchCinetaroEpisodeList(
  detailUrl: string,
  knownTmdbId?: string,
): Promise<{
  tmdbId: string
  episodes: CinetaroEpisodeInfo[]
  description?: string
  error?: string
}> {
  const tmdbId = knownTmdbId?.trim() || cinetaroTmdbIdFromUrl(detailUrl)
  if (!tmdbId) {
    return { tmdbId: '', episodes: [], error: 'Could not read Cinetaro TMDB id' }
  }

  const result = await fetchTmdbTvEpisodeList(tmdbId)
  if (result.episodes.length === 0) {
    return {
      tmdbId,
      episodes: [{ key: 'S01E01', season: 1, episode: 1, title: 'Episode 1' }],
      description: result.description,
      error: result.error || 'No episodes found',
    }
  }

  return {
    tmdbId,
    episodes: result.episodes,
    description: result.description,
  }
}

function parseServersPayload(raw: string): CinetaroServer[] {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    const out: CinetaroServer[] = []
    const pushGroup = (key: string, type: 'sub' | 'dub') => {
      const rows = data[key]
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const s = row as Record<string, unknown>
        const serverId = String(s.serverId || '').trim()
        const serverName = String(s.serverName || serverId).trim()
        if (!serverId || /download/i.test(serverId) || /download/i.test(serverName)) continue
        if (s.available === false || s.unavailable === true) continue
        out.push({ serverId, serverName, serverType: type, available: true })
      }
    }
    // Site maps softsub/hardsub → player sub.php; softdub/harddub → dub.php
    pushGroup('softsub', 'sub')
    pushGroup('hardsub', 'sub')
    pushGroup('softdub', 'dub')
    pushGroup('harddub', 'dub')
    return out
  } catch {
    return []
  }
}

function extractIframeSrc(html: string): string {
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)
  if (!m?.[1]) return ''
  return decodeHtmlEntities(m[1])
}

/** Resolve episode → cinextream embed (preferred) or Cinetaro watch page. */
export async function resolveCinetaroPlay(
  detailUrl: string,
  options?: {
    tmdbId?: string
    season?: number
    episode?: number
    serverId?: string
  },
): Promise<CinetaroPlayResolveResult> {
  const season = Math.max(1, options?.season ?? 1)
  const episode = Math.max(1, options?.episode ?? 1)
  const tmdbId = options?.tmdbId?.trim() || cinetaroTmdbIdFromUrl(detailUrl)
  if (!tmdbId) {
    return { ok: false, error: 'Missing Cinetaro TMDB id' }
  }

  // Prefer direct cinextream — works without clearing Cloudflare on cinetaro.to.
  const embedUrl = cinetaroCinextreamEmbedUrl(tmdbId, season, episode)
  // Android: don't probe through the scrape WebView. A probe while Verify is
  // open reloads the challenge, and the embed plays without the HTML check.
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      return { ok: true, url: embedUrl, tmdbId, season, episode, embed: true }
    }
  } catch {
    /* desktop — probe below */
  }
  const embedProbe = await fetchText(embedUrl)
  if (
    embedProbe.ok ||
    /player\.js|video|iframe|plyr|jwplayer/i.test(embedProbe.content || '')
  ) {
    return {
      ok: true,
      url: embedUrl,
      tmdbId,
      season,
      episode,
      embed: true,
    }
  }

  const episodeId = cinetaroEpisodeId(tmdbId, season, episode)
  const preferServer = options?.serverId || CINETARO_DEFAULT_SERVER
  const serversUrl =
    `${CINETARO_CATALOG_ORIGIN}/src/ajax/anime/server.php?episodeId=${encodeURIComponent(episodeId)}`
  const serversResult = await fetchText(serversUrl)
  let servers = serversResult.ok ? parseServersPayload(serversResult.content) : []
  if (servers.length === 0) {
    servers = [{ serverId: preferServer, serverName: 'Primus', serverType: 'sub', available: true }]
  }

  const chosen =
    servers.find((s) => s.serverId === preferServer) ||
    servers.find((s) => s.serverType === 'sub') ||
    servers[0]

  if (chosen) {
    const playerUrl = cinetaroPlayerUrl(episodeId, chosen.serverId, chosen.serverType, episode)
    const player = await fetchText(playerUrl)
    if (player.ok) {
      const iframe = extractIframeSrc(player.content)
      if (iframe) {
        return {
          ok: true,
          url: iframe,
          tmdbId,
          season,
          episode,
          embed: true,
        }
      }
    }
  }

  // Last resort: open cinextream anyway (in-app browser can complete any soft gate).
  return {
    ok: true,
    url: embedUrl,
    tmdbId,
    season,
    episode,
    embed: true,
  }
}
