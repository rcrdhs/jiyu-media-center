/**
 * FootballOrgin (footballorgin.com) — league highlight packages for Replay.
 * Catalog: WordPress REST posts for Premier League / Bundesliga / Serie A.
 * Play: cmb2 vm_video_url → YouTube watch, ok.ru embed, or other iframe src.
 */

import type { StreamItem } from '../types'
import { sportsMatchPoster } from './sportsMatchPoster'

export const FOOTBALLORGIN_ORIGIN = 'https://www.footballorgin.com'
export const FOOTBALLORGIN_API = `${FOOTBALLORGIN_ORIGIN}/wp-json/wp/v2`
export const FOOTBALLORGIN_ID_PREFIX = 'footballorgin-replay-'
const FOOTBALLORGIN_REFERER = `${FOOTBALLORGIN_ORIGIN}/`

/** Weekly highlight shows stay useful longer than single-match replays. */
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000

const HIGHLIGHTS_CAT = 1614
const REVIEW_SHOW_CAT = 10

const LEAGUES = [
  { id: 9, name: 'Premier League', slug: 'premier-league-epl' },
  { id: 155, name: 'Bundesliga', slug: 'bundesliga' },
  { id: 12, name: 'Serie A', slug: 'serie-a' },
] as const

type LeagueName = (typeof LEAGUES)[number]['name']

type WpPost = {
  id: number
  date?: string
  link?: string
  title?: { rendered?: string }
  categories?: number[]
  cmb2?: {
    video_player_settings?: {
      vm_video_url?: string
      vm_video_multi_links?: Array<{ ml_label?: string; ml_shortcode?: string }>
    }
  }
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string }>
  }
}

export function footballOrginItemId(postId: string | number): string {
  return `${FOOTBALLORGIN_ID_PREFIX}${postId}`
}

export function isFootballOrginCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
  detailUrl?: string
}): boolean {
  if (item.id?.startsWith(FOOTBALLORGIN_ID_PREFIX)) return true
  if (item.tags?.includes('footballorgin')) return true
  if (/^footballorgin$/i.test(String(item.source || ''))) return true
  try {
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'footballorgin.com' || host.endsWith('.footballorgin.com')) return true
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

function withinAge(dateMs: number, nowMs: number): boolean {
  if (!dateMs) return true
  const age = nowMs - dateMs
  return age >= -6 * 60 * 60 * 1000 && age <= MAX_AGE_MS
}

function isHighlightTitle(title: string): boolean {
  const t = String(title || '')
  if (/full\s*match/i.test(t)) return false
  return /highlight|weekend\s*wrap|every\s*goal|match\s*of\s*the\s*day|\bmotd\b|review\s*show|all\s*highlights/i.test(
    t,
  )
}

function leagueForPost(post: WpPost, title: string): LeagueName | null {
  const cats = post.categories || []
  for (const league of LEAGUES) {
    if (cats.includes(league.id)) return league.name
  }
  // Weekend Wrap / MOTD often miss the Premier League category id.
  if (/premier\s*league|weekend\s*wrap|\bmotd\b|match\s*of\s*the\s*day/i.test(title)) {
    return 'Premier League'
  }
  if (/bundesliga/i.test(title)) return 'Bundesliga'
  if (/serie\s*a/i.test(title)) return 'Serie A'
  return null
}

function isHighlightPost(post: WpPost, title: string): boolean {
  const cats = post.categories || []
  if (/full\s*match/i.test(title)) return false
  if (cats.includes(HIGHLIGHTS_CAT) || cats.includes(REVIEW_SHOW_CAT)) {
    return isHighlightTitle(title) || cats.includes(HIGHLIGHTS_CAT)
  }
  return isHighlightTitle(title)
}

function absoluteUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  return s
}

/** Pull a playable URL out of vm_video_url (plain link or iframe HTML). */
export function extractFootballOrginPlayUrl(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  if (!/<iframe/i.test(text) && /^https?:\/\//i.test(text)) return text
  const src = text.match(/src=["']([^"']+)["']/i)?.[1]
  if (src) return absoluteUrl(src)
  const yt = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+)/i,
  )
  if (yt?.[0]) return yt[0]
  const ok = text.match(/https?:\/\/(?:www\.)?ok\.ru\/videoembed\/\d+/i)
  if (ok?.[0]) return ok[0]
  return null
}

function normalizeYoutubeWatch(url: string): string {
  try {
    const u = new URL(url)
    if (/youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, '').split('/')[0]
      if (id) return `https://www.youtube.com/watch?v=${id}`
    }
    if (/youtube\.com$/i.test(u.hostname.replace(/^www\./, '')) || u.hostname.endsWith('.youtube.com')) {
      const id = u.searchParams.get('v')
      if (id) return `https://www.youtube.com/watch?v=${id}`
      const emb = u.pathname.match(/^\/embed\/([\w-]+)/i)?.[1]
      if (emb) return `https://www.youtube.com/watch?v=${emb}`
    }
  } catch {
    /* ignore */
  }
  return url
}

function playUrlFromPost(post: WpPost): string | null {
  const settings = post.cmb2?.video_player_settings
  const primary = extractFootballOrginPlayUrl(String(settings?.vm_video_url || ''))
  if (primary) {
    if (/youtube\.com|youtu\.be/i.test(primary)) return normalizeYoutubeWatch(primary)
    return primary
  }
  for (const row of settings?.vm_video_multi_links || []) {
    const alt = extractFootballOrginPlayUrl(String(row.ml_shortcode || ''))
    if (alt) return alt
  }
  return null
}

async function fetchJson(
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${FOOTBALLORGIN_API}${path}`
  const { nativeFetchText, isNativeHttpPlatform } = await import('./nativeHttp')

  if (window.signalDesktop?.fetchHtml || isNativeHttpPlatform()) {
    // Background Replay sync — never pop Cloudflare Verify on desktop/dev.
    const result = await nativeFetchText(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: FOOTBALLORGIN_REFERER,
      },
      quiet: true,
      allowUnlock: false,
    })
    if (!result.ok || !result.content) {
      return { ok: false, error: result.error || 'FootballOrgin unavailable' }
    }
    try {
      return { ok: true, data: JSON.parse(result.content) }
    } catch {
      return { ok: false, error: 'FootballOrgin returned invalid JSON' }
    }
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: FOOTBALLORGIN_REFERER,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'FootballOrgin fetch failed',
    }
  }
}

function postToItem(post: WpPost, league: LeagueName, nowMs: number): StreamItem | null {
  const id = String(post.id || '').trim()
  const title = decodeEntities(post.title?.rendered || '')
  if (!id || !title) return null
  const dateMs = post.date ? Date.parse(post.date) : 0
  if (!withinAge(dateMs, nowMs)) return null
  if (!isHighlightPost(post, title)) return null

  const detailUrl = String(post.link || `${FOOTBALLORGIN_ORIGIN}/?p=${id}`).trim()
  const play = playUrlFromPost(post) || detailUrl
  const poster =
    post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
    sportsMatchPoster(title, league)
  const when =
    dateMs > 0
      ? new Date(dateMs).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })
      : ''

  return {
    id: footballOrginItemId(id),
    title,
    description: ['Football', 'Highlights', league, when].filter(Boolean).join(' · '),
    category: 'sports',
    url: play,
    detailUrl,
    poster,
    tags: [
      'replay',
      'footballorgin',
      'web-embed',
      'football',
      'highlights',
      league.toLowerCase().replace(/\s+/g, '-'),
    ],
    source: 'FootballOrgin',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: dateMs > 0 ? dateMs : nowMs,
    eventStartsAt: dateMs > 0 ? dateMs : undefined,
    eventEndsAt: dateMs > 0 ? dateMs : undefined,
    eventSport: 'Football',
  }
}

async function fetchLeaguePosts(categoryId: number): Promise<WpPost[]> {
  const qs = new URLSearchParams({
    categories: String(categoryId),
    per_page: '25',
    page: '1',
    orderby: 'date',
    order: 'desc',
    _embed: '1',
    _fields: 'id,date,link,title,categories,cmb2,_links,_embedded',
  })
  const result = await fetchJson(`/posts?${qs.toString()}`)
  if (!result.ok) return []
  return Array.isArray(result.data) ? (result.data as WpPost[]) : []
}

async function fetchSearchPosts(query: string): Promise<WpPost[]> {
  const qs = new URLSearchParams({
    search: query,
    per_page: '12',
    orderby: 'date',
    order: 'desc',
    _embed: '1',
    _fields: 'id,date,link,title,categories,cmb2,_links,_embedded',
  })
  const result = await fetchJson(`/posts?${qs.toString()}`)
  if (!result.ok) return []
  return Array.isArray(result.data) ? (result.data as WpPost[]) : []
}

export async function fetchFootballOrginReplayCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const nowMs = Date.now()
  const [bund, epl, serie, wrapSearch, serieSearch, bundSearch] = await Promise.all([
    fetchLeaguePosts(155),
    fetchLeaguePosts(9),
    fetchLeaguePosts(12),
    fetchSearchPosts('Premier League Weekend Wrap'),
    fetchSearchPosts('Serie A Every goal'),
    fetchSearchPosts('Bundesliga Highlights'),
  ])

  const rows = [...bund, ...epl, ...serie, ...wrapSearch, ...serieSearch, ...bundSearch]
  if (rows.length === 0) {
    return { ok: false, error: 'No FootballOrgin highlights found', items: [] }
  }

  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const title = decodeEntities(row.title?.rendered || '')
    const league = leagueForPost(row, title)
    if (!league) continue
    const item = postToItem(row, league, nowMs)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }

  items.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
  if (items.length === 0) {
    return { ok: false, error: 'No recent EPL / Bundesliga / Serie A highlights', items: [] }
  }
  return { ok: true, items }
}

export type FootballOrginPlayResult =
  | { ok: true; mode: 'embed'; url: string }
  | { ok: false; error: string }

export async function resolveFootballOrginPlay(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'id'>,
): Promise<FootballOrginPlayResult> {
  const existing = extractFootballOrginPlayUrl(String(item.url || ''))
  if (
    existing &&
    !/footballorgin\.com/i.test(existing) &&
    (/youtube\.com|youtu\.be|ok\.ru|mixdrop/i.test(existing) || /^https?:\/\//i.test(existing))
  ) {
    const url = /youtube\.com|youtu\.be/i.test(existing)
      ? normalizeYoutubeWatch(existing)
      : existing
    return { ok: true, mode: 'embed', url }
  }

  const detail = String(item.detailUrl || '').trim()
  const postId = item.id?.startsWith(FOOTBALLORGIN_ID_PREFIX)
    ? item.id.slice(FOOTBALLORGIN_ID_PREFIX.length)
    : ''
  const apiPath = postId
    ? `/posts/${postId}?_fields=id,cmb2,link,title`
    : detail
      ? null
      : null

  if (apiPath) {
    const result = await fetchJson(apiPath)
    if (result.ok && result.data && typeof result.data === 'object') {
      const play = playUrlFromPost(result.data as WpPost)
      if (play) return { ok: true, mode: 'embed', url: play }
    }
  }

  if (detail && /footballorgin\.com/i.test(detail)) {
    // Last resort: open the site post (player lives on the page).
    return { ok: true, mode: 'embed', url: detail }
  }

  return { ok: false, error: 'No FootballOrgin player for this highlight' }
}
