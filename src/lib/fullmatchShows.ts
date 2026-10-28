/**
 * FullMatchShows (fullmatchshows.com) — football full-match replays.
 * Catalog: WordPress REST /wp-json/wp/v2/posts
 * Play: myButton links → playmate.to / playmogo.com (Web Browser embeds).
 */

import type { StreamItem, StreamPlaylistItem } from '../types'
import {
  isLivextvReplayCatalogItem,
  isSoccerfullOnlyReplayItem,
  LIVEXTV_REPLAY_MAX_AGE_MS,
} from './livextvReplays'
import { sportsMatchPoster } from './sportsMatchPoster'
import { isTizenTv } from './tvMode'
import { isTizenFrameBlockedEmbed, tizenExtractEmbed } from './tizenRelay'

export const FULLMATCHSHOWS_ORIGIN = 'https://fullmatchshows.com'
export const FULLMATCHSHOWS_API = `${FULLMATCHSHOWS_ORIGIN}/wp-json/wp/v2`
export const FULLMATCHSHOWS_ID_PREFIX = 'fms-replay-'

/**
 * Replay host tiers (checked in a real browser, Oct 2026). Higher plays first.
 *  4  Playmate /embed/   JW player (health-checked; Playmogo/next host when down)
 *  3  vidaraa.cc /e/     JW player, HLS 720p loads on open (/v/ is a download page)
 *  2  vixeo.io /e/       Shaka player, plays after the play tap
 *  1  playmogo.com /e/   DoodStream player behind a Turnstile tap + popunders,
 *                        playback not confirmed; only when nothing verified exists
 *                        (/d/ is the "Download Now" page)
 *  0  dropped: bysekoze (site page, /e/ 404), embedseek (player-host lists do not
 *     cover it yet), vik1ngfile /f/ downloads, unknown hosts.
 */
const VERIFIED_REPLAY_TIER = 2

function replayHostTier(rawUrl: string): number {
  try {
    const parsed = new URL(toMinimalReplayEmbedUrl(rawUrl))
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    const path = parsed.pathname || ''
    const on = (h: string) => host === h || host.endsWith(`.${h}`)
    if (on('playmate.to')) return /^\/embed\/[^/]+/i.test(path) ? 4 : 0
    if (on('vidaraa.cc') || on('vidara.to')) return /^\/e\/[a-z0-9]{6,}/i.test(path) ? 3 : 0
    if (on('vixeo.io')) return /^\/e\/[a-z0-9]{6,}/i.test(path) ? 2 : 0
    if (on('playmogo.com')) return /^\/e\/[a-z0-9]{6,}/i.test(path) ? 1 : 0
  } catch {
    /* ignore */
  }
  return 0
}

/** True when this replay link opens a player we have seen play. */
export function isVerifiedReplayHost(url: string): boolean {
  return replayHostTier(url) >= VERIFIED_REPLAY_TIER
}

/** FullMatchShows writes "2st half"; keep labels readable in the part picker. */
function cleanPartLabel(raw: string): string {
  return String(raw || '')
    .replace(/\b2st\b/gi, '2nd')
    .replace(/\b1nd\b/gi, '1st')
    .replace(/\s+/g, ' ')
    .trim()
}

function replayPartKey(label: string | undefined): string {
  return cleanPartLabel(label || '').toLowerCase()
}

/**
 * Replay part order (lower first): full match (English commentary, then the
 * unlabeled original, then other languages), 1st half, 2nd half, extra time,
 * extended highlights, pre/post-match, other parts, and Highlights last - so a
 * replay opens the full match and only falls back to highlights when that is
 * all a post has.
 */
export function replayPartRank(label: string | undefined): number {
  const t = replayPartKey(label)
  if (!t) return 80
  const lang = /\bin\s+([a-z]{2,})\b/.exec(t)?.[1] || ''
  const langPenalty = !lang ? 1 : /^(?:en|eng|english)$/.test(lang) ? 0 : 2
  if (/highlight/.test(t)) return 90 + langPenalty
  if (/extended/.test(t)) return 40 + langPenalty
  if (/full\s*(?:match|game)|^full\b/.test(t)) return langPenalty
  if (/\b(?:1st|first)\s*half\b|\bhalf\s*1\b/.test(t)) return 10 + langPenalty
  if (/\b(?:2nd|second)\s*half\b|\bhalf\s*2\b/.test(t)) return 20 + langPenalty
  if (/extra\s*time|penalt/.test(t)) return 30 + langPenalty
  if (/\b(?:pre|post)[-\s]?match\b/.test(t)) return 50 + langPenalty
  if (/^part\s*\d+$/.test(t)) return 60
  return 70 + langPenalty
}

/**
 * Canonical replay order: by part rank, then the post's own part order, then
 * host tier (Playmate, vidaraa, vixeo, Playmogo) within the same part.
 */
function sortReplayLinks<T extends { title?: string; name?: string; url?: string }>(
  rows: T[],
): T[] {
  const labelOf = (row: T) => replayPartKey(row.title ?? row.name)
  const firstSeen = new Map<string, number>()
  rows.forEach((row, i) => {
    const key = labelOf(row)
    if (!firstSeen.has(key)) firstSeen.set(key, i)
  })
  const position = new Map<T, number>()
  rows.forEach((row, i) => position.set(row, i))
  return [...rows].sort((a, b) => {
    const ka = labelOf(a)
    const kb = labelOf(b)
    return (
      replayPartRank(ka) - replayPartRank(kb) ||
      (firstSeen.get(ka) ?? 0) - (firstSeen.get(kb) ?? 0) ||
      replayHostTier(String(b.url || '')) - replayHostTier(String(a.url || '')) ||
      (position.get(a) ?? 0) - (position.get(b) ?? 0)
    )
  })
}

/** One picker entry per replay part (index = that part's best host). */
export type ReplayPartChoice = { title: string; index: number }

/** What /web needs to offer the part picker (Full match / halves / Highlights). */
export type ReplayPartsInfo = {
  playlist: StreamPlaylistItem[]
  parts: ReplayPartChoice[]
  /** Playlist index of the part now playing. */
  index: number
}

export function replayPartChoices(
  playlist: StreamPlaylistItem[] | undefined,
): ReplayPartChoice[] {
  // Best host per part (playlist may be in any order).
  const best = new Map<string, { title: string; index: number; tier: number }>()
  const order: string[] = []
  ;(playlist || []).forEach((row, index) => {
    const key = replayPartKey(row?.title)
    if (!row?.url || !key) return
    const tier = replayHostTier(row.url)
    if (tier <= 0) return
    const prev = best.get(key)
    if (!prev) order.push(key)
    if (!prev || tier > prev.tier) best.set(key, { title: cleanPartLabel(row.title), index, tier })
  })
  // Only parts that have a verified player; unverified parts only when nothing is verified.
  const verified = order.filter((key) => best.get(key)!.tier >= VERIFIED_REPLAY_TIER)
  return (verified.length > 0 ? verified : order).map((key) => {
    const row = best.get(key)!
    return { title: row.title, index: row.index }
  })
}

/**
 * Player-only URL for a replay link. Playmate /watch/ is the full site (nav,
 * comments) and /embed/ is JW player only. Playmogo (DoodStream) /d/ and
 * vidaraa /v/ are download pages; their /e/ is the player.
 */
export function toMinimalReplayEmbedUrl(url: string): string {
  const raw = String(url || '')
    .replace(/&amp;/g, '&')
    .trim()
  if (!raw) return raw
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'playmate.to' || host.endsWith('.playmate.to')) {
      const watch = parsed.pathname.match(/^\/watch\/([^/?#]+)/i)
      if (watch?.[1]) {
        parsed.pathname = `/embed/${decodeURIComponent(watch[1])}`
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      }
    }
    const downloadPage =
      host === 'playmogo.com' || host.endsWith('.playmogo.com')
        ? /^\/d\/([a-z0-9]{6,})/i
        : host === 'vidaraa.cc' || host.endsWith('.vidaraa.cc')
          ? /^\/v\/([a-z0-9]{6,})/i
          : null
    const id = downloadPage ? parsed.pathname.match(downloadPage)?.[1] : ''
    if (id) {
      parsed.pathname = `/e/${id}`
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    }
  } catch {
    /* ignore */
  }
  return raw
}

export function fullmatchShowsItemId(postId: string | number): string {
  return `${FULLMATCHSHOWS_ID_PREFIX}${postId}`
}

export function isFullmatchShowsCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
  detailUrl?: string
}): boolean {
  if (item.id?.startsWith(FULLMATCHSHOWS_ID_PREFIX)) return true
  if (item.tags?.includes('replay') && item.tags?.includes('fullmatchshows')) return true
  if (/^fullmatchshows$/i.test(String(item.source || ''))) return true
  try {
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'fullmatchshows.com' || host.endsWith('.fullmatchshows.com')) return true
      if (host === 'playmate.to' || host.endsWith('.playmate.to')) return true
      if (host === 'playmogo.com' || host.endsWith('.playmogo.com')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** Shared Replay shelf predicate (LiveXTV + FullMatchShows). */
export function isSportsReplayCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
  detailUrl?: string
}): boolean {
  if (item.tags?.includes('replay')) return true
  if (isFullmatchShowsCatalogItem(item)) return true
  try {
    // Avoid circular import at module init — LiveXTV ids / hosts.
    if (item.id?.startsWith('livextv-replay-')) return true
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host.includes('livextv') || host === 'soccerfull.net' || host.endsWith('.soccerfull.net')) {
        return true
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

function decodeEntities(raw: string): string {
  return String(raw || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractPlayLinks(html: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = []
  const seen = new Set<string>()
  for (const m of html.matchAll(
    /<a[^>]*class=["'][^"']*myButton[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const url = String(m[1] || '')
      .replace(/&amp;/g, '&')
      .trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const playUrl = toMinimalReplayEmbedUrl(url)
    // Download pages and hosts we have not seen play are left out.
    if (replayHostTier(playUrl) <= 0) continue
    if (seen.has(playUrl)) continue
    seen.add(url)
    seen.add(playUrl)
    const name = cleanPartLabel(decodeEntities(m[2] || '')).slice(0, 48) || `Part ${out.length + 1}`
    out.push({ name, url: playUrl })
  }
  // Fallback: any playmate / playmogo href in the post body.
  if (out.length === 0) {
    for (const m of html.matchAll(/href=["'](https?:\/\/(?:playmate\.to|playmogo\.com)[^"']+)["']/gi)) {
      const url = String(m[1] || '')
        .replace(/&amp;/g, '&')
        .trim()
      if (!url || seen.has(url)) continue
      const playUrl = toMinimalReplayEmbedUrl(url)
      if (seen.has(playUrl)) continue
      seen.add(url)
      seen.add(playUrl)
      out.push({ name: `Part ${out.length + 1}`, url: playUrl })
    }
  }
  // Full match first, Highlights last; host only breaks ties within a part.
  return sortReplayLinks(out)
}

function withinReplayWindow(dateMs: number, nowMs: number): boolean {
  if (!Number.isFinite(dateMs) || dateMs <= 0) return false
  const age = nowMs - dateMs
  return age >= -6 * 60 * 60 * 1000 && age <= LIVEXTV_REPLAY_MAX_AGE_MS
}

type WpPost = {
  id: number
  date?: string
  link?: string
  title?: { rendered?: string }
  content?: { rendered?: string }
  _embedded?: { 'wp:featuredmedia'?: Array<{ source_url?: string }> }
}

export function fullmatchShowsPostToItem(
  post: WpPost,
  nowMs = Date.now(),
): StreamItem | null {
  const id = String(post?.id || '').trim()
  const title = decodeEntities(post?.title?.rendered || '')
  if (!id || !title) return null

  const dateMs = post.date ? Date.parse(post.date) : 0
  if (!withinReplayWindow(dateMs, nowMs)) return null

  const html = String(post.content?.rendered || '')
  const servers = extractPlayLinks(html)
  if (servers.length === 0) return null

  const when =
    dateMs > 0
      ? new Date(dateMs).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : ''
  const partsLabel =
    servers.length > 1 ? `${servers.length} parts` : servers[0]?.name || 'Replay'

  const playlist: StreamPlaylistItem[] = servers.map((s, i) => ({
    title: s.name,
    url: s.url,
    episodeKey: `P${i + 1}`,
  }))

  const detailUrl = String(post.link || `${FULLMATCHSHOWS_ORIGIN}/?p=${id}`).trim()
  const play = (servers.find((s) => isVerifiedReplayHost(s.url)) || servers[0]!).url
  // Same VS card art as LiveXTV / Your teams (featured WP images were inconsistent).
  const poster = sportsMatchPoster(title, 'Football')

  return {
    id: fullmatchShowsItemId(id),
    title,
    description: ['Football', 'Replay', partsLabel, when].filter(Boolean).join(' · '),
    category: 'sports',
    url: play,
    detailUrl,
    poster,
    tags: ['replay', 'fullmatchshows', 'web-embed', 'football'],
    source: 'FullMatchShows',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: dateMs > 0 ? dateMs : nowMs,
    eventStartsAt: dateMs > 0 ? dateMs : undefined,
    eventEndsAt: dateMs > 0 ? dateMs : undefined,
    eventSport: 'Football',
    playlist,
  }
}

async function fetchWpJson<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${FULLMATCHSHOWS_API}${path}`
  const { nativeFetchJson, isNativeHttpPlatform } = await import('./nativeHttp')

  if (window.signalDesktop?.fetchJsonGet || isNativeHttpPlatform()) {
    const result = await nativeFetchJson<T>(url, {
      referer: `${FULLMATCHSHOWS_ORIGIN}/`,
      headers: {
        Accept: 'application/json',
        Origin: FULLMATCHSHOWS_ORIGIN,
      },
    })
    if (!result.ok || result.data == null) {
      return { ok: false, error: result.error || 'FullMatchShows unavailable' }
    }
    return { ok: true, data: result.data }
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: `${FULLMATCHSHOWS_ORIGIN}/`,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

/** Fetch football replays from FullMatchShows (same ~3 day window as LiveXTV). */
export async function fetchFullmatchShowsReplayCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const after = new Date(Date.now() - LIVEXTV_REPLAY_MAX_AGE_MS).toISOString()
  const qs = new URLSearchParams({
    per_page: '40',
    page: '1',
    orderby: 'date',
    order: 'desc',
    after,
    _embed: '1',
    _fields: 'id,date,link,title,content,_links,_embedded',
  })
  const result = await fetchWpJson<WpPost[]>(`/posts?${qs.toString()}`)
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const rows = Array.isArray(result.data) ? result.data : []
  const nowMs = Date.now()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const item = fullmatchShowsPostToItem(row, nowMs)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  items.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
  return { ok: true, items }
}

export type FullmatchShowsPlayResult =
  | { ok: true; mode: 'embed'; url: string; replayParts?: ReplayPartsInfo }
  | { ok: false; error: string }

/**
 * Pick a playable embed for a FullMatchShows replay.
 * Default (no `preferredIndex`): the best part that has a verified player -
 * the full match when one plays, else halves / extended / Highlights; an
 * unverified host (Playmogo) only when no part has a verified one.
 * `preferredIndex` (part picker) plays that part on its best host.
 */
export async function resolveFullmatchShowsPlay(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'playlist' | 'id'>,
  preferredIndex?: number,
  opts?: { avoid?: (url: string) => boolean },
): Promise<FullmatchShowsPlayResult> {
  const rawPlaylist = (item.playlist || []).filter((p) => Boolean(p?.url))
  const targetKey =
    preferredIndex != null && rawPlaylist.length > 0
      ? replayPartKey(
          rawPlaylist[Math.max(0, Math.min(preferredIndex, rawPlaylist.length - 1))]?.title,
        )
      : ''
  // Older cached items were host-sorted (Highlights first) - re-rank by part.
  const playlist = sortReplayLinks(rawPlaylist)
  const titleOf = (url: string) => playlist.find((p) => p?.url === url)?.title
  const keyOf = (url: string) => replayPartKey(titleOf(url))

  const candidates = [...new Set([...playlist.map((p) => p.url), item.url].filter(Boolean))]
  const position = new Map(candidates.map((url, i) => [url, i]))
  const verified = (url: string) => (replayHostTier(url) >= VERIFIED_REPLAY_TIER ? 0 : 1)
  const playable = candidates
    .filter((url) => replayHostTier(url) > 0 && !opts?.avoid?.(url))
    .sort((a, b) => {
      if (targetKey) {
        const wantA = keyOf(a) === targetKey ? 0 : 1
        const wantB = keyOf(b) === targetKey ? 0 : 1
        if (wantA !== wantB) return wantA - wantB
        // Picked part: its best host first (playlist order is part, then tier).
        return (position.get(a) ?? 0) - (position.get(b) ?? 0)
      }
      // Default: a verified player beats a better part on an unverified host.
      return verified(a) - verified(b) || (position.get(a) ?? 0) - (position.get(b) ?? 0)
    })

  const parts = replayPartChoices(playlist)
  const done = (url: string): FullmatchShowsPlayResult => {
    const key = keyOf(url)
    const part = parts.find((p) => replayPartKey(p.title) === key)
    return {
      ok: true,
      mode: 'embed',
      url: toMinimalReplayEmbedUrl(url),
      replayParts:
        parts.length > 0
          ? { playlist, parts, index: part?.index ?? parts[0]!.index }
          : undefined,
    }
  }

  const first = playable[0]
  if (first && isPlaymateUrl(first) && (await isPlaymateStreamDown(first))) {
    // Playmate's own error card ("This video did not play") on every replay when
    // its HLS CDN is unreachable - same part on the next host (vidaraa, vixeo,
    // Playmogo), else the next verified part.
    const firstKey = keyOf(first)
    const others = playable.filter((url) => !isPlaymateUrl(url))
    const samePart = firstKey
      ? others.find((url) => keyOf(url) === firstKey && verified(url) === 0) ||
        others.find((url) => keyOf(url) === firstKey)
      : undefined
    const fallback = samePart || others.find((url) => verified(url) === 0) || others[0]
    if (fallback) return done(fallback)
  }
  if (first) return done(first)

  if (!opts?.avoid && item.detailUrl && /fullmatchshows\.com/i.test(item.detailUrl)) {
    return { ok: true, mode: 'embed', url: item.detailUrl }
  }

  return { ok: false, error: 'No working FullMatchShows player for this match' }
}

export type FullmatchShowsDevicePlay =
  | FullmatchShowsPlayResult
  | { ok: true; mode: 'hls'; url: string; referer?: string; embedUrl: string; replayParts?: ReplayPartsInfo }

/**
 * Samsung (Tizen): vidaraa / playmate refuse a file:// parent frame (frame-ancestors),
 * so their stream is extracted by the relay and played natively; when that fails the
 * replay falls back to the next part / host that can be framed (e.g. vixeo) — never a
 * blank frame. Other platforms: exactly resolveFullmatchShowsPlay.
 */
export async function resolveFullmatchShowsPlayForDevice(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'playlist' | 'id'>,
  preferredIndex?: number,
): Promise<FullmatchShowsDevicePlay> {
  const res = await resolveFullmatchShowsPlay(item, preferredIndex)
  if (!isTizenTv() || !res.ok || !isTizenFrameBlockedEmbed(res.url)) {
    if (isTizenTv() && res.ok && /fullmatchshows\.com/i.test(res.url)) {
      return { ok: false, error: 'This replay has no player that opens on Samsung TV' }
    }
    return res
  }
  const x = await tizenExtractEmbed(res.url)
  if (x.ok) {
    return { ok: true, mode: 'hls', url: x.url, referer: x.referer, embedUrl: res.url, replayParts: res.replayParts }
  }
  const alt = await resolveFullmatchShowsPlay(item, preferredIndex, { avoid: isTizenFrameBlockedEmbed })
  if (alt.ok) return alt
  return { ok: false, error: 'This replay has no player that opens on Samsung TV' }
}

function isPlaymateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return host === 'playmate.to' || host.endsWith('.playmate.to')
  } catch {
    return false
  }
}

const PLAYMATE_HEALTH_TTL_MS = 5 * 60 * 1000
const PLAYMATE_HEALTH_TIMEOUT_MS = 7000
let playmateHealth: { at: number; down: boolean } | null = null

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * True only when Playmate's HLS CDN is positively unreachable (network error /
 * timeout / 5xx). API errors, 4xx and plain browser tabs count as "not down"
 * so a flaky check never hides a working Playmate.
 */
async function isPlaymateStreamDown(embedUrl: string): Promise<boolean> {
  if (playmateHealth && Date.now() - playmateHealth.at < PLAYMATE_HEALTH_TTL_MS) {
    return playmateHealth.down
  }
  let code = ''
  let origin = 'https://playmate.to'
  try {
    const parsed = new URL(embedUrl)
    origin = parsed.origin
    code = parsed.pathname.match(/^\/(?:embed|watch)\/([^/?#]+)/i)?.[1] || ''
  } catch {
    return false
  }
  if (!code) return false

  const check = async (): Promise<boolean | null> => {
    const { nativeFetchJsonPost, isNativeHttpPlatform } = await import('./nativeHttp')
    const desktop = Boolean(window.signalDesktop?.fetchJsonPost)
    const android = !desktop && isNativeHttpPlatform()
    if (!desktop && !android) return null
    // Playmate API slow / refusing: unknown, keep Playmate.
    const api = await withTimeout(
      nativeFetchJsonPost<{ sx?: string }>(
        `${origin}/api/s`,
        { c: code, d: android ? 'android' : 'desktop' },
        { referer: embedUrl, headers: { Origin: origin } },
      ),
      PLAYMATE_HEALTH_TIMEOUT_MS,
      { ok: false, data: null, error: 'timeout' },
    )
    const sx = String(api.data?.sx || '').trim()
    if (!api.ok || !/^https?:\/\//i.test(sx)) return null

    if (desktop) {
      if (!window.signalDesktop?.probeStream) return null
      const probe = await withTimeout(
        window.signalDesktop.probeStream(sx, PLAYMATE_HEALTH_TIMEOUT_MS - 1000),
        PLAYMATE_HEALTH_TIMEOUT_MS,
        null,
      )
      // A hung connect (this PC: 20s+ before failing) counts as down.
      if (!probe) return true
      return !probe.ok && (probe.status === 0 || probe.status >= 500)
    }
    const { CapacitorHttp } = await import('@capacitor/core')
    try {
      const res = await withTimeout(
        CapacitorHttp.get({
          url: sx,
          headers: { Referer: `${origin}/`, Origin: origin, Accept: '*/*' },
          responseType: 'text',
          connectTimeout: PLAYMATE_HEALTH_TIMEOUT_MS - 1000,
          readTimeout: PLAYMATE_HEALTH_TIMEOUT_MS - 1000,
        }),
        PLAYMATE_HEALTH_TIMEOUT_MS,
        null,
      )
      if (!res) return true
      return !res.status || res.status >= 500
    } catch {
      return true
    }
  }

  let result: boolean | null = null
  try {
    result = await check()
  } catch {
    result = null
  }
  if (result == null) return false
  playmateHealth = { at: Date.now(), down: result }
  return result
}

function normalizeMatchTitle(raw: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/full\s*match(?:es)?(?:\s*replay)?/g, ' ')
    .replace(/\b(?:replay|vod|highlights?)\b/g, ' ')
    .replace(/\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchSides(title: string): [string, string] | null {
  const norm = normalizeMatchTitle(title)
  const parts = norm.split(/\s+vs\.?\s+/)
  if (parts.length !== 2) return null
  const a = parts[0]!.trim()
  const b = parts[1]!.trim()
  if (!a || !b) return null
  return [a, b]
}

function titlesMatchReplay(query: string, candidate: string): boolean {
  const q = matchSides(query)
  const c = matchSides(candidate)
  if (q && c) {
    const same =
      (q[0] === c[0] && q[1] === c[1]) || (q[0] === c[1] && q[1] === c[0])
    if (same) return true
    // Allow short club-name containment (Bayern / Bayern Munchen).
    const loose =
      ((c[0].includes(q[0]) || q[0].includes(c[0])) &&
        (c[1].includes(q[1]) || q[1].includes(c[1]))) ||
      ((c[0].includes(q[1]) || q[1].includes(c[0])) &&
        (c[1].includes(q[0]) || q[0].includes(c[1])))
    if (loose) return true
  }
  const nq = normalizeMatchTitle(query)
  const nc = normalizeMatchTitle(candidate)
  return Boolean(nq && nc && (nc.includes(nq) || nq.includes(nc)))
}

/**
 * LiveXTV football parts currently point at dead soccerfull.net hosts.
 * Resolve the same fixture on FullMatchShows (Playmate) by title + date window.
 */
export async function resolveFullmatchShowsPlayForTitle(
  title: string,
  dateMs?: number,
): Promise<FullmatchShowsPlayResult> {
  const clean = String(title || '').trim()
  if (!clean) return { ok: false, error: 'Missing match title' }

  const sides = matchSides(clean)
  const search = sides ? `${sides[0]} ${sides[1]}` : clean
  const qs = new URLSearchParams({
    search,
    per_page: '8',
    orderby: 'relevance',
    _fields: 'id,date,link,title,content',
  })
  const result = await fetchWpJson<WpPost[]>(`/posts?${qs.toString()}`)
  if (!result.ok) return { ok: false, error: result.error }

  const rows = Array.isArray(result.data) ? result.data : []
  const nowMs = Date.now()
  let best: StreamItem | null = null
  let bestScore = -Infinity

  for (const row of rows) {
    const item = fullmatchShowsPostToItem(row, nowMs)
    if (!item) continue
    if (!titlesMatchReplay(clean, item.title)) continue
    let score = 10
    if (dateMs && item.releasedAt) {
      const delta = Math.abs(item.releasedAt - dateMs)
      if (delta <= 2 * 24 * 60 * 60 * 1000) score += 50 - delta / (60 * 60 * 1000)
      else score -= delta / (24 * 60 * 60 * 1000)
    }
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }

  if (!best) {
    return { ok: false, error: 'No FullMatchShows mirror for this match' }
  }
  return resolveFullmatchShowsPlay(best)
}

/**
 * Replay shelf: FullMatchShows football (Playmate) + LiveXTV when parts are not
 * soccerfull-only. Hide dead soccerfull-only LiveXTV cards (with or without FMS).
 */
export function mergeSportsReplayShelfItems(
  livextv: StreamItem[],
  fms: StreamItem[],
): StreamItem[] {
  const seen = new Set<string>()
  const out: StreamItem[] = []
  const push = (item: StreamItem) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    out.push(item)
  }
  for (const item of fms) push(item)
  for (const item of livextv) {
    if (!isLivextvReplayCatalogItem(item)) continue
    if (isSoccerfullOnlyReplayItem(item)) continue
    push(item)
  }
  out.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
  return out
}

export function sportsReplaySportId(item: StreamItem): string | null {
  if (!isSportsReplayCatalogItem(item)) return null
  const tag = item.tags?.find((t) =>
    /^(football|boxing|cricket|motorsport)$/i.test(String(t || '')),
  )
  if (tag) return String(tag).toLowerCase()
  if (isFullmatchShowsCatalogItem(item)) return 'football'
  return null
}

export function sportsReplaySportChipsFromItems(
  items: StreamItem[],
): Array<{ id: string; name: string }> {
  const names: Record<string, string> = {
    football: 'Football',
    boxing: 'Boxing',
    cricket: 'Cricket',
    motorsport: 'Motorsport',
  }
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string }> = []
  for (const item of items) {
    const id = sportsReplaySportId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: names[id] || id })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
