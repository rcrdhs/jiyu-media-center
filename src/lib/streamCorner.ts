/**
 * StreamCorner (streamcorner.st) — live sports + NBA VOD replays.
 * Replaces the retired Streamed.pk catalog. Play opens the site watch page in
 * Jiyu Web Browser (same path as PPV.st embeds).
 *
 * Catalog is scraped from the rendered homepage (SPA). The first HTML response
 * is an empty shell (no /stream or /nba links). Desktop polls a hidden window
 * until watch links exist. Android must do the same in the scrape WebView —
 * a single outerHTML read 1.8s after load often returns that shell.
 */

import type { StreamItem } from '../types'
import { androidBrowserFetchHtml, isAndroidInAppBrowser } from './androidBrowser'
import { LIVEXTV_REPLAY_MAX_AGE_MS } from './livextvReplays'

export const STREAMCORNER_ORIGIN = 'https://streamcorner.st'
export const STREAMCORNER_ID_PREFIX = 'streamcorner-'
export const STREAMCORNER_MIRRORS = [
  'https://streamcorner.st',
  'https://streamcorner.foo',
  'https://streamcorner.cloud',
  'https://streamcorner.fun',
] as const

export type StreamCornerEntry = {
  href: string
  title: string
  live?: boolean
  kind: 'live' | 'vod'
  provider?: string
  matchId?: string
  /** League label shown on the card (e.g. "NBA", "EPL", "24/7 STREAMS"). */
  league?: string
  /** Site data-category (unreliable: Alpha marks cricket/F1/NFL as "soccer"). */
  category?: string
  /** Card status such as "Final". */
  status?: string
  /** Card start time text, usually US Eastern (e.g. "11/02/26 06:00PM ET"). */
  start?: string
}

export function streamCornerItemId(kind: string, matchId: string): string {
  return `${STREAMCORNER_ID_PREFIX}${kind}-${encodeURIComponent(matchId)}`
}

export function isStreamCornerHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, '').toLowerCase()
  return (
    host === 'streamcorner.st' ||
    host.endsWith('.streamcorner.st') ||
    host === 'streamcorner.foo' ||
    host === 'streamcorner.cloud' ||
    host === 'streamcorner.fun' ||
    host === 'streamninja.cloud' ||
    host === 'streamninja.fun'
  )
}

export function isStreamCornerCatalogItem(item: {
  id?: string
  source?: string
  tags?: string[]
  url?: string
}): boolean {
  if (item.id?.startsWith(STREAMCORNER_ID_PREFIX)) return true
  if (/^streamcorner$/i.test(String(item.source || ''))) return true
  if (item.tags?.some((t) => /^streamcorner$/i.test(t))) return true
  try {
    if (item.url && isStreamCornerHost(new URL(item.url).hostname)) return true
  } catch {
    /* ignore */
  }
  return false
}

export function isStreamCornerReplayItem(item: StreamItem): boolean {
  return isStreamCornerCatalogItem(item) && Boolean(item.tags?.includes('replay'))
}

export function streamCornerItemSportId(item: StreamItem): string | undefined {
  if (!isStreamCornerCatalogItem(item)) return undefined
  return item.tags?.find(
    (t) =>
      t &&
      !/^(live|live-now|upcoming|replay|streamcorner|web-embed|popular|vod)$/i.test(t),
  )
}

/** Extract schedule cards from rendered StreamCorner HTML / live DOM. */
export function parseStreamCornerCatalogHtml(html: string): StreamCornerEntry[] {
  const cards = parseStreamCornerCards(html)
  if (cards.length) return cards
  const out: StreamCornerEntry[] = []
  const seen = new Set<string>()

  const push = (entry: StreamCornerEntry) => {
    const key = entry.href.replace(/#.*$/, '')
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(entry)
  }

  // Prefer heading + watch-link pairs so NBA titles aren't "Watch Replay".
  const blockRe = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>([\s\S]{0,1200})/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html))) {
    const heading = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const chunk = m[3] || ''
    if (!/\/(?:stream|nba)\//i.test(chunk)) continue
    const hrefRe = /href=["'](\/(?:stream|nba)\/[^"'#?]+)["']/gi
    let lm: RegExpExecArray | null
    while ((lm = hrefRe.exec(chunk))) {
      const parsed = entryFromPath(lm[1].trim(), heading)
      if (parsed) push(parsed)
    }
  }

  // Absolute or root-relative watch links (fills gaps without a nearby heading).
  const linkRe =
    /<a\b[^>]*\bhref=["'](\/(?:stream|nba)\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi
  while ((m = linkRe.exec(html))) {
    const path = m[1].trim()
    const inner = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
    const parsed = entryFromPath(path, inner)
    if (parsed) push(parsed)
  }

  // Fallback: bare href attributes if markup differs.
  if (out.length < 3) {
    const hrefRe = /href=["'](\/(?:stream|nba)\/[^"'#?]+)["']/gi
    while ((m = hrefRe.exec(html))) {
      const parsed = entryFromPath(m[1].trim(), '')
      if (parsed) push(parsed)
    }
  }

  return out
}

function decodeHtmlText(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTailWord(text: string, tail?: string): string {
  const t = decodeHtmlText(tail || '')
  if (t && text.toLowerCase().endsWith(` ${t.toLowerCase()}`)) {
    return text.slice(0, text.length - t.length).trim()
  }
  return text
}

const BAD_CARD_TITLE =
  /^(watch\s+(now|replay)|live|select a source|vs\.?|away logo|home logo|logo)$/i

/**
 * Card-scoped parse of the rendered schedule (each card is
 * `<div class="min-w-0 h-full">`). Titles/leagues come from the card that owns
 * the watch link, never from a neighbouring card.
 */
function parseStreamCornerCards(html: string): StreamCornerEntry[] {
  const marker = /<div class="min-w-0 h-full">/g
  const starts: number[] = []
  let mk: RegExpExecArray | null
  while ((mk = marker.exec(html))) starts.push(mk.index)
  const out: StreamCornerEntry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < starts.length; i++) {
    const end = Math.min(i + 1 < starts.length ? starts[i + 1] : html.length, starts[i] + 12000)
    const card = html.slice(starts[i], end)
    const hrefRe = /<a\b([^>]*)\bhref=["'](\/(?:stream|nba)\/[^"'#?]+)["']([^>]*)>([\s\S]*?)<\/a>/gi
    const links: Array<{ path: string; attrs: string; text: string }> = []
    let lm: RegExpExecArray | null
    while ((lm = hrefRe.exec(card))) {
      links.push({ path: lm[2].trim(), attrs: `${lm[1]} ${lm[3]}`, text: decodeHtmlText(lm[4]) })
    }
    if (!links.length) continue
    const attr = (name: string) => {
      const m = card.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))
      return m ? decodeHtmlText(m[1]) : ''
    }
    const field = (label: RegExp) => {
      const re = /<(span|div|p)\b[^>]*>([^<]*)<\/\1>\s*<(span|div|p)\b[^>]*>([^<]*)<\/\3>/gi
      let fm: RegExpExecArray | null
      while ((fm = re.exec(card))) {
        if (label.test(decodeHtmlText(fm[2]))) return decodeHtmlText(fm[4])
      }
      return ''
    }
    const category = attr('data-category')
    const firstP = card.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)
    const league = field(/^league$/i) || (firstP ? decodeHtmlText(firstP[1]) : '')
    let title = ''
    const heading = card.match(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/i)
    if (heading) title = decodeHtmlText(heading[2])
    if (!title || BAD_CARD_TITLE.test(title)) {
      const search = attr('data-search-text')
      title = search ? stripTailWord(stripTailWord(search, category), league) : ''
    }
    if (!title || BAD_CARD_TITLE.test(title)) {
      const alts = [...card.matchAll(/<img\b[^>]*\balt="([^"]*)"/gi)]
        .map((m) => decodeHtmlText(m[1]))
        .filter((t) => t && !/logo$/i.test(t))
      title = alts.length >= 2 ? `${alts[0]} vs ${alts[1]}` : alts[0] || ''
    }
    const leaves = [...card.matchAll(/>([^<>]{1,80})</g)].map((m) => decodeHtmlText(m[1]))
    const status = leaves.find((t) => /^(final|ft|full time|ended)\b/i.test(t)) || ''
    const start =
      attr('data-original-time') ||
      attr('data-time') ||
      field(/^(kick off|tip off|start time|starts?)$/i) ||
      leaves.find((t) => /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M/i.test(t)) ||
      ''
    const liveBadge = leaves.some((t) => /^live$/i.test(t))
    for (const link of links) {
      const base = entryFromPath(link.path, title)
      if (!base || seen.has(base.href)) continue
      seen.add(base.href)
      const watchNow = /watch now/i.test(link.text) || /watch now/i.test(card)
      base.live = !status && base.kind === 'live' && (liveBadge || watchNow)
      base.league = league || undefined
      base.category = category || undefined
      base.status = status || undefined
      base.start = start || undefined
      out.push(base)
    }
  }
  return out
}

function cleanStreamCornerTitle(raw: string, fallback: string): string {
  const cleaned = String(raw || '')
    .replace(/^(LIVE|Watch Now|Watch Replay)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || /^(watch\s+(now|replay)|live|select a source)$/i.test(cleaned)) {
    return fallback
  }
  return cleaned
}

function entryFromPath(path: string, titleRaw: string): StreamCornerEntry | null {
  const pathOnly = path.split(/[?#]/)[0]
  const nbaLive = pathOnly.match(/^\/nba\/live\/([^/]+)/i)
  const nbaVod = pathOnly.match(/^\/nba\/vod\/([^/]+)/i)
  const stream = pathOnly.match(/^\/stream\/([^/]+)\/([^/]+)/i)

  if (nbaVod) {
    return {
      href: pathOnly,
      title: cleanStreamCornerTitle(titleRaw, `NBA ${nbaVod[1]}`),
      kind: 'vod',
      live: false,
      provider: 'nba',
      matchId: nbaVod[1],
    }
  }
  if (nbaLive) {
    const live = /^LIVE\b/i.test(titleRaw) || /Watch Now/i.test(titleRaw)
    return {
      href: pathOnly,
      title: cleanStreamCornerTitle(titleRaw, `NBA ${nbaLive[1]}`),
      kind: 'live',
      live,
      provider: 'nba',
      matchId: nbaLive[1],
    }
  }
  if (stream) {
    const provider = stream[1].toLowerCase()
    const matchId = stream[2]
    const live = /^LIVE\b/i.test(titleRaw)
    return {
      href: pathOnly,
      title: cleanStreamCornerTitle(titleRaw, `${provider} ${matchId}`),
      kind: 'live',
      live,
      provider,
      matchId,
    }
  }
  return null
}

function absoluteWatchUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${STREAMCORNER_ORIGIN}${path}`
}

/**
 * Sport tag in the app's convention (see streamFree CATEGORY_TAG):
 * soccer → 'football', NFL/CFL/college → 'american-football', etc.
 * Order matters (e.g. "College Football" before generic football words).
 */
const STREAMCORNER_SPORT_RULES: Array<[RegExp, string]> = [
  [/\b(nfl|cfl|cfb|ncaaf?\s*football|college\s*football|american\s*football|redzone|red\s*zone)\b/i, 'american-football'],
  [/\b(nba|wnba|basketball|euroleague|ncaa\s*basketball)\b/i, 'basketball'],
  [/\b(nhl|hockey)\b/i, 'ice-hockey'],
  [/\b(mlb|baseball)\b/i, 'baseball'],
  [/\b(ufc|mma|boxing|fight\s*night|bellator|pfl|wwe|wrestling)\b/i, 'combat-sports'],
  [/\b(f1|formula\s*[1e]|grand\s*prix|motogp|moto[23]|nascar|indycar|supercars|motorsports?|rally|superbike)\b/i, 'motorsports'],
  [/\b(cricket|t20|odi|ipl|bbl|wbbl|big\s*bash)\b/i, 'cricket'],
  [/\b(tennis|atp|wta)\b/i, 'tennis'],
  [/\b(rugby|nrl|super\s*rugby)\b/i, 'rugby'],
  [/\b(golf|pga|lpga|liv\s*golf)\b/i, 'golf'],
  [/\b(afl|aflw|australian\s*football)\b/i, 'australian-football'],
  [/\b(darts)\b/i, 'darts'],
  [/\b(snooker)\b/i, 'snooker'],
  [/\b(cycling|cyclo-?cross|bmx|uci)\b/i, 'cycling'],
  [
    /\b(soccer|football|futbol|mls|epl|premier\s*league|la\s*liga|laliga|serie\s*[ab]|bundesliga|ligue\s*1|liga\s*portugal|eredivisie|brasileir|uefa|fifa|champions\s*league|europa\s*league|conference\s*league|a-league|nwsl|efl|fa\s*cup|copa|liga\s*mx|concacaf|eliteserien|allsvenskan|super\s*lig|primeira)\b/i,
    'football',
  ],
]

const STREAMCORNER_SPORT_NAMES: Record<string, string> = {
  football: 'Football',
  'american-football': 'American Football',
  'ice-hockey': 'Ice Hockey',
  'combat-sports': 'Combat Sports',
  motorsports: 'Motorsports',
  'australian-football': 'Australian Football',
}

function sportFromText(text?: string): string | undefined {
  const t = String(text || '')
  if (!t.trim()) return undefined
  for (const [re, tag] of STREAMCORNER_SPORT_RULES) if (re.test(t)) return tag
  return undefined
}

/** League first (most reliable), then title, then provider, then site category. */
function streamCornerSportTag(entry: StreamCornerEntry): string | undefined {
  const p = String(entry.provider || '').toLowerCase()
  const league = String(entry.league || '')
  const fromLeague = /^others?$|24\/7/i.test(league) ? undefined : sportFromText(league)
  return (
    fromLeague ||
    sportFromText(entry.title) ||
    (p === 'nba' || p === 'wnba' ? 'basketball' : undefined) ||
    (p === 'nfl' ? 'american-football' : undefined) ||
    sportFromText(entry.category)
  )
}

function streamCornerSportName(tag: string): string {
  return STREAMCORNER_SPORT_NAMES[tag] || tag.charAt(0).toUpperCase() + tag.slice(1)
}

/** 24/7 channel rows (e.g. "Family Guy") that are TV shows, not sports. */
function isStreamCornerNonSportsChannel(entry: StreamCornerEntry): boolean {
  const label = `${entry.league || ''} ${entry.category || ''}`
  if (!/24\s*\/\s*7|24-7/i.test(label)) return false
  const blob = `${entry.title || ''}`
  if (sportFromText(blob)) return false
  return !/\b(sports?|espn|tsn|sky\s*sports|bein|dazn|fox\s*sports|tnt|nfl|nba|nhl|mlb|ufc)\b/i.test(blob)
}

/** Parse "11/02/26 06:00PM ET" / "10/31/26 7:00 PM" as US Eastern time. */
export function parseStreamCornerStart(raw?: string): number | undefined {
  const m = String(raw || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([AP])M/i)
  if (!m) return undefined
  const month = Number(m[1])
  const day = Number(m[2])
  let year = Number(m[3])
  if (year < 100) year += 2000
  let hour = Number(m[4]) % 12
  if (/p/i.test(m[6])) hour += 12
  const minute = Number(m[5])
  // US DST: second Sunday of March 2:00 → first Sunday of November 2:00 (local).
  const nthSunday = (mon: number, n: number) => {
    const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay()
    return 1 + ((7 - first) % 7) + (n - 1) * 7
  }
  const dstStart = nthSunday(3, 2)
  const dstEnd = nthSunday(11, 1)
  const stamp = month * 10000 + day * 100 + hour
  const dst = stamp >= 3 * 10000 + dstStart * 100 + 2 && stamp < 11 * 10000 + dstEnd * 100 + 2
  const offsetHours = dst ? 4 : 5
  const ms = Date.UTC(year, month - 1, day, hour + offsetHours, minute)
  return Number.isFinite(ms) ? ms : undefined
}

/** Replay rows without a card date: remember when Jiyu first saw them so they still age out. */
const VOD_FIRST_SEEN_KEY = 'jiyu.streamcorner.vodFirstSeen.v1'
const VOD_FIRST_SEEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000

function readVodFirstSeen(): Record<string, number> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOD_FIRST_SEEN_KEY) : null
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeVodFirstSeen(map: Record<string, number>) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VOD_FIRST_SEEN_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** First time this VOD was seen (persisted); pruned after a week. */
export function streamCornerVodFirstSeen(matchId: string, nowMs = Date.now()): number {
  const map = readVodFirstSeen()
  let changed = false
  for (const [id, at] of Object.entries(map)) {
    if (!(Number(at) > 0) || nowMs - Number(at) > VOD_FIRST_SEEN_KEEP_MS) {
      delete map[id]
      changed = true
    }
  }
  let at = Number(map[matchId])
  if (!(at > 0)) {
    at = nowMs
    map[matchId] = at
    changed = true
  }
  if (changed) writeVodFirstSeen(map)
  return at
}

/** A game this long after tip-off counts as finished even without a "Final" badge. */
const VOD_ASSUME_FINISHED_MS = 3 * 60 * 60 * 1000

export function streamCornerEntryToItem(
  entry: StreamCornerEntry,
  nowMs = Date.now(),
): StreamItem | null {
  const matchId = String(entry.matchId || '').trim()
  if (!matchId) return null
  const kind = entry.kind === 'vod' ? 'vod' : 'live'
  const url = absoluteWatchUrl(entry.href)
  const title = String(entry.title || '').trim() || `StreamCorner ${matchId}`
  // 24/7 TV-show channels (Family Guy, …) are not sports.
  if (isStreamCornerNonSportsChannel(entry)) return null
  const sport = streamCornerSportTag(entry) || 'sports'
  const sportName = streamCornerSportName(sport)
  const league = String(entry.league || '').trim()
  const leagueLabel =
    league && !/^others?$|24\/7/i.test(league) && league.toLowerCase() !== sportName.toLowerCase()
      ? league
      : ''
  const final = /^(final|ft|full time|ended)\b/i.test(String(entry.status || ''))
  const startsAt = parseStreamCornerStart(entry.start)
  // Only admin/nfl cards have a real LIVE badge; Alpha/NBA always say "Watch Now".
  const badgeProvider = /^(admin|nfl)$/i.test(String(entry.provider || ''))
  if (kind === 'live') {
    // Finished NBA games: the VOD replay row covers them.
    if (final) return null
    // Games that started long ago and aren't flagged live are over
    // (admin/nfl show a LIVE badge while on; Alpha has none, so allow longer).
    const endedAfterMs = (badgeProvider ? 3 : 6) * 60 * 60 * 1000
    if (startsAt && nowMs - startsAt > endedAfterMs && !(badgeProvider && entry.live)) {
      return null
    }
  }
  const liveNow =
    kind === 'live' &&
    (badgeProvider || !startsAt ? Boolean(entry.live) : startsAt <= nowMs + 10 * 60 * 1000)
  const upcoming = kind === 'live' && !liveNow

  if (kind === 'vod') {
    // Real game date from the card; first-seen fallback so undated rows still expire.
    if (startsAt) {
      // Not played yet / still on: no replay to watch.
      if (startsAt > nowMs) return null
      if (!final && nowMs - startsAt < VOD_ASSUME_FINISHED_MS) return null
    }
    const playedAt = startsAt ?? streamCornerVodFirstSeen(matchId, nowMs)
    if (nowMs - playedAt > LIVEXTV_REPLAY_MAX_AGE_MS) return null
    return {
      id: streamCornerItemId('vod', matchId),
      title,
      description: ['NBA', 'StreamCorner', 'Replay'].join(' · '),
      category: 'sports',
      url,
      detailUrl: url,
      tags: ['replay', 'streamcorner', 'web-embed', 'basketball', 'vod'],
      source: 'StreamCorner',
      sourceKind: 'builtin',
      transport: 'direct',
      releasedAt: playedAt,
      eventStartsAt: startsAt,
      eventSport: 'Basketball',
    }
  }

  return {
    id: streamCornerItemId('live', `${entry.provider || 'x'}-${matchId}`),
    title,
    description: [leagueLabel, sportName, 'StreamCorner', liveNow ? 'Live' : 'Upcoming']
      .filter(Boolean)
      .join(' · '),
    category: 'sports',
    url,
    detailUrl: url,
    tags: [
      'live',
      'streamcorner',
      'web-embed',
      sport,
      liveNow ? 'live-now' : '',
      upcoming ? 'upcoming' : '',
    ].filter(Boolean),
    source: 'StreamCorner',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: nowMs,
    eventStartsAt: startsAt ?? (upcoming ? nowMs + 60 * 60 * 1000 : nowMs),
    eventSport: sportName,
  }
}

const EXTRACT_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const LINK_SEL = 'a[href*="/stream/"], a[href*="/nba/"]';
  const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
  const badTitle = (t) =>
    !t || t.length < 3 || /^(watch\\s+(now|replay)|live|select a source|vs|away logo|home logo|logo)$/i.test(t);
  const pathOf = (a) => (a.getAttribute('href') || '').replace(/^https?:\\/\\/[^/]+/i, '').split(/[?#]/)[0];
  const keyOf = (path) => {
    const m = path.match(/^\\/nba\\/(?:live|vod)\\/([^/]+)/i) || path.match(/^\\/stream\\/[^/]+\\/([^/]+)/i);
    return m ? m[1] : path;
  };
  // Card = highest ancestor whose watch links all point at this one match, so a
  // heading from a neighbouring card (e.g. a 24/7 channel) is never borrowed.
  const cardOf = (a, key) => {
    let card = a;
    for (let node = a.parentElement, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      let same = true;
      for (const l of node.querySelectorAll(LINK_SEL)) {
        if (keyOf(pathOf(l)) !== key) { same = false; break; }
      }
      if (!same) break;
      card = node;
    }
    return card;
  };
  const leafTexts = (card) =>
    [...card.querySelectorAll('span,p,div')].filter((el) => !el.children.length).map((el) => clean(el.textContent));
  const fieldAfter = (card, labelRe) => {
    for (const el of card.querySelectorAll('span,p,div')) {
      if (el.children.length || !labelRe.test(clean(el.textContent))) continue;
      const next = el.nextElementSibling;
      if (next) return clean(next.textContent);
    }
    return '';
  };
  const stripTail = (text, tail) => {
    const t = clean(tail);
    if (t && text.toLowerCase().endsWith(' ' + t.toLowerCase())) return clean(text.slice(0, text.length - t.length));
    return text;
  };
  const titleOf = (a, card, league, category) => {
    for (const h of card.querySelectorAll('h1,h2,h3,h4')) {
      const t = clean(h.innerText || h.textContent);
      if (!badTitle(t)) return t;
    }
    const search = clean(a.getAttribute('data-search-text') || card.getAttribute('data-search-text') || '');
    if (search) {
      const t = stripTail(stripTail(search, category), league);
      if (!badTitle(t)) return t;
    }
    for (const el of card.querySelectorAll('span,p')) {
      const t = clean(el.textContent);
      if (!el.children.length && /\\S\\s+(vs\\.?|v|at|@)\\s+\\S/i.test(t) && t.length < 120) return t;
    }
    const teams = [];
    for (const img of card.querySelectorAll('img[alt]')) {
      const alt = clean(img.getAttribute('alt'));
      if (!badTitle(alt) && !/logo$/i.test(alt) && !teams.includes(alt)) teams.push(alt);
    }
    if (teams.length >= 2) return teams[0] + ' vs ' + teams[1];
    if (teams.length === 1) return teams[0];
    const t = clean(a.innerText || a.textContent);
    return badTitle(t) || t.length > 80 || /kick off|tip off|start time|league/i.test(t) ? '' : t;
  };
  for (const a of document.querySelectorAll(LINK_SEL)) {
    const path = pathOf(a);
    if (!path || seen.has(path)) continue;
    if (!/^\\/(?:stream|nba)\\//i.test(path)) continue;
    seen.add(path);
    let kind = 'live';
    let provider = '';
    let matchId = '';
    let m = path.match(/^\\/nba\\/vod\\/([^/]+)/i);
    if (m) { kind = 'vod'; provider = 'nba'; matchId = m[1]; }
    else if ((m = path.match(/^\\/nba\\/live\\/([^/]+)/i))) { provider = 'nba'; matchId = m[1]; }
    else if ((m = path.match(/^\\/stream\\/([^/]+)\\/([^/]+)/i))) { provider = m[1]; matchId = m[2]; }
    if (!matchId) continue;
    const card = cardOf(a, keyOf(path));
    const linkText = clean(a.innerText || a.textContent);
    const texts = leafTexts(card);
    let league = fieldAfter(card, /^league$/i);
    if (!league) {
      const p = card.querySelector('p');
      league = p ? clean(p.textContent) : '';
    }
    const status = texts.find((t) => /^(final|ft|full time|ended)\\b/i.test(t)) || '';
    const dateRe = /^\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\s+\\d{1,2}:\\d{2}\\s*[AP]M/i;
    const start =
      clean(a.getAttribute('data-original-time') || a.getAttribute('data-time') || '') ||
      clean((card.querySelector('[data-original-time]') || { getAttribute: () => '' }).getAttribute('data-original-time') || '') ||
      fieldAfter(card, /^(kick off|tip off|start time|starts?)$/i) ||
      texts.find((t) => dateRe.test(t)) ||
      '';
    const category = clean(a.getAttribute('data-category') || card.getAttribute('data-category') || '');
    const live = !/^(final|ft|full time|ended)\\b/i.test(status) && (/^LIVE\\b/i.test(linkText) || /Watch Now/i.test(linkText));
    out.push({ href: path, title: titleOf(a, card, league, category), live, kind, provider, matchId, league, category, status, start });
  }
  return out;
})()`

async function fetchEntriesDesktop(): Promise<
  { ok: true; entries: StreamCornerEntry[] } | { ok: false; error: string }
> {
  const api = window.signalDesktop?.streamCornerFetchCatalog
  if (!api) return { ok: false, error: 'StreamCorner scrape needs the Jiyu desktop app.' }
  try {
    const result = await api()
    if (!result.ok) return { ok: false, error: result.error || 'StreamCorner scrape failed' }
    return { ok: true, entries: Array.isArray(result.entries) ? result.entries : [] }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchEntriesAndroid(): Promise<
  { ok: true; entries: StreamCornerEntry[] } | { ok: false; error: string }
> {
  if (!isAndroidInAppBrowser()) {
    return { ok: false, error: 'StreamCorner scrape needs the Android in-app browser.' }
  }
  let lastError = 'StreamCorner unavailable'
  for (const origin of STREAMCORNER_MIRRORS) {
    const result = await androidBrowserFetchHtml(`${origin}/`, { untilWatchLinks: true })
    if (!result.ok || !result.content) {
      lastError = result.error || `HTTP ${result.status}`
      continue
    }
    const entries = parseStreamCornerCatalogHtml(result.content)
    if (entries.length) return { ok: true, entries }
    lastError = 'No StreamCorner cards in page'
  }
  return { ok: false, error: lastError }
}

type EntriesResult =
  | { ok: true; entries: StreamCornerEntry[] }
  | { ok: false; error: string }

let entriesCache: { at: number; result: EntriesResult } | null = null
const ENTRIES_CACHE_MS = 60_000

export async function fetchStreamCornerEntries(): Promise<EntriesResult> {
  if (entriesCache && Date.now() - entriesCache.at < ENTRIES_CACHE_MS) {
    return entriesCache.result
  }

  let result: EntriesResult
  if (typeof window !== 'undefined' && window.signalDesktop?.streamCornerFetchCatalog) {
    result = await fetchEntriesDesktop()
  } else {
    try {
      const { Capacitor } = await import('@capacitor/core')
      if (Capacitor.isNativePlatform()) {
        result = await fetchEntriesAndroid()
      } else {
        // Dev browser: try a plain fetch (usually gets the shell only).
        try {
          const res = await fetch(`${STREAMCORNER_ORIGIN}/`, {
            headers: { Accept: 'text/html' },
          })
          if (!res.ok) {
            result = { ok: false, error: `HTTP ${res.status}` }
          } else {
            const html = await res.text()
            const entries = parseStreamCornerCatalogHtml(html)
            result = entries.length
              ? { ok: true, entries }
              : {
                  ok: false,
                  error: 'StreamCorner needs desktop or Android scrape (SPA).',
                }
          }
        } catch (err) {
          result = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }
    } catch {
      result = { ok: false, error: 'StreamCorner scrape unavailable' }
    }
  }

  if (result.ok) entriesCache = { at: Date.now(), result }
  return result
}

export async function fetchStreamCornerLiveCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchStreamCornerEntries()
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const nowMs = Date.now()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const entry of result.entries) {
    if (entry.kind === 'vod') continue
    const item = streamCornerEntryToItem(entry, nowMs)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  items.sort((a, b) => {
    const la = a.tags?.includes('live-now') ? 0 : 1
    const lb = b.tags?.includes('live-now') ? 0 : 1
    if (la !== lb) return la - lb
    return (a.eventStartsAt || 0) - (b.eventStartsAt || 0)
  })
  return { ok: true, items }
}

export async function fetchStreamCornerReplayCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchStreamCornerEntries()
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const nowMs = Date.now()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const entry of result.entries) {
    if (entry.kind !== 'vod') continue
    const item = streamCornerEntryToItem(entry, nowMs)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { ok: true, items }
}

/** Sports chips built from StreamCorner live rows. */
export function streamCornerSportsFromItems(
  items: StreamItem[],
): Array<{ id: string; name: string }> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (!isStreamCornerCatalogItem(item) || item.tags?.includes('replay')) continue
    const id = streamCornerItemSportId(item)
    if (!id) continue
    const name = streamCornerSportName(id)
    if (!map.has(id)) map.set(id, name)
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Exported for Electron IPC (same extract script). */
export const STREAMCORNER_EXTRACT_SCRIPT = EXTRACT_SCRIPT
