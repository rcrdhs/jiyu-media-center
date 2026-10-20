/**
 * Nyaa.si search → magnets for anime (and other English-translated TV).
 * Used when RiveStream has metadata but no playable stream.
 */

import type { StreamItem } from '../types'
import {
  ANIME_SHELF_FULL_SHOWS,
  buildEpisodeChoices,
  cleanShowDisplayTitle,
  collapseEpisodeRowsToShows,
  normalizeShowKey,
  parseEpisodeKey,
  pickBestStream,
  scrapeTorrentLinks,
  type EpisodeChoice,
  type TorrentResult,
} from './torrents'
import { getConnectionDownlinkMbps, resolveRequestedQuality } from './viewingQuality'
import { isDesktopTorrentAvailable, isTorrentPlaybackAvailable, torrentStream } from './torrentBridge'
import { isNativeHttpPlatform, nativeFetchText } from './nativeHttp'
import {
  nyaaReleaseEpisodeKey,
  nyaaReleaseMatchesEpisode,
  nyaaReleaseSeasonConflicts,
} from './nyaaSeason'
import { shortHash, subsLog } from './subsLog'

export const NYAA_ORIGIN = 'https://nyaa.si'
/** Anime – English-translated */
export const NYAA_ANIME_EN_CATEGORY = '1_2'
/** Catalog source id for shelf-search hits (episode magnets + show hubs). */
export const NYAA_SEARCH_SOURCE_ID = 'nyaa-search'

export function nyaaSearchUrl(
  query: string,
  options?: { category?: string; sort?: 'seeders' | 'id'; order?: 'desc' | 'asc' },
): string {
  const q = String(query || '').trim()
  const category = options?.category || NYAA_ANIME_EN_CATEGORY
  const sort = options?.sort || 'seeders'
  const order = options?.order || 'desc'
  const params = new URLSearchParams({
    f: '0',
    c: category,
    q,
    s: sort,
    o: order,
  })
  return `${NYAA_ORIGIN}/?${params.toString()}`
}

async function fetchNyaaHtml(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url, { quiet: true })
    return { ok: result.ok, content: result.content || '', error: result.error || '' }
  }
  // Android: nyaa.si sends no CORS headers, so WebView fetch() from https://localhost
  // always fails (CapacitorHttp fetch patching is off). Go through native HTTP instead,
  // otherwise Nyaa search, episode play and the subtitle sidecar silently find nothing.
  if (isNativeHttpPlatform()) {
    try {
      const r = await nativeFetchText(url, {
        quiet: true,
        headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      })
      return { ok: r.ok, content: r.content || '', error: r.ok ? '' : r.error || `HTTP ${r.status}` }
    } catch (err) {
      return { ok: false, content: '', error: err instanceof Error ? err.message : 'Native fetch failed' }
    }
  }
  try {
    const res = await fetch(url)
    const content = await res.text()
    return { ok: res.ok, content, error: res.ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, content: '', error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

/** Decode common HTML entities in magnet hrefs scraped from Nyaa. */
function decodeMagnetHref(raw: string): string {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim()
}

function isHevcReleaseTitle(title: string): boolean {
  return /\b(x265|h\.?265|hevc)\b/i.test(title)
}

/**
 * Nyaa list rows put seeders in a bare numeric column (not "12 seeders"),
 * so the generic torrent scraper always read 0. Parse the table properly.
 */
function scrapeNyaaSearchResults(html: string): TorrentResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const byHash = new Map<string, TorrentResult>()

  for (const row of doc.querySelectorAll('tbody tr, table tr')) {
    const magnetEl = row.querySelector('a[href^="magnet:"]')
    const magnet = decodeMagnetHref(magnetEl?.getAttribute('href') || '')
    if (!/^magnet:\?/i.test(magnet)) continue
    const hash = magnetInfoHash(magnet)
    if (!hash) continue

    const titleEl =
      row.querySelector('a[href*="/view/"]') ||
      row.querySelector('td:nth-child(2) a') ||
      magnetEl
    const attrTitle = (titleEl?.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
    const textTitle = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim()
    const title =
      attrTitle.length >= textTitle.length && !/^anime\b/i.test(attrTitle)
        ? attrTitle
        : textTitle || attrTitle
    if (!title || /^anime\b/i.test(title)) continue

    const cells = [...row.querySelectorAll('td')].map((td) =>
      (td.textContent || '').replace(/\s+/g, ' ').trim(),
    )
    // Columns: category | name | links | size | date | seeders | leechers | downloads
    let seeders = 0
    let sizeBytes = 0
    if (cells.length >= 5) {
      const seedText = cells[cells.length - 3] || ''
      seeders = Number(String(seedText).replace(/,/g, '')) || 0
      const sizeText = cells[cells.length - 5] || cells.find((c) => /\d+(?:\.\d+)?\s*(GiB|GB|MiB|MB)/i.test(c)) || ''
      const sizeMatch = /(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB|KiB|KB)/i.exec(sizeText)
      if (sizeMatch) {
        const n = Number(sizeMatch[1]) || 0
        const unit = sizeMatch[2].toUpperCase()
        const mult =
          unit.startsWith('G') ? 1e9 : unit.startsWith('M') ? 1e6 : unit.startsWith('K') ? 1e3 : 1
        sizeBytes = Math.round(n * mult)
      }
    }

    const prev = byHash.get(hash)
    if (prev) {
      if (seeders > prev.seeders) prev.seeders = seeders
      if (sizeBytes > prev.sizeBytes) prev.sizeBytes = sizeBytes
      continue
    }
    byHash.set(hash, {
      title,
      uri: magnet,
      kind: 'magnet',
      sizeBytes,
      seeders,
      sourceLabel: 'Nyaa',
    })
    rememberNyaaRelease(hash, title, seeders)
  }

  return [...byHash.values()].sort(
    (a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes,
  )
}

/**
 * Pick a Nyaa release for playback: seeded H.264 first (Electron remuxes HEVC slowly),
 * otherwise highest seeders. Prefer known softsub groups (e.g. XeNoX) when present.
 */
const KNOWN_RELEASE_GROUPS =
  /^(subsplease|erai-?raws|ember|judas|asenshi|yameii|commie|horriblesubs|gsd|fff|varyg|toonshub)$/i

/**
 * Release group from "[Group] Title ..." or scene-style "... H 264-GROUP (Alt title)".
 * Returns '' when no group token is found.
 */
export function nyaaReleaseGroupName(title: string): string {
  const t = String(title || '').trim()
  const lead = /^\[\s*([^\]]+?)\s*\]/.exec(t)
  if (lead) return lead[1]!.trim()
  // Last "-GROUP" token followed by "(", "[", an extension or end of string.
  // "WEB-DL DDP2.0" / "- S02E19" don't match (space or digit after the dash).
  const trail = [...t.matchAll(/-([A-Za-z][A-Za-z0-9]{1,19})(?=\s*(?:[([]|\.(?:mkv|mp4)\b|$))/g)]
  return trail.length ? trail[trail.length - 1]![1]! : ''
}

function releaseGroupBoost(title: string): number {
  const t = String(title || '')
  // User-requested / common softsub crews — boost when they appear in the pool.
  if (/\[\s*xenox\s*\]|\bxenox\b/i.test(t)) return 40
  if (
    /\[\s*(subsplease|erai-?raws|ember|judas|asenshi|yameii|commie|horriblesubs|gsd|fff|toonshub)\s*\]/i.test(
      t,
    ) ||
    KNOWN_RELEASE_GROUPS.test(nyaaReleaseGroupName(t))
  ) {
    return 12
  }
  return 0
}

function pickNyaaRelease(
  group: TorrentResult[],
  downlinkMbps: number,
  preferredQuality?: number,
): TorrentResult | null {
  if (group.length === 0) return null
  const seeded = group.filter((r) => (r.seeders ?? 0) > 0)
  const pool = seeded.length > 0 ? seeded : group
  const avc = pool.filter((r) => !isHevcReleaseTitle(r.title))
  let use = avc.length > 0 ? avc : pool
  const boosted = use.filter((r) => releaseGroupBoost(r.title) > 0)
  if (boosted.length > 0) use = boosted
  const pick = pickBestStream(use, downlinkMbps, preferredQuality)
  if (pick?.result) return pick.result
  return (
    [...use].sort(
      (a, b) =>
        releaseGroupBoost(b.title) - releaseGroupBoost(a.title) ||
        b.seeders - a.seeders ||
        b.sizeBytes - a.sizeBytes,
    )[0] ?? null
  )
}

function releaseMatchesShow(releaseTitle: string, showTitle: string): boolean {
  const release = normalizeShowKey(releaseTitle)
  const show = normalizeShowKey(cleanShowDisplayTitle(showTitle) || showTitle)
  if (!release || !show) return false
  if (release.includes(show) || show.includes(release)) return true
  const words = show.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|of|a|an)$/i.test(w))
  if (words.length === 0) return false
  const hits = words.filter((w) => release.includes(w)).length
  return hits >= Math.min(2, words.length)
}

export async function searchNyaaTorrents(
  query: string,
  options?: { category?: string },
): Promise<{ ok: true; results: TorrentResult[]; pageUrl: string } | { ok: false; error: string }> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'Empty search' }
  const pageUrl = nyaaSearchUrl(q, { category: options?.category })
  const fetched = await fetchNyaaHtml(pageUrl)
  if (!fetched.ok || !fetched.content) {
    return { ok: false, error: fetched.error || 'Search failed' }
  }
  let results = scrapeNyaaSearchResults(fetched.content)
  // Fallback if DOM parse finds nothing (markup change) — still better than empty.
  if (results.length === 0) {
    results = scrapeTorrentLinks(fetched.content, 'Nyaa', pageUrl).map((r) => ({
      ...r,
      uri: r.kind === 'magnet' ? decodeMagnetHref(r.uri) : r.uri,
    }))
    const magnets = results.filter((r) => r.kind === 'magnet')
    if (magnets.length > 0) results = magnets
  }
  results.sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)
  return { ok: true, results, pageUrl }
}

function padEp(n: number, width = 2): string {
  return String(Math.max(0, Math.floor(n))).padStart(width, '0')
}

/** Accept SxxExx and fansub-style E06 / E6 keys from Nyaa titles. */
function isEpisodeChoiceKey(key: string): boolean {
  return /^S\d{2}E\d{1,3}$/i.test(key) || /^E\d{1,3}(?:\.\d+)?$/i.test(key)
}

/**
 * Map a parsed Nyaa token onto the SxxExx / E## space we look up.
 * Fansubs almost never use S01E06 — they use "Show - 06".
 */
function normalizeNyaaEpisodeKey(key: string, assumeSeason = 1): string | null {
  const raw = String(key || '').trim().toUpperCase()
  if (!raw) return null
  const sxx = /^S(\d{1,2})E(\d{1,3})$/i.exec(raw)
  if (sxx) return `S${padEp(Number(sxx[1]))}E${padEp(Number(sxx[2]))}`
  const eOnly = /^E(\d{1,3})(?:\.\d+)?$/i.exec(raw)
  if (eOnly) {
    // Absolute ep tags are treated as season 1 unless the release also has Sxx.
    return `S${padEp(assumeSeason)}E${padEp(Number(eOnly[1]))}`
  }
  return null
}

/** Queries aimed at one episode — what a human would type on Nyaa for S1E6. */
export function nyaaEpisodeSearchQueries(
  showTitle: string,
  season: number,
  episode: number,
): string[] {
  const show = (cleanShowDisplayTitle(showTitle) || showTitle).trim()
  if (!show) return []
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  const ep2 = padEp(e)
  const epRaw = String(e)
  const sxx = `S${padEp(s)}E${ep2}`
  const out = [
    `${show} ${sxx}`,
    `${show} ${ep2}`,
    `${show} - ${ep2}`,
    `${show} E${ep2}`,
    `${show} Episode ${epRaw}`,
    // Softsub crews that often tag the show + ep without SxxExx.
    `${show} ${ep2} XeNoX`,
    `XeNoX ${show} ${ep2}`,
    `${show} XeNoX`,
  ]
  if (epRaw !== ep2) {
    out.push(`${show} ${epRaw}`, `${show} - ${epRaw}`)
  }
  // Season 2+ absolute numbering sometimes keeps climbing (e.g. S2E1 → 13).
  if (s > 1) {
    out.push(`${show} S${padEp(s)} ${ep2}`, `${show} Season ${s} ${ep2}`)
  }
  return [...new Set(out.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean))]
}

/**
 * Search Nyaa for a show and collapse into one best magnet per SxxExx episode.
 */
export async function searchNyaaShowEpisodes(
  showTitle: string,
  options?: { query?: string; category?: string; minDistinctEpisodes?: number },
): Promise<
  { ok: true; episodes: EpisodeChoice[]; query: string } | { ok: false; error: string }
> {
  const display = cleanShowDisplayTitle(showTitle) || showTitle
  const query = String(options?.query || display).trim()
  if (!query) return { ok: false, error: 'Empty show title' }

  const searched = await searchNyaaTorrents(query, { category: options?.category })
  if (!searched.ok) return searched

  const filtered = searched.results.filter((r) => releaseMatchesShow(r.title, display))
  const pool = filtered.length > 0 ? filtered : searched.results
  if (pool.length === 0) return { ok: false, error: 'No releases found' }

  const downlink = getConnectionDownlinkMbps()
  const preferred = resolveRequestedQuality()

  // Group by episode, pick best (seeded AVC preferred), keep high-seed alternates.
  // Normalize fansub "Show - 06" (E06) → S01E06 so lookup by season/episode works —
  // unless the title states its season ("Show Season 3 - 1" → S03E01, not S01E01).
  const byEpisode = new Map<string, TorrentResult[]>()
  for (const result of pool) {
    const parsed = parseEpisodeKey(result.title)
    if (!parsed || !isEpisodeChoiceKey(parsed)) continue
    const key = nyaaReleaseEpisodeKey(result.title, parsed) || parsed
    if (!/^S\d{2}E\d{2,3}$/i.test(key)) continue
    const list = byEpisode.get(key)
    if (list) list.push(result)
    else byEpisode.set(key, [result])
  }
  if (byEpisode.size < (options?.minDistinctEpisodes ?? 1)) {
    // Fall back to generic builder for odd title formats.
    const episodes = buildEpisodeChoices(pool, downlink, preferred, {
      minDistinctEpisodes: options?.minDistinctEpisodes ?? 1,
    })
      .map((ep) => {
        const key = nyaaReleaseEpisodeKey(ep.title, ep.key) || normalizeNyaaEpisodeKey(ep.key) || ep.key
        return { ...ep, key }
      })
      .filter((ep) => /^S\d{2}E\d{2,3}$/i.test(ep.key))
    if (episodes.length === 0) {
      return { ok: false, error: 'No episode-tagged releases found' }
    }
    episodes.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0) || a.key.localeCompare(b.key))
    return { ok: true, episodes, query }
  }

  const episodes: EpisodeChoice[] = []
  for (const [key, group] of byEpisode) {
    const primary = pickNyaaRelease(group, downlink, preferred)
    if (!primary) continue
    const alternates = [...group]
      .filter((r) => r.uri !== primary.uri && (r.seeders ?? 0) > 0)
      .sort((a, b) => {
        const aHevc = isHevcReleaseTitle(a.title) ? 1 : 0
        const bHevc = isHevcReleaseTitle(b.title) ? 1 : 0
        return aHevc - bHevc || b.seeders - a.seeders || b.sizeBytes - a.sizeBytes
      })
      .map((r) => r.uri)
      .filter((uri, i, arr) => arr.indexOf(uri) === i)
      .slice(0, 6)
    episodes.push({
      key,
      title: primary.title,
      torrentUri: primary.uri,
      quality: /\b(2160|1080|720|480)p\b/i.exec(primary.title)
        ? Number(/\b(2160|1080|720|480)p\b/i.exec(primary.title)![1])
        : 0,
      seeders: primary.seeders,
      alternates: alternates.length ? alternates : undefined,
    })
  }

  if (episodes.length === 0) {
    return { ok: false, error: 'No episode-tagged releases found' }
  }

  // Chronological for the player; seed counts still drive which magnet is primary.
  episodes.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }))
  return { ok: true, episodes, query }
}

export function findNyaaEpisode(
  episodes: EpisodeChoice[],
  season: number,
  episode: number,
): EpisodeChoice | null {
  const wantSeason = Math.max(1, season)
  const wantEp = Math.max(1, episode)
  const key = `S${padEp(wantSeason)}E${padEp(wantEp)}`
  // A release that states another season ("… Season 3 - 1") never stands in for S01E01.
  const exact = episodes.find(
    (ep) => ep.key.toUpperCase() === key && !nyaaReleaseSeasonConflicts(ep.title, wantSeason),
  )
  if (exact) return exact

  // Season-less "Show - 06" still matches episode 6 of the wanted season (absolute numbering).
  const loose = episodes.find(
    (ep) =>
      nyaaReleaseMatchesEpisode(ep.title, ep.key, wantSeason, wantEp) ||
      nyaaReleaseMatchesEpisode(ep.title, parseEpisodeKey(ep.title), wantSeason, wantEp),
  )
  return loose || null
}

/** Merge unique episode choices (prefer higher seeders for the same key). */
function mergeNyaaEpisodeChoices(base: EpisodeChoice[], extra: EpisodeChoice[]): EpisodeChoice[] {
  const byKey = new Map<string, EpisodeChoice>()
  for (const ep of [...base, ...extra]) {
    const key = (normalizeNyaaEpisodeKey(ep.key) || ep.key).toUpperCase()
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...ep, key: normalizeNyaaEpisodeKey(ep.key) || ep.key })
      continue
    }
    const preferNew = (ep.seeders ?? 0) > (prev.seeders ?? 0)
    const primary = preferNew ? ep : prev
    const secondary = preferNew ? prev : ep
    const alternates = [
      secondary.torrentUri,
      ...(primary.alternates || []),
      ...(secondary.alternates || []),
    ].filter(
      (uri, i, arr) => Boolean(uri) && uri !== primary.torrentUri && arr.indexOf(uri) === i,
    )
    byKey.set(key, {
      ...primary,
      key: normalizeNyaaEpisodeKey(primary.key) || primary.key,
      alternates: alternates.length ? alternates.slice(0, 6) : undefined,
    })
  }
  return [...byKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/** Resolve a specific episode (+ full Nyaa playlist) for torrent playback. */
export async function resolveNyaaEpisodePlay(options: {
  showTitle: string
  season: number
  episode: number
  query?: string
}): Promise<
  | {
      ok: true
      choice: EpisodeChoice
      episodes: EpisodeChoice[]
      playIndex: number
      query: string
    }
  | { ok: false; error: string }
> {
  const season = Math.max(1, options.season)
  const episode = Math.max(1, options.episode)
  const showTitle = options.showTitle

  // 1) Broad show search (fills the episode drawer when possible).
  let episodes: EpisodeChoice[] = []
  let queryUsed = String(options.query || cleanShowDisplayTitle(showTitle) || showTitle).trim()
  const found = await searchNyaaShowEpisodes(showTitle, {
    query: options.query,
    minDistinctEpisodes: 1,
  })
  if (found.ok) {
    episodes = found.episodes
    queryUsed = found.query
  }

  let choice = findNyaaEpisode(episodes, season, episode)

  // 2) Targeted SxE / ep-number searches — what you'd type on Nyaa for S1E6,
  //    not the human episode title ("A Day Off in Roa").
  if (!choice) {
    const variants = nyaaEpisodeSearchQueries(showTitle, season, episode)
    for (const q of variants) {
      const targeted = await searchNyaaShowEpisodes(showTitle, {
        query: q,
        minDistinctEpisodes: 1,
      })
      if (!targeted.ok) continue
      episodes = mergeNyaaEpisodeChoices(episodes, targeted.episodes)
      choice = findNyaaEpisode(targeted.episodes, season, episode) || findNyaaEpisode(episodes, season, episode)
      if (choice) {
        queryUsed = targeted.query
        break
      }
      // Even if grouping missed, pick a raw release whose title is clearly this ep.
      const raw = await searchNyaaTorrents(q)
      if (!raw.ok) continue
      const display = cleanShowDisplayTitle(showTitle) || showTitle
      const pool = raw.results.filter((r) => releaseMatchesShow(r.title, display))
      const use = pool.length > 0 ? pool : raw.results
      const downlink = getConnectionDownlinkMbps()
      const preferred = resolveRequestedQuality()
      const matching = use.filter((r) =>
        nyaaReleaseMatchesEpisode(r.title, parseEpisodeKey(r.title), season, episode),
      )
      const pick = pickNyaaRelease(matching, downlink, preferred)
      if (!pick) continue
      const key = `S${padEp(season)}E${padEp(episode)}`
      const crafted: EpisodeChoice = {
        key,
        title: pick.title,
        torrentUri: pick.uri,
        quality: /\b(2160|1080|720|480)p\b/i.exec(pick.title)
          ? Number(/\b(2160|1080|720|480)p\b/i.exec(pick.title)![1])
          : 0,
        seeders: pick.seeders,
        alternates: matching
          .filter((r) => r.uri !== pick.uri)
          .sort((a, b) => b.seeders - a.seeders)
          .map((r) => r.uri)
          .slice(0, 6),
      }
      episodes = mergeNyaaEpisodeChoices(episodes, [crafted])
      choice = crafted
      queryUsed = q
      break
    }
  }

  if (!choice) {
    return {
      ok: false,
      error: `No release for S${padEp(season)}E${padEp(episode)}`,
    }
  }
  const playIndex = Math.max(
    0,
    episodes.findIndex((ep) => ep.key === choice!.key && ep.torrentUri === choice!.torrentUri),
  )
  return {
    ok: true,
    choice,
    episodes: episodes.length > 0 ? episodes : [choice],
    playIndex: playIndex >= 0 ? playIndex : 0,
    query: queryUsed,
  }
}

/** Magnets to try for one Nyaa episode (primary + alternates). */
export function nyaaTorrentCandidates(choice: EpisodeChoice): string[] {
  return [choice.torrentUri, ...(choice.alternates || [])].filter(
    (uri, i, arr) => Boolean(uri) && arr.indexOf(uri) === i,
  )
}

/** True when we should prefer Nyaa magnets over a Rive embed shell. */
export function shouldTryNyaaForItem(item: {
  category?: string
  tags?: string[]
  torrentSourceId?: string
}): boolean {
  if (item.category === 'anime') return true
  if (item.tags?.some((t) => /^anime$/i.test(String(t)))) return true
  return false
}

function magnetInfoHash(magnet: string): string | null {
  const m = /urn:btih:([a-z0-9]{32,40})/i.exec(magnet)
  return m ? m[1]!.toLowerCase() : null
}

/** Parse "12 seeders · Nyaa" / "up to 12 seeders" style counts on catalog rows. */
export function seedersFromItemDescription(description?: string): number {
  const m = /(?:up to\s+)?(\d[\d,]*)\s*seeders?\b/i.exec(String(description || ''))
  return m ? Number(m[1]!.replace(/,/g, '')) || 0 : 0
}

/** One Nyaa magnet → anime catalog row (used for ShowPage sibling episode lists). */
export function nyaaResultToStreamItem(result: TorrentResult): StreamItem | null {
  const uri = String(result.uri || '').trim()
  if (!/^magnet:\?/i.test(uri)) return null
  const hash = magnetInfoHash(uri)
  if (!hash) return null
  const seeds = Number(result.seeders) || 0
  return {
    id: `nyaa-${hash}`,
    title: result.title,
    description: seeds > 0 ? `${seeds} seeders` : 'Torrent',
    category: 'anime',
    url: uri,
    tags: ['anime', 'nyaa', 'torrent'],
    source: 'Torrent',
    sourceKind: 'torrent',
    transport: 'torrent',
    torrentUri: uri,
    detailUrl: uri,
    torrentSourceId: NYAA_SEARCH_SOURCE_ID,
    // Higher seeders float to the top of newest-first shelves / collapse picks.
    releasedAt: Date.now() + Math.min(seeds, 50_000),
  }
}

/**
 * Shelf search fallback: Nyaa → episode magnets + collapsed show hubs.
 * Results are ranked by seeders (highest first). Prefer seeded H.264 when present.
 */
export async function searchNyaaAnimeForShelf(query: string): Promise<
  | { ok: true; shows: StreamItem[]; episodes: StreamItem[]; query: string }
  | { ok: false; error: string }
> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'Empty search' }

  const searched = await searchNyaaTorrents(q)
  if (!searched.ok) return searched

  // Prefer live swarms; keep zero-seed only if nothing better exists.
  const seeded = searched.results.filter((r) => (r.seeders ?? 0) > 0)
  const pool = seeded.length > 0 ? seeded : searched.results

  const episodes = pool
    .map((r) => nyaaResultToStreamItem(r))
    .filter((item): item is StreamItem => Boolean(item))
    .sort(
      (a, b) =>
        seedersFromItemDescription(b.description) - seedersFromItemDescription(a.description),
    )
  if (episodes.length === 0) {
    return { ok: false, error: 'No source results for this search.' }
  }

  const shows = collapseEpisodeRowsToShows(episodes)
    .map((item) => {
      const title = cleanShowDisplayTitle(item.title) || item.title
      const showKey = normalizeShowKey(title)
      const siblings = episodes.filter((ep) => normalizeShowKey(ep.title) === showKey)
      const maxSeeds = Math.max(
        0,
        ...siblings.map((ep) => seedersFromItemDescription(ep.description)),
        seedersFromItemDescription(item.description),
      )
      const epCount = new Set(siblings.map((ep) => parseEpisodeKey(ep.title)).filter(Boolean)).size
      const tags = new Set([
        ...(item.tags ?? []),
        'anime',
        ANIME_SHELF_FULL_SHOWS,
        'nyaa',
        'torrent',
      ])
      return {
        ...item,
        title,
        description: [
          epCount > 0 ? `${epCount} episode${epCount === 1 ? '' : 's'}` : '',
          maxSeeds > 0 ? `up to ${maxSeeds} seeders` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        tags: [...tags],
        source: 'Torrent',
        sourceKind: 'torrent' as const,
        transport: 'torrent' as const,
        torrentSourceId: NYAA_SEARCH_SOURCE_ID,
        releasedAt: Date.now() + Math.min(maxSeeds, 50_000),
      }
    })
    .sort(
      (a, b) =>
        seedersFromItemDescription(b.description) - seedersFromItemDescription(a.description) ||
        a.title.localeCompare(b.title),
    )

  if (shows.length === 0) {
    return { ok: false, error: 'No shows found for this search.' }
  }

  return { ok: true, shows, episodes, query: q }
}

const NYAA_SUB_SIDECAR_TIMEOUT_MS = 18_000
const NYAA_SUB_SIDECAR_BUDGET_MS = 22_000
/** Desktop: start the next release in parallel once the first is this slow (0.3.60 behaviour). */
const NYAA_SUB_SIDECAR_STAGGER_MS = 15_000
/** Desktop runs two releases at once; Android (phone bandwidth) runs one at a time. */
const NYAA_SUB_SIDECAR_DESKTOP_PARALLEL = 2
/**
 * A subtitle release that has produced nothing (no metadata / no bytes → no subtitle URL)
 * after this long is treated as dead: the next candidate starts and it is not re-armed.
 * A late success from it is still used.
 */
const NYAA_SUB_SIDECAR_STALL_MS = 45_000
/** How long a given-up release stays out of the candidate list (also across "Retry Subs"). */
const NYAA_SUB_DEAD_TTL_MS = 15 * 60 * 1000

/**
 * English-dub-only release ("[English Dub]", "Dubbed", "ENG DUB"): its English
 * track is usually Signs & Songs only, so it is useless as a dialogue subtitle
 * source. Dual-audio / multi-sub packs still carry full subs and are allowed.
 * Playback picks are unaffected (dubs are fine to watch).
 */
export function isDubOnlyRelease(title: string): boolean {
  const t = String(title || '')
  if (!/\b(?:eng(?:lish)?[\s._-]*)?dub(?:bed)?\b/i.test(t)) return false
  return !/\b(dual[\s._-]?audio|multi[\s._-]?audio|multi[\s._-]?subs?|m[\s._-]?subs)\b/i.test(t)
}

export function prefersSoftsubRelease(title: string): number {
  const t = String(title || '')
  let score = 0
  // Strong signals only. Small bonuses (Dual, JAP, group, 1080p) used to outrank a
  // higher-seeded Multi-Subs release and sent the sidecar to a slow swarm first.
  if (/\bmulti[\s._-]?subs?\b/i.test(t) || /\bm[\s._-]?subs\b/i.test(t)) score += 40
  else if (/\bsoft[\s._-]?sub/i.test(t)) score += 35
  if (isDubOnlyRelease(t)) score -= 100
  return score
}

/** Scraped title/seeders per info-hash so alternates can be ranked by their own names. */
const nyaaReleaseMeta = new Map<string, { title: string; seeders: number }>()
function rememberNyaaRelease(hash: string, title: string, seeders: number) {
  if (!hash || !title) return
  nyaaReleaseMeta.set(hash, { title, seeders })
  if (nyaaReleaseMeta.size > 2000) {
    const first = nyaaReleaseMeta.keys().next().value
    if (first) nyaaReleaseMeta.delete(first)
  }
}

/** Releases whose file turned out to have no dialogue softsubs (signs-only / none). */
const unusableSubtitleHashes = new Set<string>()
/** subtitleUrl handed to the player -> info-hash of the sidecar torrent that produced it. */
const sidecarHashBySubtitleUrl = new Map<string, string>()

function subtitleUrlKey(url: string): string {
  return String(url || '').replace(/([?&])(t|force)=[^&]*/g, '$1').replace(/[?&]+$/, '')
}

/**
 * Player reports "no subtitle track" for a sidecar URL: skip that release on the
 * next sidecar attempt. Returns the info-hash when the URL came from the sidecar.
 */
export function markNyaaSubtitleSourceUnusable(subtitleUrl: string): string | null {
  const key = subtitleUrlKey(subtitleUrl)
  const hash =
    sidecarHashBySubtitleUrl.get(key) ||
    (/[?&]source=([a-f0-9]{40})/i.exec(key)?.[1] || '').toLowerCase() ||
    null
  if (hash) {
    unusableSubtitleHashes.add(hash)
    subsLog('nyaa.sidecar.unusable', {
      hash: shortHash(hash),
      title: nyaaReleaseMeta.get(hash)?.title,
      reason: 'no dialogue subtitle track in release — skipping it',
    })
  }
  return sidecarHashBySubtitleUrl.has(key) ? hash : null
}

/** Sidecar releases given up on (stalled / dead swarm) → when, so they are not re-armed. */
const deadSubtitleHashes = new Map<string, number>()

function isDeadSubtitleHash(hash: string): boolean {
  const at = deadSubtitleHashes.get(hash)
  if (at == null) return false
  if (Date.now() - at > NYAA_SUB_DEAD_TTL_MS) {
    deadSubtitleHashes.delete(hash)
    return false
  }
  return true
}

/** 2 = seeded, 1 = seeders unknown, 0 = Nyaa listed 0 seeders (dead swarm, try last). */
function seedTier(seeders: number | null): number {
  if (seeders == null) return 1
  return seeders > 0 ? 2 : 0
}

/**
 * Order sidecar candidates: the episode search's own pick (candidates[0]) first, then
 * the rest by seeders; the softsub signal only breaks seeder ties. Dub-only releases
 * and releases already found to have no usable track are dropped.
 */
export function rankNyaaSubtitleCandidates(
  candidates: Array<{ uri: string; title?: string; seeders?: number }>,
  opts?: { season?: number },
): Array<{ uri: string; title: string; seeders: number; score: number }> {
  const primaryUri = candidates[0]?.uri
  return candidates
    .map((c) => {
      const hash = magnetInfoHash(c.uri) || ''
      const meta = hash ? nyaaReleaseMeta.get(hash) : undefined
      const title = meta?.title || c.title || ''
      const known = meta?.seeders ?? c.seeders
      const seeders = typeof known === 'number' && Number.isFinite(known) ? known : null
      return { uri: c.uri, hash, title, seeders, score: prefersSoftsubRelease(title) }
    })
    .filter((c, i, arr) => Boolean(c.uri) && arr.findIndex((x) => x.uri === c.uri) === i)
    .filter((c) => !(c.hash && unusableSubtitleHashes.has(c.hash)))
    .filter((c) => !(c.hash && isDeadSubtitleHash(c.hash)))
    .filter((c) => !isDubOnlyRelease(c.title))
    // Wrong-season packs ("… Season 3 - 1" for S01E01) never feed subtitles.
    .filter((c) => !(opts?.season && c.title && nyaaReleaseSeasonConflicts(c.title, opts.season)))
    .sort(
      (a, b) =>
        // 0-seeder releases go last, even when they were the episode pick.
        seedTier(b.seeders) - seedTier(a.seeders) ||
        Number(b.uri === primaryUri) - Number(a.uri === primaryUri) ||
        (b.seeders ?? 0) - (a.seeders ?? 0) ||
        b.score - a.score,
    )
    .map(({ uri, title, seeders, score }) => ({ uri, title, seeders: seeders ?? 0, score }))
}

/**
 * Pull softsubs from a Nyaa release without switching the video URL.
 * Used when Movy (or another direct HLS source) has no subtitle track.
 * Hard budget — dead swarms must not hang the player toast for minutes.
 */
/** One sidecar torrent start per magnet: a timed-out wait keeps running and is reused. */
type SidecarStream = {
  promise: Promise<void>
  done: boolean
  /** Settled with a subtitle URL. */
  subtitleUrl?: string
  subtitleKind?: 'file' | 'embedded'
  startedAt: number
  /** Gave up waiting (no subtitle URL within NYAA_SUB_SIDECAR_STALL_MS); next release starts. */
  stalled?: boolean
  /** Start settled without a subtitle URL at this time (cold swarm / no peers / error). */
  failedAt?: number
  /** Failure that retrying cannot fix (no playable video file / file has no subtitle source). */
  permanent?: boolean
  /** Starts so far for this magnet (1 = first try). Reset by manual Retry Subs. */
  attempts: number
}
/** A failed (not permanent) start may be tried again after this long… */
export const NYAA_SUB_SIDECAR_RETRY_AFTER_MS = 3 * 60 * 1000
/** …up to this many starts in total per magnet (automatic retries only). */
export const NYAA_SUB_SIDECAR_MAX_ATTEMPTS = 3

type SidecarRetryState = Pick<SidecarStream, 'done' | 'subtitleUrl' | 'failedAt' | 'permanent' | 'attempts'>

/**
 * Classify a settled start without a subtitle URL. Permanent only when the torrent itself
 * cannot help: no playable video file, or it started fine but has no subtitle source.
 * Timeouts / no peers / IPC errors are retryable (a cold swarm may warm up).
 */
export function isPermanentSidecarFailure(result: { ok: boolean; error?: string } | null): boolean {
  if (!result) return false
  if (result.ok) return true
  return /no playable video file/i.test(String(result.error || ''))
}

/** Failed start that automatic retries will try again later (cool-down may still be running). */
export function isSidecarRetryPending(s: SidecarRetryState | undefined): boolean {
  return Boolean(
    s &&
      s.done &&
      !s.subtitleUrl &&
      !s.permanent &&
      s.failedAt != null &&
      s.attempts < NYAA_SUB_SIDECAR_MAX_ATTEMPTS,
  )
}

/** Failed start whose cool-down is over: startSidecarStream will start it again. */
export function isSidecarRetryReady(s: SidecarRetryState | undefined, now = Date.now()): boolean {
  return isSidecarRetryPending(s) && now - (s!.failedAt as number) >= NYAA_SUB_SIDECAR_RETRY_AFTER_MS
}

const sidecarStreams = new Map<string, SidecarStream>()
/** Notified whenever any sidecar torrent start settles (ready or failed). */
const sidecarSettleListeners = new Set<() => void>()

/** Subscribe to sidecar settles so the player can attach subs the moment they exist. */
export function onNyaaSubtitleSidecarSettled(listener: () => void): () => void {
  sidecarSettleListeners.add(listener)
  return () => {
    sidecarSettleListeners.delete(listener)
  }
}
/** Ranked candidate releases per episode, so background retries don't re-search Nyaa. */
const sidecarCandidatesByEpisode = new Map<
  string,
  { at: number; candidates: Array<{ uri: string; title?: string; seeders?: number }> }
>()
const SIDECAR_CANDIDATE_TTL_MS = 30 * 60 * 1000
/** Settled successes go stale (torrent may be swept); failures are kept so they never restart. */
const SIDECAR_SUCCESS_TTL_MS = 30 * 60 * 1000
const NYAA_SUB_SIDECAR_MAX_RELEASES = 3

function sidecarEpisodeKey(o: { showTitle: string; season: number; episode: number }): string {
  return `${normalizeShowKey(cleanShowDisplayTitle(o.showTitle) || o.showTitle)}|${o.season}|${o.episode}`
}

function logSidecarFailure(entry: SidecarStream, hash: string | null, ms: number, error?: string) {
  const willRetry = isSidecarRetryPending({ ...entry, done: true })
  subsLog('nyaa.sidecar.failed', {
    hash: shortHash(hash),
    ms,
    error,
    attempt: entry.attempts,
    permanent: Boolean(entry.permanent),
    retryInMs: willRetry ? NYAA_SUB_SIDECAR_RETRY_AFTER_MS : undefined,
    reason: entry.permanent
      ? 'release cannot provide subtitles — not retried'
      : willRetry
        ? 'start failed (cold swarm / timeout) — retry after cool-down'
        : `start failed ${entry.attempts}x — giving up on this release`,
  })
}

/** Log an episode-level stop reason once (background polls would repeat it every few s). */
const sidecarEpisodeLastLog = new Map<string, string>()
function logSidecarEpisodeOnce(
  options: { showTitle: string; season: number; episode: number },
  event: string,
  reason: string,
) {
  const key = sidecarEpisodeKey(options)
  if (sidecarEpisodeLastLog.get(key) === `${event}|${reason}`) return
  sidecarEpisodeLastLog.set(key, `${event}|${reason}`)
  if (sidecarEpisodeLastLog.size > 200) {
    const first = sidecarEpisodeLastLog.keys().next().value
    if (first) sidecarEpisodeLastLog.delete(first)
  }
  subsLog(event, {
    show: options.showTitle,
    season: options.season,
    episode: options.episode,
    reason,
  })
}

function startSidecarStream(uri: string): SidecarStream {
  const existing = sidecarStreams.get(uri)
  const staleSuccess = Boolean(
    existing?.done && existing.subtitleUrl && Date.now() - existing.startedAt > SIDECAR_SUCCESS_TTL_MS,
  )
  const retry = isSidecarRetryReady(existing)
  if (existing && !staleSuccess && !retry) {
    return existing
  }
  const attempts = retry && existing ? existing.attempts + 1 : 1
  const entry: SidecarStream = { promise: Promise.resolve(), done: false, startedAt: Date.now(), attempts }
  const hash = magnetInfoHash(uri)
  const meta = hash ? nyaaReleaseMeta.get(hash) : undefined
  subsLog(retry ? 'nyaa.sidecar.retry' : 'nyaa.sidecar.start', {
    hash: shortHash(hash),
    title: meta?.title,
    seeders: meta?.seeders,
    attempt: attempts,
    maxAttempts: NYAA_SUB_SIDECAR_MAX_ATTEMPTS,
    sinceFailMs: retry && existing?.failedAt ? Date.now() - existing.failedAt : undefined,
  })
  entry.promise = torrentStream(uri, { keepOthers: true, subtitleOnly: true })
    .then((result) => {
      const subtitleUrl = result.ok ? (result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl) : undefined
      const ms = Date.now() - entry.startedAt
      if (subtitleUrl) {
        entry.subtitleUrl = subtitleUrl
        entry.subtitleKind = result.subtitleKind ?? result.playlist?.[0]?.subtitleKind
        if (hash) {
          sidecarHashBySubtitleUrl.set(subtitleUrlKey(subtitleUrl), hash)
          // A late success from a release we had given up on is still good.
          deadSubtitleHashes.delete(hash)
        }
        subsLog('nyaa.sidecar.ready', {
          hash: shortHash(hash),
          ms,
          kind: entry.subtitleKind,
          late: Boolean(entry.stalled),
        })
      } else {
        entry.failedAt = Date.now()
        entry.permanent = isPermanentSidecarFailure(result)
        logSidecarFailure(entry, hash, ms, result.ok ? 'no subtitle URL in torrent' : result.error)
      }
    })
    .catch((err: unknown) => {
      // Thrown start (IPC / bridge error): retryable, like a timeout.
      entry.failedAt = Date.now()
      entry.permanent = false
      logSidecarFailure(
        entry,
        hash,
        Date.now() - entry.startedAt,
        err instanceof Error ? err.message : String(err),
      )
    })
    .finally(() => {
      entry.done = true
      for (const listener of [...sidecarSettleListeners]) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
    })
  sidecarStreams.set(uri, entry)
  return entry
}

async function sidecarCandidateUris(
  options: { showTitle: string; season: number; episode: number },
  started: number,
  budgetMs: number,
): Promise<string[] | null> {
  const key = sidecarEpisodeKey(options)
  let cached = sidecarCandidatesByEpisode.get(key)
  if (!cached || Date.now() - cached.at > SIDECAR_CANDIDATE_TTL_MS) {
    const nyaa = await resolveNyaaEpisodePlay({
      showTitle: options.showTitle,
      season: options.season,
      episode: options.episode,
    })
    if (!nyaa.ok) {
      subsLog('nyaa.search', {
        show: options.showTitle,
        season: options.season,
        episode: options.episode,
        ok: false,
        error: nyaa.error,
      })
      return null
    }
    cached = {
      at: Date.now(),
      candidates: [
        { uri: nyaa.choice.torrentUri, title: nyaa.choice.title, seeders: nyaa.choice.seeders },
        ...(nyaa.choice.alternates || []).map((uri) => ({ uri })),
      ],
    }
    sidecarCandidatesByEpisode.set(key, cached)
    const preview = rankNyaaSubtitleCandidates(cached.candidates, { season: options.season })
    subsLog('nyaa.search', {
      show: options.showTitle,
      season: options.season,
      episode: options.episode,
      ok: true,
      query: nyaa.query,
      chosen: nyaa.choice.title,
      chosenSeeders: nyaa.choice.seeders,
      candidates: preview
        .slice(0, NYAA_SUB_SIDECAR_MAX_RELEASES)
        .map((c) => `${c.seeders}s ${c.title || shortHash(magnetInfoHash(c.uri))}`),
      dropped: cached.candidates.length - preview.length,
    })
    if (Date.now() - started > budgetMs) {
      return []
    }
  }
  // Re-rank every time: releases marked unusable / given up since the last call drop out.
  const ranked = rankNyaaSubtitleCandidates(cached.candidates, { season: options.season })
    .map((c) => c.uri)
    .slice(0, NYAA_SUB_SIDECAR_MAX_RELEASES)
  return ranked
}

/**
 * Give up on sidecar releases that have produced no subtitle URL for NYAA_SUB_SIDECAR_STALL_MS
 * (no metadata / 0 bytes from a dead swarm). The torrent start is not cancelled (it may share
 * a hash with the playing torrent); its late success is still used, but it no longer counts
 * as pending and is not re-armed, so the next candidate starts.
 */
function markStalledSidecars(uris: string[]): void {
  const now = Date.now()
  for (const uri of uris) {
    const s = sidecarStreams.get(uri)
    if (!s || s.done || s.stalled) continue
    if (now - s.startedAt < NYAA_SUB_SIDECAR_STALL_MS) continue
    s.stalled = true
    const hash = magnetInfoHash(uri)
    if (hash) deadSubtitleHashes.set(hash, now)
    subsLog('nyaa.sidecar.stalled', {
      hash: shortHash(hash),
      title: hash ? nyaaReleaseMeta.get(hash)?.title : undefined,
      ms: now - s.startedAt,
      reason: 'no subtitle within 45s (no metadata / no data) — moving to next release',
    })
  }
}

/**
 * Manual "Retry Subs": forget which releases failed or were found unusable for this
 * episode so they are tried again (a slow swarm may have caught up since). Releases
 * still starting keep running and are reused.
 */
export function resetNyaaSubtitleSidecarFailures(options: {
  showTitle: string
  season: number
  episode: number
}): void {
  const cached = sidecarCandidatesByEpisode.get(sidecarEpisodeKey(options))
  if (!cached) return
  let rearmed = 0
  let undead = 0
  for (const c of cached.candidates) {
    const hash = magnetInfoHash(c.uri)
    if (hash) {
      unusableSubtitleHashes.delete(hash)
      // Manual retry always re-arms, even a release given up on in the last 15 min.
      if (deadSubtitleHashes.delete(hash)) undead++
    }
    const s = sidecarStreams.get(c.uri)
    if (s?.done) {
      // Dropping the entry also resets failedAt / attempts / permanent.
      if (s.subtitleUrl) sidecarHashBySubtitleUrl.delete(subtitleUrlKey(s.subtitleUrl))
      sidecarStreams.delete(c.uri)
      rearmed++
    }
  }
  sidecarEpisodeLastLog.delete(sidecarEpisodeKey(options))
  subsLog('nyaa.sidecar.rearm', {
    show: options.showTitle,
    season: options.season,
    episode: options.episode,
    rearmed,
    undead,
    reason: 'manual Retry Subs',
  })
}

/**
 * Still worth waiting for this episode's sidecar: a release torrent is still starting,
 * or a ranked release has not been tried yet. False once every candidate failed or
 * the Nyaa search found nothing.
 */
export function isNyaaSubtitleSidecarPending(options: {
  showTitle: string
  season: number
  episode: number
}): boolean {
  if (!isTorrentPlaybackAvailable()) return false
  const cached = sidecarCandidatesByEpisode.get(sidecarEpisodeKey(options))
  if (!cached) return false
  const allUris = cached.candidates.map((c) => c.uri)
  markStalledSidecars(allUris)
  const uris = rankNyaaSubtitleCandidates(cached.candidates, { season: options.season })
    .map((c) => c.uri)
    .slice(0, NYAA_SUB_SIDECAR_MAX_RELEASES)
  // Untried, starting, succeeded, or failed-but-retryable (cool-down / attempts left).
  // Bounded: retries stop after NYAA_SUB_SIDECAR_MAX_ATTEMPTS and the player's own window.
  const pending = uris.some((uri) => {
    const s = sidecarStreams.get(uri)
    return !s || (!s.done && !s.stalled) || Boolean(s.subtitleUrl) || isSidecarRetryPending(s)
  })
  // A given-up (stalled) release that is still starting may yet deliver: keep listening
  // until main / Android settles it (their own timeouts bound this).
  const stillRunning = allUris.some((uri) => {
    const s = sidecarStreams.get(uri)
    return Boolean(s && !s.done)
  })
  const lateSuccess = allUris.some((uri) => Boolean(sidecarStreams.get(uri)?.subtitleUrl))
  return pending || stillRunning || lateSuccess
}

/**
 * Pull softsubs from a Nyaa release without switching the video URL.
 * Used when Movy (or another direct HLS source) has no subtitle track.
 * Hard budget so dead swarms don't hang the player toast; a release that is still
 * starting keeps running and later calls (background retries) reuse it instead of
 * restarting the torrent. Desktop runs two releases in parallel; Android one at a time.
 */
export async function resolveNyaaSubtitleSidecar(options: {
  showTitle: string
  season: number
  episode: number
  /** Total wait for this call (default 22s). Background retries pass a short budget. */
  budgetMs?: number
}): Promise<{ subtitleUrl: string; subtitleKind?: 'file' | 'embedded' } | null> {
  if (!isTorrentPlaybackAvailable()) return null

  const started = Date.now()
  const budgetMs = Math.max(1000, options.budgetMs ?? NYAA_SUB_SIDECAR_BUDGET_MS)
  // Episode pick first, then by seeders (Multi-Subs/SoftSub break ties); skip
  // English-dub-only packs (Signs-only subs) and releases already found unusable.
  const listed = await sidecarCandidateUris(options, started, budgetMs)
  // Late successes from given-up releases (dropped from the ranking) still count.
  const cachedAll = sidecarCandidatesByEpisode.get(sidecarEpisodeKey(options))?.candidates || []
  for (const c of cachedAll) {
    const s = sidecarStreams.get(c.uri)
    if (s?.done && s.subtitleUrl && Date.now() - s.startedAt <= SIDECAR_SUCCESS_TTL_MS) {
      return { subtitleUrl: s.subtitleUrl, subtitleKind: s.subtitleKind }
    }
  }
  if (!listed || listed.length === 0) {
    if (listed) logSidecarEpisodeOnce(options, 'nyaa.sidecar.exhausted', 'no usable release left')
    return null
  }
  let uris = listed

  for (const uri of uris) {
    const known = sidecarStreams.get(uri)
    if (known?.done && known.subtitleUrl && Date.now() - known.startedAt <= SIDECAR_SUCCESS_TTL_MS) {
      return { subtitleUrl: known.subtitleUrl, subtitleKind: known.subtitleKind }
    }
  }

  // Desktop: up to two releases at once, the second starting once the first has had
  // ~15s (like 0.3.60). Android: one at a time (phone bandwidth). A release that is
  // still starting keeps running after this call returns and is reused next time.
  const maxParallel = isDesktopTorrentAvailable() ? NYAA_SUB_SIDECAR_DESKTOP_PARALLEL : 1
  for (;;) {
    for (const uri of uris) {
      const s = sidecarStreams.get(uri)
      if (s?.done && s.subtitleUrl && Date.now() - s.startedAt <= SIDECAR_SUCCESS_TTL_MS) {
        return { subtitleUrl: s.subtitleUrl, subtitleKind: s.subtitleKind }
      }
    }
    const left = budgetMs - (Date.now() - started)
    if (left < 1000) return null
    // Stalled releases stop counting as pending and drop out of the ranking → next one starts.
    markStalledSidecars(uris)
    if (uris.some((u) => sidecarStreams.get(u)?.stalled)) {
      uris = (await sidecarCandidateUris(options, started, budgetMs)) || []
      if (uris.length === 0) {
        logSidecarEpisodeOnce(
          options,
          'nyaa.sidecar.exhausted',
          'every release stalled, failed or had no subtitles',
        )
        return null
      }
    }
    const pending = uris
      .map((u) => sidecarStreams.get(u))
      .filter((e): e is SidecarStream => Boolean(e && !e.done && !e.stalled))
    // Failed releases are restarted only after the cool-down and while attempts remain.
    const untried = uris.filter((u) => {
      const s = sidecarStreams.get(u)
      // stale success / due retry: startSidecarStream restarts it
      return !s || Boolean(s.done && s.subtitleUrl) || isSidecarRetryReady(s)
    })
    const newestStart = pending.reduce((max, e) => Math.max(max, e.startedAt), 0)
    const sinceNewest = newestStart ? Date.now() - newestStart : Infinity
    if (
      untried.length > 0 &&
      pending.length < maxParallel &&
      (pending.length === 0 || sinceNewest >= NYAA_SUB_SIDECAR_STAGGER_MS)
    ) {
      startSidecarStream(untried[0]!)
      continue
    }
    if (pending.length === 0) {
      const cooling = uris.filter((u) => isSidecarRetryPending(sidecarStreams.get(u)))
      if (cooling.length > 0) {
        // Failed starts waiting out their cool-down: the player keeps polling (bounded by
        // its retry window); a later call restarts them via startSidecarStream.
        logSidecarEpisodeOnce(
          options,
          'nyaa.sidecar.waiting',
          `${cooling.length} failed release(s) retry after ${NYAA_SUB_SIDECAR_RETRY_AFTER_MS / 60_000} min cool-down`,
        )
        return null
      }
      logSidecarEpisodeOnce(
        options,
        'nyaa.sidecar.exhausted',
        'every candidate settled without subtitles (failed starts used all attempts or are permanent)',
      )
      return null
    }
    const canStartMore = untried.length > 0 && pending.length < maxParallel
    // Wake up when the oldest pending release reaches the stall limit so the next one starts.
    const oldestStart = pending.reduce((min, e) => Math.min(min, e.startedAt), Infinity)
    const untilStall = Math.max(250, NYAA_SUB_SIDECAR_STALL_MS - (Date.now() - oldestStart))
    const waitMs = Math.min(
      left,
      untilStall,
      canStartMore ? Math.max(250, NYAA_SUB_SIDECAR_STAGGER_MS - sinceNewest) : NYAA_SUB_SIDECAR_TIMEOUT_MS,
    )
    let timer = 0
    await Promise.race([
      ...pending.map((e) => e.promise),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, waitMs)
      }),
    ])
    window.clearTimeout(timer)
    // One-at-a-time (Android): a release still starting after its attempt window is
    // left running for the next background retry instead of starting another.
    if (!canStartMore && pending.every((e) => !e.done) && maxParallel === 1) return null
  }
}