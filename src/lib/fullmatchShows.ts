/**
 * FullMatchShows (fullmatchshows.com) — football full-match replays.
 * Catalog: WordPress REST /wp-json/wp/v2/posts
 * Play: myButton links → playmate.to / playmogo.com (Web Browser embeds).
 */

import type { StreamItem, StreamPlaylistItem } from '../types'
import { LIVEXTV_REPLAY_MAX_AGE_MS } from './livextvReplays'

export const FULLMATCHSHOWS_ORIGIN = 'https://fullmatchshows.com'
export const FULLMATCHSHOWS_API = `${FULLMATCHSHOWS_ORIGIN}/wp-json/wp/v2`
export const FULLMATCHSHOWS_ID_PREFIX = 'fms-replay-'

/** Prefer Playmate (SPA) over Playmogo (Cloudflare challenge often). */
const PLAY_HOST_SCORE = (url: string): number => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'playmate.to' || host.endsWith('.playmate.to')) return 3
    if (host === 'playmogo.com' || host.endsWith('.playmogo.com')) return 2
    if (/^\/[de]\//i.test(new URL(url).pathname)) return 1
  } catch {
    /* ignore */
  }
  return 0
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
    if (PLAY_HOST_SCORE(url) <= 0) continue
    seen.add(url)
    const name = decodeEntities(m[2] || '').slice(0, 48) || `Part ${out.length + 1}`
    out.push({ name, url })
  }
  // Fallback: any playmate / playmogo href in the post body.
  if (out.length === 0) {
    for (const m of html.matchAll(/href=["'](https?:\/\/(?:playmate\.to|playmogo\.com)[^"']+)["']/gi)) {
      const url = String(m[1] || '')
        .replace(/&amp;/g, '&')
        .trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push({ name: `Part ${out.length + 1}`, url })
    }
  }
  out.sort((a, b) => PLAY_HOST_SCORE(b.url) - PLAY_HOST_SCORE(a.url))
  return out
}

function withinReplayWindow(dateMs: number, nowMs: number): boolean {
  if (!Number.isFinite(dateMs) || dateMs <= 0) return false
  const age = nowMs - dateMs
  return age >= -6 * 60 * 60 * 1000 && age <= LIVEXTV_REPLAY_MAX_AGE_MS
}

function featuredImage(post: {
  _embedded?: { 'wp:featuredmedia'?: Array<{ source_url?: string }> }
}): string {
  const media = post._embedded?.['wp:featuredmedia']
  const url = media?.[0]?.source_url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : ''
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
  const play = servers[0]!.url
  const poster = featuredImage(post)

  return {
    id: fullmatchShowsItemId(id),
    title,
    description: ['Football', 'Replay', partsLabel, when].filter(Boolean).join(' · '),
    category: 'sports',
    url: play,
    detailUrl,
    poster: poster || undefined,
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
  | { ok: true; mode: 'embed'; url: string }
  | { ok: false; error: string }

/**
 * Pick a playable embed for a FullMatchShows replay (prefer Playmate).
 */
export async function resolveFullmatchShowsPlay(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'playlist' | 'id'>,
  preferredIndex = 0,
): Promise<FullmatchShowsPlayResult> {
  const candidates: string[] = []
  const playlist = item.playlist || []
  if (playlist.length > 0) {
    const start = Math.max(0, Math.min(preferredIndex, playlist.length - 1))
    for (let i = 0; i < playlist.length; i += 1) {
      const url = playlist[(start + i) % playlist.length]?.url
      if (url) candidates.push(url)
    }
  }
  if (item.url) candidates.push(item.url)

  const ranked = [...new Set(candidates.filter(Boolean))].sort(
    (a, b) => PLAY_HOST_SCORE(b) - PLAY_HOST_SCORE(a),
  )
  for (const url of ranked) {
    if (PLAY_HOST_SCORE(url) > 0) {
      return { ok: true, mode: 'embed', url }
    }
  }

  if (item.detailUrl && /fullmatchshows\.com/i.test(item.detailUrl)) {
    return { ok: true, mode: 'embed', url: item.detailUrl }
  }

  return { ok: false, error: 'No working FullMatchShows player for this match' }
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
