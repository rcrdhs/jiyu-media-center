/**
 * StreamFree (streamfree.top) — free live sports schedule, no API key.
 * Catalog: GET /api/v1/streams → Sports → Live / Upcoming.
 * Play: the site's own embed page (/embed/{category}/{key}{1080p|540p}) in the
 * Web Browser, same as PPV.st iframes. No native HLS token scraping.
 *
 * Hosts: streamfree.top first, then its backup strmfree.st (same site, same
 * API and embed pages). Only when both fail, the site's public mirror directory
 * (strmfree.link/api/domains) lists other hosts that serve the same API.
 * Embed / thumbnail URLs are moved onto whichever host answered the API, with
 * the other StreamFree host kept as an alternate source.
 */

import type { StreamItem } from '../types'

export const STREAMFREE_ORIGIN = 'https://streamfree.top'
export const STREAMFREE_ID_PREFIX = 'streamfree-'
const STREAMFREE_MIRROR_DIRECTORIES = [
  'https://strmfree.link/api/domains',
  'https://strmfree.st/api/domains',
]
/** Backup domain (Ricardo, Nov 1 2026): tried right after streamfree.top. */
export const STREAMFREE_BACKUP_ORIGIN = 'https://strmfree.st'
const STREAMFREE_FALLBACK_HOSTS = ['strmfree.st']
/** One API attempt; past this the next host is tried (main-process fetch allows 30s). */
const API_TIMEOUT_MS = 12_000
/** After the primary fails, try the host that answered first for this long. */
const PRIMARY_RETRY_AFTER_MS = 5 * 60_000
/** Upcoming rows further out than this stay off the shelf (matches PPV.st). */
const UPCOMING_WINDOW_SEC = 3 * 24 * 60 * 60
/** Not live and started this long ago → finished leftover. */
const STALE_AFTER_START_SEC = 4 * 60 * 60

export interface StreamFreeSource {
  quality?: string
  url?: string
}

export interface StreamFreeTeam {
  name?: string
  logo?: string
}

export interface StreamFreeStream {
  id?: string
  name?: string
  category?: string
  league?: string
  stream_key?: string
  match_timestamp?: number
  viewers?: number
  is_external?: boolean
  thumbnail_url?: string
  sources?: StreamFreeSource[]
  live_sources?: StreamFreeSource[]
  team1?: StreamFreeTeam | null
  team2?: StreamFreeTeam | null
}

export function streamFreeItemId(key: string): string {
  return `${STREAMFREE_ID_PREFIX}${key}`
}

export function isStreamFreeCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
}): boolean {
  if (item.id?.startsWith(STREAMFREE_ID_PREFIX)) return true
  if (item.tags?.includes('streamfree')) return true
  return /^streamfree$/i.test(String(item.source || ''))
}

function unixSecondsNow(): number {
  return Math.floor(Date.now() / 1000)
}

type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string }

function fetchJsonUrl<T>(url: string, referer: string): Promise<JsonResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<JsonResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'Timed out' }), API_TIMEOUT_MS)
  })
  return Promise.race([fetchJsonUrlRaw<T>(url, referer), timeout]).finally(() => clearTimeout(timer))
}

async function fetchJsonUrlRaw<T>(url: string, referer: string): Promise<JsonResult<T>> {
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, referer)
    if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null') as T }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' }
    }
  }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJson } = await import('./nativeHttp')
      const result = await nativeFetchJson<T>(url, {
        referer,
        headers: { Accept: 'application/json' },
      })
      if (!result.ok || result.data == null) {
        return { ok: false, error: result.error || 'Network error' }
      }
      return { ok: true, data: result.data }
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

function normalizeHost(value: unknown): string {
  const input = String(value || '').trim().toLowerCase()
  if (!input) return ''
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    return url.hostname.replace(/\.$/, '').replace(/^www\./, '')
  } catch {
    return ''
  }
}

let mirrorHostsCache: { at: number; hosts: string[] } | null = null
/** Host that last answered (a backup while the primary is down). */
let lastGoodHost = ''
let primaryFailedAt = 0
let primaryFailedHost = ''

/** streamfree.top, strmfree.st and their mirrors (strmfree.link, …). */
export function isStreamFreeHost(host: string): boolean {
  return /(^|\.)(strmfree|streamfree)\.[a-z]{2,}$/i.test(String(host || ''))
}

/** Move a StreamFree embed / thumbnail URL onto `host` (other URLs unchanged). */
export function rehostStreamFreeUrl(url: string, host: string): string {
  if (!host) return url
  try {
    const u = new URL(url)
    if (!isStreamFreeHost(u.hostname) || u.hostname === host) return url
    if (!/^\/(embed|thumbnails)\//i.test(u.pathname)) return url
    u.hostname = host
    return u.toString()
  } catch {
    return url
  }
}

async function mirrorHosts(): Promise<string[]> {
  if (mirrorHostsCache && Date.now() - mirrorHostsCache.at < 30 * 60_000) {
    return mirrorHostsCache.hosts
  }
  for (const dir of STREAMFREE_MIRROR_DIRECTORIES) {
    const result = await fetchJsonUrl<unknown>(dir, `${STREAMFREE_ORIGIN}/`)
    if (!result.ok || !Array.isArray(result.data)) continue
    const hosts = [...new Set(result.data.map(normalizeHost).filter(Boolean))]
    if (hosts.length) {
      mirrorHostsCache = { at: Date.now(), hosts }
      return hosts
    }
  }
  mirrorHostsCache = { at: Date.now(), hosts: STREAMFREE_FALLBACK_HOSTS }
  return STREAMFREE_FALLBACK_HOSTS
}

type StreamsPayload = { streams?: StreamFreeStream[] }

async function fetchStreamsPayload(
  primaryOrigin = STREAMFREE_ORIGIN,
): Promise<{ ok: true; data: StreamsPayload; host: string } | { ok: false; error: string }> {
  const primary = normalizeHost(primaryOrigin)
  const backup = normalizeHost(STREAMFREE_BACKUP_ORIGIN)
  const tried = new Set<string>()
  let lastError = 'StreamFree unavailable'
  const attempt = async (host: string) => {
    if (!host || tried.has(host)) return null
    tried.add(host)
    const result = await fetchJsonUrl<StreamsPayload>(
      `https://${host}/api/v1/streams`,
      `https://${host}/`,
    )
    if (result.ok && Array.isArray(result.data?.streams)) {
      lastGoodHost = host
      if (host === primary) primaryFailedAt = 0
      return { ok: true as const, data: result.data, host }
    }
    lastError = `${host}: ${result.ok ? 'no streams in response' : result.error}`
    if (host === primary) {
      primaryFailedAt = Date.now()
      primaryFailedHost = primary
    }
    return null
  }
  // streamfree.top first; strmfree.st on error / timeout / non-2xx / bad JSON. While the
  // primary was down in the last few minutes, start on the host that answered instead
  // so each 90s poll doesn't wait out the primary's timeout first.
  const primaryCooling =
    primaryFailedHost === primary &&
    Date.now() - primaryFailedAt < PRIMARY_RETRY_AFTER_MS &&
    lastGoodHost &&
    lastGoodHost !== primary
  const order = primaryCooling ? [lastGoodHost, primary, backup] : [primary, backup, lastGoodHost]
  for (const host of order) {
    const hit = await attempt(host)
    if (hit) return hit
  }
  // Primary down: walk the public mirror list (sequential — don't hammer).
  for (const host of await mirrorHosts()) {
    const hit = await attempt(host)
    if (hit) return hit
  }
  return { ok: false, error: lastError }
}

/** 24/7 channels (RedZone, Sky Sports, Willow, DAZN…) — shown as always-live feeds. */
const CHANNEL_NAME_RE =
  /\b(red\s*zone|sky\s*sports?|willow|dazn|espn\s*\d?|tnt\s*sports?|bein|24\s*\/\s*7|channel|network)\b/i
const CHANNEL_LEAGUE_RE = /^(sky|dazn|willow|redzone|24\s*\/\s*7|tv|channels?)$/i
/** A team-less row "started" longer ago than this is an always-on feed, not an event. */
const CHANNEL_MIN_AGE_SEC = 24 * 60 * 60

/**
 * Single events (UFC cards, boxing, F1 races, tennis/cricket matches) often
 * come without team1/team2 — those are events. Always-on channel feeds are
 * kept too (Ricardo, Oct 31 2026: StreamFree-only exception to the no-IPTV
 * rule) but shown as always-live with no kickoff time.
 */
export function isStreamFreeChannel(stream: StreamFreeStream, nowSec = unixSecondsNow()): boolean {
  const name = String(stream.name || '').trim()
  const home = String(stream.team1?.name || '').trim()
  const away = String(stream.team2?.name || '').trim()
  if (home && away) return CHANNEL_NAME_RE.test(name)
  // "Canelo vs. Mbilli" (league DAZN) is a fight, not the DAZN channel.
  if (splitMatchTitle(name)) return false
  if (CHANNEL_NAME_RE.test(name)) return true
  if (CHANNEL_LEAGUE_RE.test(String(stream.league || '').trim())) return true
  const startSec = Number(stream.match_timestamp) || 0
  return startSec > 0 && startSec < nowSec - CHANNEL_MIN_AGE_SEC
}

/** Shelf sport tag, aligned with PPV.st category tags so filter chips merge. */
const CATEGORY_TAG: Record<string, string> = {
  soccer: 'football',
  football: 'american-football',
  nfl: 'american-football',
  hockey: 'ice-hockey',
  basketball: 'basketball',
  baseball: 'baseball',
  combat: 'combat-sports',
  mma: 'combat-sports',
  boxing: 'combat-sports',
  racing: 'motorsports',
  motorsport: 'motorsports',
  cricket: 'cricket',
  tennis: 'tennis',
  rugby: 'rugby',
  golf: 'golf',
}

function categoryTag(category: string): string {
  const c = category.trim().toLowerCase()
  return CATEGORY_TAG[c] || c.replace(/\s+/g, '-') || 'sports'
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function pickSource(sources: StreamFreeSource[] | undefined, quality: RegExp): string {
  for (const s of sources || []) {
    const url = String(s?.url || '').trim()
    if (url && /^https?:\/\//i.test(url) && quality.test(String(s?.quality || ''))) return url
  }
  return ''
}

/** FHD first, then SD, then anything with a URL. */
/**
 * FHD first, then SD, then anything with a URL. With `apiHost`, StreamFree embeds
 * move onto the host that answered the API and the API's own host stays as an
 * alternate (e.g. "StreamFree FHD · strmfree.st").
 */
export function streamFreeSourceUrls(
  stream: StreamFreeStream,
  apiHost = '',
): Array<{ label: string; url: string }> {
  const pool = stream.live_sources?.length ? stream.live_sources : stream.sources
  const base: Array<{ label: string; url: string }> = []
  const fhd = pickSource(pool, /fhd|1080|hd/i)
  const sd = pickSource(pool, /^sd$|540|480/i)
  if (fhd) base.push({ label: 'StreamFree FHD', url: fhd })
  if (sd && sd !== fhd) base.push({ label: 'StreamFree SD', url: sd })
  for (const s of pool || []) {
    const url = String(s?.url || '').trim()
    if (!url || !/^https?:\/\//i.test(url) || base.some((o) => o.url === url)) continue
    base.push({ label: `StreamFree ${String(s?.quality || '').trim() || 'Stream'}`, url })
  }
  if (!apiHost) return base
  const out: Array<{ label: string; url: string }> = []
  for (const s of base) {
    const url = rehostStreamFreeUrl(s.url, apiHost)
    if (!out.some((o) => o.url === url)) out.push({ label: s.label, url })
  }
  for (const s of base) {
    if (out.some((o) => o.url === s.url)) continue
    let host = ''
    try {
      host = new URL(s.url).hostname
    } catch {
      /* ignore */
    }
    out.push({ label: host ? `${s.label} · ${host}` : s.label, url: s.url })
  }
  return out
}

export function streamFreeStreamToItem(
  stream: StreamFreeStream,
  nowSec = unixSecondsNow(),
  /** Host that answered /api/v1/streams; embeds + thumbnails follow it. */
  apiHost = '',
): StreamItem | null {
  const key = String(stream?.stream_key || stream?.id || '').trim()
  const title = String(stream?.name || '').trim()
  if (!key || !title) return null
  const alwaysLive = isStreamFreeChannel(stream, nowSec)

  const live = alwaysLive || (Array.isArray(stream.live_sources) && stream.live_sources.length > 0)
  // Channel feeds carry a months-old "start" — not a kickoff, so ignore it.
  const startSec = alwaysLive ? 0 : Number(stream.match_timestamp) || 0
  if (!live) {
    if (startSec > 0 && startSec < nowSec - STALE_AFTER_START_SEC) return null
    if (startSec > nowSec + UPCOMING_WINDOW_SEC) return null
  }
  const sources = streamFreeSourceUrls(stream, apiHost)
  if (!sources.length) return null

  const category = String(stream.category || 'sports').trim()
  const sportTag = categoryTag(category)
  const league = String(stream.league || '').trim()
  const eventSport =
    (league && !CHANNEL_LEAGUE_RE.test(league) ? league : '') || titleCase(category) || 'Sports'
  const when =
    startSec > 0
      ? new Date(startSec * 1000).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : ''
  const viewersRaw = Number(stream.viewers)
  const homeBadgeUrl = /^https?:\/\//i.test(String(stream.team1?.logo || ''))
    ? String(stream.team1?.logo)
    : undefined
  const awayBadgeUrl = /^https?:\/\//i.test(String(stream.team2?.logo || ''))
    ? String(stream.team2?.logo)
    : undefined
  const thumb = /^https?:\/\//i.test(String(stream.thumbnail_url || ''))
    ? rehostStreamFreeUrl(String(stream.thumbnail_url), apiHost)
    : undefined

  return {
    id: streamFreeItemId(key),
    title,
    description: [eventSport, 'StreamFree', alwaysLive ? '24/7' : when].filter(Boolean).join(' · '),
    category: 'sports',
    url: sources[0].url,
    detailUrl: apiHost ? `https://${apiHost}/` : `${STREAMFREE_ORIGIN}/`,
    poster: thumb || homeBadgeUrl || awayBadgeUrl,
    homeBadgeUrl,
    awayBadgeUrl,
    tags: [
      'live',
      'streamfree',
      'web-embed',
      sportTag,
      // Same chip id as PPV.st's "24/7 Streams" category, so RedZone / Sky Sports /
      // Willow show under that chip too (they only matched their sport chip before).
      ...(alwaysLive ? ['always-live', '24/7-streams'] : []),
      live ? 'live-now' : 'upcoming',
    ],
    source: 'StreamFree',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: startSec > 0 ? startSec * 1000 : Date.now(),
    eventStartsAt: startSec > 0 ? startSec * 1000 : undefined,
    eventViewers: Number.isFinite(viewersRaw) && viewersRaw >= 0 ? viewersRaw : undefined,
    eventSport,
    sportsAltSources: sources.slice(1),
  }
}

/** Live StreamFree rows: the API's live_sources flag, not the clock. */
export function isStreamFreeLiveNow(item: StreamItem): boolean {
  return isStreamFreeCatalogItem(item) && Boolean(item.tags?.includes('live-now'))
}

export async function fetchStreamFreeLiveCatalog(options?: {
  /** Tests only: point the primary at a host that fails to exercise the backup. */
  primaryOrigin?: string
}): Promise<
  | { ok: true; items: StreamItem[]; host: string }
  | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchStreamsPayload(options?.primaryOrigin)
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const nowSec = unixSecondsNow()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const stream of result.data.streams || []) {
    const item = streamFreeStreamToItem(stream, nowSec, result.host)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { ok: true, items, host: result.host }
}

// ── Dedupe against PPV.st ────────────────────────────────────────────────

const TEAM_NOISE_RE =
  /\b(fc|afc|cf|sc|ac|cd|sk|bk|fk|club|de|the|women|w|u\d{2})\b/g

export function normalizeTeamName(name: string): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bman\.?\s+utd\b|\bman\s+united\b/g, 'manchester united')
    .replace(/\bman\.?\s+city\b/g, 'manchester city')
    .replace(/\butd\b/g, 'united')
    .replace(/\bst\.?\s/g, 'saint ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(TEAM_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "League: Home vs Away" / "Home @ Away" → [home, away]. */
export function splitMatchTitle(title: string): [string, string] | null {
  let t = String(title || '').trim()
  const colon = t.lastIndexOf(':')
  if (colon >= 0) t = t.slice(colon + 1)
  t = t.replace(/\s*[([][^)\]]*[)\]]\s*$/, '')
  const parts = t.split(/\s+(?:vs\.?|v\.?|versus|@|at|-)\s+/i)
  if (parts.length !== 2) return null
  const a = parts[0].trim()
  const b = parts[1].trim()
  return a && b ? [a, b] : null
}

function sameTeam(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // "chelsea" vs "chelsea london"; require a real word, not a 2-letter stub.
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  return short.length >= 4 && (` ${long} `).includes(` ${short} `)
}

function teamPairKey(item: StreamItem): [string, string] | null {
  const pair = splitMatchTitle(item.title)
  if (!pair) return null
  const a = normalizeTeamName(pair[0])
  const b = normalizeTeamName(pair[1])
  return a && b ? [a, b] : null
}

/** Same fixture regardless of home/away order, start times within 3h. */
export function isSameSportsFixture(a: StreamItem, b: StreamItem): boolean {
  const pa = teamPairKey(a)
  const pb = teamPairKey(b)
  if (!pa || !pb) return false
  const ordered = sameTeam(pa[0], pb[0]) && sameTeam(pa[1], pb[1])
  const swapped = sameTeam(pa[0], pb[1]) && sameTeam(pa[1], pb[0])
  if (!ordered && !swapped) return false
  const ta = a.eventStartsAt || 0
  const tb = b.eventStartsAt || 0
  if (ta && tb && Math.abs(ta - tb) > 3 * 60 * 60 * 1000) return false
  return true
}

/**
 * A StreamFree row that duplicates a PPV.st row lends the PPV card its crests /
 * viewers and rides along in sportsAltSources, but it is ALSO kept as its own
 * card: no screen offers sportsAltSources yet, so folding hid StreamFree's link
 * entirely (e.g. Canelo vs. Mbilli only showed as the PPV.st card).
 */
export function mergeStreamFreeWithPpv(ppvItems: StreamItem[], sfItems: StreamItem[]): StreamItem[] {
  const merged = ppvItems.map((item) => ({ ...item }))
  const sportsRows = merged.filter((item) => item.category === 'sports')
  const extra: StreamItem[] = []
  for (const sf of sfItems) {
    const twin = sportsRows.find((p) => isSameSportsFixture(p, sf))
    extra.push(sf)
    if (!twin) continue
    const alts = [
      ...(twin.sportsAltSources || []),
      { label: 'StreamFree', url: sf.url },
      ...(sf.sportsAltSources || []),
    ]
    twin.sportsAltSources = alts.filter(
      (s, i) => s.url && s.url !== twin.url && alts.findIndex((o) => o.url === s.url) === i,
    )
    if (!twin.homeBadgeUrl && !twin.awayBadgeUrl && (sf.homeBadgeUrl || sf.awayBadgeUrl)) {
      // Crests follow StreamFree's team order; swap if PPV lists the teams the other way.
      const pt = teamPairKey(twin)
      const st = teamPairKey(sf)
      const swapped = Boolean(pt && st && sameTeam(pt[0], st[1]) && !sameTeam(pt[0], st[0]))
      twin.homeBadgeUrl = swapped ? sf.awayBadgeUrl : sf.homeBadgeUrl
      twin.awayBadgeUrl = swapped ? sf.homeBadgeUrl : sf.awayBadgeUrl
    }
    if (twin.eventViewers == null && sf.eventViewers != null) twin.eventViewers = sf.eventViewers
  }
  return [...merged, ...extra]
}
