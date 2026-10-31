/**
 * StreamFree (streamfree.top) — free live sports schedule, no API key.
 * Catalog: GET /api/v1/streams → Sports → Live / Upcoming.
 * Play: the site's own embed page (/embed/{category}/{key}{1080p|540p}) in the
 * Web Browser, same as PPV.st iframes. No native HLS token scraping.
 *
 * Mirrors: when the primary API host fails, the site's public mirror directory
 * (strmfree.link/api/domains) lists other hosts that serve the same API.
 */

import type { StreamItem } from '../types'

export const STREAMFREE_ORIGIN = 'https://streamfree.top'
export const STREAMFREE_ID_PREFIX = 'streamfree-'
const STREAMFREE_MIRROR_DIRECTORIES = [
  'https://strmfree.link/api/domains',
  'https://strmfree.st/api/domains',
]
const STREAMFREE_FALLBACK_HOSTS = ['strmfree.st']
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

async function fetchJsonUrl<T>(url: string, referer: string): Promise<JsonResult<T>> {
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
/** Host that last answered; tried first on the next refresh. */
let lastGoodHost = ''

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

async function fetchStreamsPayload(): Promise<JsonResult<{ streams?: StreamFreeStream[] }>> {
  const primary = normalizeHost(STREAMFREE_ORIGIN)
  const tried = new Set<string>()
  let lastError = 'StreamFree unavailable'
  const attempt = async (host: string) => {
    if (!host || tried.has(host)) return null
    tried.add(host)
    const result = await fetchJsonUrl<{ streams?: StreamFreeStream[] }>(
      `https://${host}/api/v1/streams`,
      `https://${host}/`,
    )
    if (result.ok && Array.isArray(result.data?.streams)) {
      lastGoodHost = host
      return result
    }
    lastError = result.ok ? 'StreamFree returned no streams' : result.error
    return null
  }
  for (const host of [lastGoodHost, primary]) {
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

/** 24/7 channels (RedZone, Sky Sports, Willow, DAZN…) — not matches. */
const CHANNEL_NAME_RE =
  /\b(red\s*zone|sky\s*sports?|willow|dazn|espn\s*\d?|tnt\s*sports?|bein|24\s*\/\s*7|channel|network)\b/i
const CHANNEL_LEAGUE_RE = /^(sky|dazn|willow|redzone|24\s*\/\s*7|tv|channels?)$/i

export function isStreamFreeChannel(stream: StreamFreeStream): boolean {
  const home = String(stream.team1?.name || '').trim()
  const away = String(stream.team2?.name || '').trim()
  if (!home || !away) return true
  if (CHANNEL_LEAGUE_RE.test(String(stream.league || '').trim())) return true
  if (CHANNEL_NAME_RE.test(String(stream.name || ''))) return true
  return false
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
export function streamFreeSourceUrls(stream: StreamFreeStream): Array<{ label: string; url: string }> {
  const pool = stream.live_sources?.length ? stream.live_sources : stream.sources
  const out: Array<{ label: string; url: string }> = []
  const fhd = pickSource(pool, /fhd|1080|hd/i)
  const sd = pickSource(pool, /^sd$|540|480/i)
  if (fhd) out.push({ label: 'StreamFree FHD', url: fhd })
  if (sd && sd !== fhd) out.push({ label: 'StreamFree SD', url: sd })
  for (const s of pool || []) {
    const url = String(s?.url || '').trim()
    if (!url || !/^https?:\/\//i.test(url) || out.some((o) => o.url === url)) continue
    out.push({ label: `StreamFree ${String(s?.quality || '').trim() || 'Stream'}`, url })
  }
  return out
}

export function streamFreeStreamToItem(
  stream: StreamFreeStream,
  nowSec = unixSecondsNow(),
): StreamItem | null {
  const key = String(stream?.stream_key || stream?.id || '').trim()
  const title = String(stream?.name || '').trim()
  if (!key || !title) return null
  if (isStreamFreeChannel(stream)) return null

  const live = Array.isArray(stream.live_sources) && stream.live_sources.length > 0
  const startSec = Number(stream.match_timestamp) || 0
  if (!live) {
    if (startSec > 0 && startSec < nowSec - STALE_AFTER_START_SEC) return null
    if (startSec > nowSec + UPCOMING_WINDOW_SEC) return null
  }
  const sources = streamFreeSourceUrls(stream)
  if (!sources.length) return null

  const category = String(stream.category || 'sports').trim()
  const sportTag = categoryTag(category)
  const league = String(stream.league || '').trim()
  const eventSport = league || titleCase(category) || 'Sports'
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
    ? String(stream.thumbnail_url)
    : undefined

  return {
    id: streamFreeItemId(key),
    title,
    description: [eventSport, 'StreamFree', when].filter(Boolean).join(' · '),
    category: 'sports',
    url: sources[0].url,
    detailUrl: `${STREAMFREE_ORIGIN}/`,
    poster: thumb || homeBadgeUrl || awayBadgeUrl,
    homeBadgeUrl,
    awayBadgeUrl,
    tags: ['live', 'streamfree', 'web-embed', sportTag, live ? 'live-now' : 'upcoming'],
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

export async function fetchStreamFreeLiveCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchStreamsPayload()
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const nowSec = unixSecondsNow()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const stream of result.data.streams || []) {
    const item = streamFreeStreamToItem(stream, nowSec)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { ok: true, items }
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
 * One card per match: a StreamFree row that duplicates a PPV.st row folds into
 * it (PPV stays the primary player; StreamFree embeds ride along in
 * sportsAltSources, and its crests / live flag fill gaps). Unmatched StreamFree
 * rows are appended.
 */
export function mergeStreamFreeWithPpv(ppvItems: StreamItem[], sfItems: StreamItem[]): StreamItem[] {
  const merged = ppvItems.map((item) => ({ ...item }))
  const sportsRows = merged.filter((item) => item.category === 'sports')
  const extra: StreamItem[] = []
  for (const sf of sfItems) {
    const twin = sportsRows.find((p) => isSameSportsFixture(p, sf))
    if (!twin) {
      extra.push(sf)
      continue
    }
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
