/**
 * Tim Streams (tim-streams.com) — live sports events and 24/7 channels.
 *
 * Public JSON: GET /api/live-upcoming, /api/channels, /api/watch/:slug.
 * Each row already lists its playable mirrors (`streams[]`). VIP-only
 * mirrors are skipped (no login). Play URLs are shoewiki.click embeds that
 * resolve in-page to short-lived clear HLS (no CENC / AES-128 in the
 * playlist). Android should sniff that HLS for Media3; otherwise open the
 * shoewiki player in Gecko / the desktop web browser.
 */

import type { StreamItem } from '../types'
import { withSportsProviderLabel } from './sportsProviderLabel'

export const TIM_STREAMS_ORIGIN = 'https://tim-streams.com'
export const TIM_STREAMS_ID_PREFIX = 'timstreams-'
export const TIM_STREAMS_PLAYER_ORIGIN = 'https://shoewiki.click'
/** Referer / Origin the HLS CDN expects when a sniffed playlist is played. */
export const TIM_STREAMS_MEDIA_REFERER = `${TIM_STREAMS_PLAYER_ORIGIN}/`

const EVENT_DURATION_MS = Math.round(3.5 * 60 * 60 * 1000)

export interface TimStreamsStream {
  name?: string
  url?: string
  vip?: boolean
}

export interface TimStreamsEvent {
  url?: string
  name?: string
  logo?: string
  genre?: number
  sub_genre?: number
  time?: string
  isevent?: boolean
  vip?: boolean
  viewers?: number
  featured?: boolean
  streams?: TimStreamsStream[]
}

export interface TimStreamsChannel {
  url?: string
  name?: string
  logo?: string
  genre?: number
  flag?: string
  vip?: boolean
  viewers?: number
  streams?: TimStreamsStream[]
}

export interface TimStreamsGenre {
  id: number
  name: string
  featured?: boolean
  sub_categories?: Array<{ id: number; name: string; featured?: boolean }>
}

export interface TimStreamsLiveUpcoming {
  events?: TimStreamsEvent[]
  genres?: TimStreamsGenre[]
}

export interface TimStreamsChannels {
  channels?: TimStreamsChannel[]
  genres?: Array<{ id: number; name: string }>
}

/** App sport-chip ids, matching streamFree CATEGORY_TAG / StreamCorner rules. */
const EVENT_GENRE_SPORT: Record<number, string> = {
  1: 'football',
  2: 'motorsports',
  3: 'combat-sports',
  6: 'combat-sports',
  7: 'basketball',
  8: 'american-football',
  9: 'baseball',
  10: 'tennis',
  11: 'ice-hockey',
  12: 'darts',
  13: 'cricket',
  14: 'cycling',
  15: 'rugby',
  16: 'rugby',
  17: 'sports',
  18: 'sports',
}

const EVENT_GENRE_NAME: Record<number, string> = {
  1: 'Football',
  2: 'Motorsports',
  3: 'Combat Sports',
  6: 'Combat Sports',
  7: 'Basketball',
  8: 'American Football',
  9: 'Baseball',
  10: 'Tennis',
  11: 'Ice Hockey',
  12: 'Darts',
  13: 'Cricket',
  14: 'Cycling',
  15: 'Rugby',
  16: 'Rugby',
  17: 'Live Shows',
  18: 'Sports',
}

const SPORT_CHIP_NAME: Record<string, string> = {
  football: 'Football',
  'american-football': 'American Football',
  basketball: 'Basketball',
  'ice-hockey': 'Ice Hockey',
  baseball: 'Baseball',
  'combat-sports': 'Combat Sports',
  motorsports: 'Motorsports',
  tennis: 'Tennis',
  cricket: 'Cricket',
  rugby: 'Rugby',
  cycling: 'Cycling',
  darts: 'Darts',
  golf: 'Golf',
  '24/7-streams': '24/7 Streams',
  sports: 'Sports',
}

/** Name-based refinement for 24/7 sports channels (Sky Sports F1, etc.). */
const CHANNEL_SPORT_RULES: Array<[RegExp, string]> = [
  [/\b(nfl|redzone|red\s*zone|ncaaf|college\s*football)\b/i, 'american-football'],
  [/\b(nba|wnba|basketball)\b/i, 'basketball'],
  [/\b(nhl|hockey)\b/i, 'ice-hockey'],
  [/\b(mlb|baseball)\b/i, 'baseball'],
  [/\b(ufc|mma|boxing|fight|wrestling)\b/i, 'combat-sports'],
  [/\b(f1|formula|motogp|nascar|indycar|motorsport|racing|superbike)\b/i, 'motorsports'],
  [/\b(cricket|willow)\b/i, 'cricket'],
  [/\b(tennis)\b/i, 'tennis'],
  [/\b(golf)\b/i, 'golf'],
  [/\b(premier\s*league|la\s*liga|serie\s*a|bundesliga|ligue\s*1|mls|soccer|football|bein|tnt\s*sports)\b/i, 'football'],
]

export function timStreamsItemId(kind: 'event' | 'channel', slug: string): string {
  return `${TIM_STREAMS_ID_PREFIX}${kind}-${slug}`
}

export function isTimStreamsHost(hostname: string): boolean {
  const h = String(hostname || '')
    .replace(/^www\./i, '')
    .toLowerCase()
  if (!h) return false
  return (
    h === 'tim-streams.com' ||
    h.endsWith('.tim-streams.com') ||
    h === 'timstreams.co.rw' ||
    h.endsWith('.timstreams.co.rw') ||
    h === 'shoewiki.click' ||
    h.endsWith('.shoewiki.click')
  )
}

export function isTimStreamsUrl(url?: string): boolean {
  if (!url) return false
  try {
    return isTimStreamsHost(new URL(url).hostname)
  } catch {
    return false
  }
}

export function isTimStreamsCatalogItem(item: {
  id?: string
  url?: string
  detailUrl?: string
  tags?: string[]
  source?: string
}): boolean {
  if (item.id?.startsWith(TIM_STREAMS_ID_PREFIX)) return true
  if (item.tags?.some((t) => /^timstreams$/i.test(String(t || '')))) return true
  if (/^tim\s*streams$/i.test(String(item.source || ''))) return true
  return isTimStreamsUrl(item.url) || isTimStreamsUrl(item.detailUrl)
}


/** Visible mirror name; drop the generic API "TimStreams" label. */
export function timStreamsMirrorLabel(name?: string): string {
  const raw = String(name || '').trim()
  if (!raw || /^tim\s*streams$/i.test(raw)) return ''
  return raw
}

export function playableTimStreamsMirrors(
  streams: TimStreamsStream[] | undefined,
): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = []
  const seen = new Set<string>()
  for (const stream of streams || []) {
    if (stream?.vip) continue
    const url = String(stream?.url || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ label: timStreamsMirrorLabel(stream?.name), url })
  }
  return out
}

export function absoluteTimStreamsAsset(url?: string): string | undefined {
  const raw = String(url || '').trim()
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('/')) return `${TIM_STREAMS_ORIGIN}${raw}`
  return `${TIM_STREAMS_ORIGIN}/${raw}`
}

/**
 * Event `time` values have no timezone. US slate times (NBA/NFL 18:00–20:30)
 * match America/New_York; Nov–early March is EST (−05).
 */
export function parseTimStreamsEventTime(raw?: string, _nowMs = Date.now()): number | undefined {
  const s = String(raw || '').trim()
  if (!s) return undefined
  if (/Z|[+-]\d{2}:\d{2}$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : undefined
  }
  const month = Number((s.match(/^\d{4}-(\d{2})/) || [])[1] || 0)
  const offset = month >= 3 && month <= 10 ? '-04:00' : '-05:00'
  const t = Date.parse(`${s}${offset}`)
  if (Number.isFinite(t)) return t
  const fallback = Date.parse(s)
  return Number.isFinite(fallback) ? fallback : undefined
}

export function eventSportTag(
  genre?: number,
  subName?: string,
  title?: string,
): string {
  const fromGenre = EVENT_GENRE_SPORT[Number(genre) || 0]
  if (fromGenre && fromGenre !== 'sports') return fromGenre
  const blob = `${subName || ''} ${title || ''}`
  for (const [re, tag] of CHANNEL_SPORT_RULES) {
    if (re.test(blob)) return tag
  }
  return fromGenre || 'sports'
}

export function eventSportName(tag: string, genre?: number): string {
  return SPORT_CHIP_NAME[tag] || EVENT_GENRE_NAME[Number(genre) || 0] || 'Sports'
}

export function channelSportTags(channel: TimStreamsChannel): {
  category: StreamItem['category']
  sportTag: string
  extraTags: string[]
} {
  const genre = Number(channel.genre) || 0
  const name = String(channel.name || '')
  if (genre === 3) {
    return { category: 'kids', sportTag: '24/7-streams', extraTags: ['always-live', 'kids-live'] }
  }
  if (genre === 1 || genre === 4) {
    return {
      category: 'series',
      sportTag: '24/7-streams',
      extraTags: ['always-live', '247-series'],
    }
  }
  // Sports (2) and News (5) land on the Sports 24/7 chip, like CNN · PPV.
  let sportTag = '24/7-streams'
  for (const [re, tag] of CHANNEL_SPORT_RULES) {
    if (re.test(name)) {
      sportTag = tag
      break
    }
  }
  return {
    category: 'sports',
    sportTag,
    extraTags: ['always-live', '24/7-streams'],
  }
}

function subGenreName(genres: TimStreamsGenre[] | undefined, genre?: number, sub?: number): string | undefined {
  const g = (genres || []).find((x) => x.id === genre)
  const s = (g?.sub_categories || []).find((x) => x.id === sub)
  return s?.name
}

export function timStreamsEventToItem(
  event: TimStreamsEvent,
  genres?: TimStreamsGenre[],
  nowMs = Date.now(),
): StreamItem | null {
  const slug = String(event?.url || '').trim()
  const title = String(event?.name || '').trim()
  if (!slug || !title) return null
  if (event.vip) return null
  const mirrors = playableTimStreamsMirrors(event.streams)
  if (!mirrors.length) return null

  const startMs = parseTimStreamsEventTime(event.time, nowMs)
  const endMs = startMs != null ? startMs + EVENT_DURATION_MS : undefined
  const liveNow = startMs != null && startMs <= nowMs && (endMs == null || endMs >= nowMs)
  const upcoming = startMs != null && startMs > nowMs
  const status = liveNow ? 'live-now' : upcoming ? 'upcoming' : 'live-now'
  const subName = subGenreName(genres, event.genre, event.sub_genre)
  const sportTag = eventSportTag(event.genre, subName, title)
  const sportName = eventSportName(sportTag, event.genre)
  const when =
    startMs != null
      ? new Date(startMs).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : ''
  const viewersRaw = Number(event.viewers)
  const alts = mirrors.slice(1).map(({ label, url }) => ({
    label: label || 'TS',
    url,
  }))

  return {
    id: timStreamsItemId('event', slug),
    title: withSportsProviderLabel(title, 'TS'),
    description: [subName || sportName, mirrors[0].label, when]
      .filter(Boolean)
      .join(' · '),
    category: 'sports',
    url: mirrors[0].url,
    detailUrl: `${TIM_STREAMS_ORIGIN}/watch/${slug}`,
    poster: absoluteTimStreamsAsset(event.logo),
    tags: ['live', 'timstreams', 'web-embed', sportTag, status].filter(Boolean),
    source: 'Tim Streams',
    sourceKind: 'builtin',
    transport: 'direct',
    httpReferrer: TIM_STREAMS_MEDIA_REFERER,
    releasedAt: startMs ?? nowMs,
    eventStartsAt: startMs,
    eventEndsAt: endMs,
    eventViewers: Number.isFinite(viewersRaw) && viewersRaw >= 0 ? viewersRaw : undefined,
    eventSport: sportName,
    sportsAltSources: alts.length ? alts : undefined,
  }
}

export function timStreamsChannelToItem(
  channel: TimStreamsChannel,
  nowMs = Date.now(),
): StreamItem | null {
  const slug = String(channel?.url || '').trim()
  const title = String(channel?.name || '').trim()
  if (!slug || !title) return null
  if (channel.vip) return null
  const mirrors = playableTimStreamsMirrors(channel.streams)
  if (!mirrors.length) return null

  const route = channelSportTags(channel)
  const alts = mirrors.slice(1).map(({ label, url }) => ({
    label: label || 'TS',
    url,
  }))
  const viewersRaw = Number(channel.viewers)
  const sportName = SPORT_CHIP_NAME[route.sportTag] || '24/7'

  return {
    id: timStreamsItemId('channel', slug),
    title: withSportsProviderLabel(title, 'TS'),
    description: [sportName, mirrors[0].label, channel.flag ? String(channel.flag).toUpperCase() : '']
      .filter(Boolean)
      .join(' · '),
    category: route.category,
    url: mirrors[0].url,
    detailUrl: `${TIM_STREAMS_ORIGIN}/channel/${slug}`,
    poster: absoluteTimStreamsAsset(channel.logo),
    tags: ['live', 'timstreams', 'web-embed', route.sportTag, ...route.extraTags].filter(Boolean),
    source: 'Tim Streams',
    sourceKind: 'builtin',
    transport: 'direct',
    httpReferrer: TIM_STREAMS_MEDIA_REFERER,
    releasedAt: nowMs,
    eventViewers: Number.isFinite(viewersRaw) && viewersRaw >= 0 ? viewersRaw : undefined,
    eventSport: sportName,
    sportsAltSources: alts.length ? alts : undefined,
  }
}

export function timStreamsLiveUpcomingToItems(
  payload: TimStreamsLiveUpcoming,
  nowMs = Date.now(),
): StreamItem[] {
  const items: StreamItem[] = []
  for (const event of payload.events || []) {
    const item = timStreamsEventToItem(event, payload.genres, nowMs)
    if (item) items.push(item)
  }
  return items
}

export function timStreamsChannelsToItems(
  payload: TimStreamsChannels,
  nowMs = Date.now(),
): StreamItem[] {
  const items: StreamItem[] = []
  for (const channel of payload.channels || []) {
    const item = timStreamsChannelToItem(channel, nowMs)
    if (item) items.push(item)
  }
  return items
}

export function timStreamsItemSportId(item: StreamItem): string | undefined {
  if (!isTimStreamsCatalogItem(item)) return undefined
  const skip = new Set([
    'live',
    'live-now',
    'upcoming',
    'timstreams',
    'web-embed',
    'media3',
    'always-live',
    'kids-live',
    '247-series',
  ])
  return item.tags?.find((t) => t && !skip.has(String(t).toLowerCase()) && !String(t).includes('.'))
}

export function timStreamsSportChipsFromItems(
  items: StreamItem[],
): Array<{ id: string; name: string }> {
  const skip = new Set([
    'live',
    'live-now',
    'upcoming',
    'timstreams',
    'web-embed',
    'media3',
    'always-live',
    'kids-live',
    '247-series',
  ])
  const byId = new Map<string, string>()
  for (const item of items) {
    if (!isTimStreamsCatalogItem(item)) continue
    if (item.category !== 'sports') continue
    for (const raw of item.tags || []) {
      const id = String(raw || '').trim()
      if (!id || skip.has(id.toLowerCase()) || id.includes('.') || byId.has(id)) continue
      byId.set(
        id,
        SPORT_CHIP_NAME[id] ||
          id
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
      )
    }
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }))
}

async function fetchJson<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${TIM_STREAMS_ORIGIN}${path}`
  const referer = `${TIM_STREAMS_ORIGIN}/`
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, referer)
    if (!result.ok) {
      return { ok: false, error: result.error || `HTTP ${result.status}` }
    }
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
        headers: {
          Accept: 'application/json',
          Origin: TIM_STREAMS_ORIGIN,
        },
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
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: referer,
        Origin: TIM_STREAMS_ORIGIN,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

export async function fetchTimStreamsLiveCatalog(): Promise<{
  ok: boolean
  items: StreamItem[]
  error?: string
}> {
  const nowMs = Date.now()
  const [live, channels] = await Promise.all([
    fetchJson<TimStreamsLiveUpcoming>('/api/live-upcoming'),
    fetchJson<TimStreamsChannels>('/api/channels'),
  ])
  const items: StreamItem[] = []
  const errors: string[] = []
  if (live.ok) items.push(...timStreamsLiveUpcomingToItems(live.data, nowMs))
  else errors.push(live.error || 'live-upcoming failed')
  if (channels.ok) items.push(...timStreamsChannelsToItems(channels.data, nowMs))
  else errors.push(channels.error || 'channels failed')
  if (!items.length && errors.length) {
    return { ok: false, items: [], error: errors.join('; ') }
  }
  return { ok: true, items }
}
