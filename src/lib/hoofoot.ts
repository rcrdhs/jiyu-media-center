/**
 * Hoofoot (hoofoot.net) — football highlights from the front page.
 * Catalog: scrape homepage highlight cards (SSR HTML), then keep only cards
 * whose match page still exposes a playable video id (site often lists the
 * card before / without publishing the player panel).
 * Play: video id → cdn.dailyvid.click HLS (master.m3u8), with thertstv
 * `/api/resolve?v=` as a secondary path when dailyvid is down.
 */

import type { StreamItem } from '../types'
import { sportsMatchPoster } from './sportsMatchPoster'

export const HOOFOOT_ORIGIN = 'https://hoofoot.net'
export const HOOFOOT_PLAYER_ORIGIN = 'https://hoofoot.thertstv.com'
export const HOOFOOT_ID_PREFIX = 'hoofoot-replay-'
const HOOFOOT_VID_TAG_PREFIX = 'hoofoot-vid:'
const DAILYVID_BASE = 'https://cdn.dailyvid.click/videos/'
const HOOFOOT_REFERER = `${HOOFOOT_ORIGIN}/`
/** Cap match-page probes so Replay refresh stays snappy. */
const HOOFOOT_PROBE_LIMIT = 24
const HOOFOOT_PROBE_CONCURRENCY = 6

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
}

export function hoofootItemId(slug: string): string {
  const key = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120)
  return `${HOOFOOT_ID_PREFIX}${key || 'match'}`
}

export function isHoofootCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
  detailUrl?: string
}): boolean {
  if (item.id?.startsWith(HOOFOOT_ID_PREFIX)) return true
  if (item.tags?.includes('hoofoot')) return true
  if (/^hoofoot$/i.test(String(item.source || ''))) return true
  try {
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'hoofoot.net' || host.endsWith('.hoofoot.net')) return true
      if (host === 'hoofoot.thertstv.com' || host.endsWith('.thertstv.com')) return true
      if (host === 'cdn.dailyvid.click' || host.endsWith('.dailyvid.click')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function hoofootVidTag(videoId: string): string {
  return `${HOOFOOT_VID_TAG_PREFIX}${videoId}`
}

function videoIdFromItemTags(item: { tags?: string[] }): string | null {
  for (const raw of item.tags || []) {
    const tag = String(raw || '')
    if (tag.startsWith(HOOFOOT_VID_TAG_PREFIX)) {
      const id = tag.slice(HOOFOOT_VID_TAG_PREFIX.length).trim()
      if (/^[a-z0-9]{6,32}$/i.test(id)) return id
    }
  }
  return null
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

function titleFromSlug(slug: string): string {
  const base = String(slug || '')
    .replace(/-highlights?-.*$/i, '')
    .replace(/-/g, ' ')
    .trim()
  if (!base) return 'Football Highlights'
  return base.replace(/\bvs\b/i, 'vs').replace(/\b\w/g, (c) => c.toUpperCase())
}

function parseSlugDate(slug: string): number {
  const m = String(slug || '').match(
    /-([a-z]+)-(\d{1,2})-(\d{4})(?:\/)?$/i,
  )
  if (!m) return 0
  const month = MONTHS[String(m[1] || '').toLowerCase()]
  const day = Number(m[2])
  const year = Number(m[3])
  if (month == null || !day || !year) return 0
  const ms = Date.UTC(year, month, day, 20, 0, 0)
  return Number.isFinite(ms) ? ms : 0
}

function leagueLabel(slug: string): string {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

async function fetchHtml(
  url: string,
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  const { nativeFetchText, isNativeHttpPlatform } = await import('./nativeHttp')
  if (window.signalDesktop?.fetchHtml || isNativeHttpPlatform()) {
    // Catalog / resolve from Replay refresh — no CF Verify window on desktop/dev.
    const result = await nativeFetchText(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Referer: HOOFOOT_REFERER,
      },
      quiet: true,
      allowUnlock: false,
    })
    if (!result.ok || !result.content) {
      return { ok: false, error: result.error || 'Hoofoot unavailable' }
    }
    return { ok: true, html: result.content }
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Referer: HOOFOOT_REFERER,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, html: await res.text() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Hoofoot fetch failed' }
  }
}

type HomeCard = {
  path: string
  league: string
  slug: string
  home: string
  away: string
  homeLogo?: string
  awayLogo?: string
  score?: string
}

function parseHomeHighlightCards(html: string): HomeCard[] {
  const out: HomeCard[] = []
  const seen = new Set<string>()
  const re =
    /<a\s+href="(\/full-matches\/([^/"]+)\/([^/"]+)\/)"[^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    const path = String(m[1] || '')
    const league = String(m[2] || '')
    const slug = String(m[3] || '')
    const inner = String(m[4] || '')
    if (!path || !slug || !/highlight/i.test(slug)) continue
    if (seen.has(path)) continue
    seen.add(path)

    const alts = [...inner.matchAll(/alt="([^"]+)"/gi)].map((x) =>
      decodeEntities(x[1] || ''),
    )
    const logos = [...inner.matchAll(/src="(https?:\/\/[^"]+logos\/[^"]+)"/gi)].map(
      (x) => String(x[1] || ''),
    )
    const scores = [...inner.matchAll(/>(\d+)</g)].map((x) => x[1]!)
    const home = alts[0] || ''
    const away = alts[1] || ''
    const score =
      scores.length >= 2 ? `${scores[0]}-${scores[1]}` : scores[0] || undefined

    out.push({
      path,
      league,
      slug,
      home,
      away,
      homeLogo: logos[0],
      awayLogo: logos[1],
      score,
    })
  }
  return out
}

function cardToItem(card: HomeCard, nowMs: number, videoId?: string): StreamItem {
  const title =
    card.home && card.away
      ? `${card.home} vs ${card.away} Highlights`
      : `${titleFromSlug(card.slug)} Highlights`
  const dateMs = parseSlugDate(card.slug)
  const when =
    dateMs > 0
      ? new Date(dateMs).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })
      : ''
  const league = leagueLabel(card.league)
  const detailUrl = `${HOOFOOT_ORIGIN}${card.path}`
  const poster = sportsMatchPoster(title, {
    subtitle: 'Football',
    homeLogo: card.homeLogo,
    awayLogo: card.awayLogo,
  })
  const tags = ['replay', 'hoofoot', 'hls', 'football', 'highlights']
  if (videoId) tags.push(hoofootVidTag(videoId))

  return {
    id: hoofootItemId(card.slug),
    title,
    description: ['Football', 'Highlights', league, card.score, when]
      .filter(Boolean)
      .join(' · '),
    category: 'sports',
    // Prefer a direct HLS URL when we already know the video id so Watch can
    // skip a second match-page scrape; resolveHoofootPlay still re-checks.
    url: videoId ? `${DAILYVID_BASE}${videoId}/master.m3u8` : detailUrl,
    detailUrl,
    poster,
    homeBadgeUrl: card.homeLogo,
    awayBadgeUrl: card.awayLogo,
    tags,
    source: 'Hoofoot',
    sourceKind: 'builtin',
    transport: 'direct',
    httpReferrer: HOOFOOT_REFERER,
    releasedAt: dateMs > 0 ? dateMs : nowMs,
    eventStartsAt: dateMs > 0 ? dateMs : undefined,
    eventEndsAt: dateMs > 0 ? dateMs : undefined,
    eventSport: 'Football',
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await worker(items[i]!, i)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => run()))
  return out
}

export async function fetchHoofootReplayCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const page = await fetchHtml(HOOFOOT_ORIGIN + '/')
  if (!page.ok) return { ok: false, error: page.error, items: [] }
  const cards = parseHomeHighlightCards(page.html)
  if (cards.length === 0) {
    return { ok: false, error: 'No Hoofoot highlights on the front page', items: [] }
  }
  const nowMs = Date.now()
  // Homepage cards are stats teasers — many have no player panel yet. Probe a
  // bounded batch of match pages and only shelf titles with a real video id.
  const probeCards = cards.slice(0, HOOFOOT_PROBE_LIMIT)
  const probed = await mapPool(probeCards, HOOFOOT_PROBE_CONCURRENCY, async (card) => {
    const detailUrl = `${HOOFOOT_ORIGIN}${card.path}`
    const matchPage = await fetchHtml(detailUrl)
    if (!matchPage.ok) return null
    const videoId = extractHoofootVideoId(matchPage.html)
    if (!videoId) return null
    return cardToItem(card, nowMs, videoId)
  })
  const items = probed.filter((item): item is StreamItem => Boolean(item))
  // ok:true + empty is fine — site listed cards but published no videos.
  return { ok: true, items }
}

export type HoofootPlayResult =
  | { ok: true; mode: 'hls'; url: string; referer: string }
  | { ok: false; error: string }

/** Pull a dailyvid / player video id from match-page HTML (current + legacy). */
export function extractHoofootVideoId(html: string): string | null {
  const patterns = [
    /data-token=["']r2:([a-z0-9]+)["']/i,
    /token\s*=\s*["']r2:([a-z0-9]+)["']/i,
    /hoofoot\.thertstv\.com\/\?[^"'>\s]*[?&]v=([a-z0-9]+)/i,
    /thertstv\.com\/\?[^"'>\s]*[?&]v=([a-z0-9]+)/i,
    /cdn\.dailyvid\.click\/videos\/([a-z0-9]{6,32})\//i,
    /["']v["']\s*:\s*["']([a-z0-9]{6,32})["']/i,
    /data-v(?:ideo)?(?:-id)?=["']([a-z0-9]{6,32})["']/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * Prefer free master.m3u8 (360/480). master_hd needs /api/hd-key AES.
 * Fall back to 720p.mp4 when index.json says progressive-only.
 */
async function resolveDailyvidUrl(videoId: string): Promise<string | null> {
  const base = `${DAILYVID_BASE}${videoId}/`
  const indexUrl = `${base}index.json`
  try {
    const { nativeFetchText, isNativeHttpPlatform } = await import('./nativeHttp')
    let text = ''
    if (window.signalDesktop?.fetchHtml || isNativeHttpPlatform()) {
      const r = await nativeFetchText(indexUrl, {
        headers: { Accept: 'application/json', Referer: HOOFOOT_REFERER },
        quiet: true,
      })
      if (r.ok) text = r.content
    } else {
      const res = await fetch(indexUrl, {
        headers: { Accept: 'application/json', Referer: HOOFOOT_REFERER },
      })
      if (res.ok) text = await res.text()
    }
    if (text) {
      const data = JSON.parse(text) as {
        type?: string
        master?: string
        masterHd?: string
      }
      if (data.type === 'hls' || data.master) {
        // Free ladder (no AES). HD playlist needs hoofoot /api/hd-key.
        return `${base}${data.master || 'master.m3u8'}`
      }
    }
  } catch {
    /* fall through */
  }
  // Default HLS path used by the site when index.json is unreachable.
  return `${base}master.m3u8`
}

async function resolveViaThertstv(videoId: string): Promise<string | null> {
  const url = `${HOOFOOT_PLAYER_ORIGIN}/api/resolve?v=${encodeURIComponent(videoId)}`
  try {
    const { nativeFetchText, isNativeHttpPlatform } = await import('./nativeHttp')
    let text = ''
    if (window.signalDesktop?.fetchHtml || isNativeHttpPlatform()) {
      const r = await nativeFetchText(url, {
        headers: {
          Accept: 'application/json',
          Referer: `${HOOFOOT_PLAYER_ORIGIN}/`,
          Origin: HOOFOOT_PLAYER_ORIGIN,
        },
        quiet: true,
      })
      if (r.ok) text = r.content
    } else {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Referer: `${HOOFOOT_PLAYER_ORIGIN}/` },
        credentials: 'omit',
      })
      if (res.ok) text = await res.text()
    }
    if (!text) return null
    const data = JSON.parse(text) as { url?: string; type?: string }
    const resolved = String(data.url || '').trim()
    if (/^https?:\/\//i.test(resolved)) return resolved
  } catch {
    /* ignore */
  }
  return null
}

export async function resolveHoofootPlay(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'id' | 'tags'>,
): Promise<HoofootPlayResult> {
  let videoId = videoIdFromItemTags(item)
  if (!videoId) {
    const fromUrl = String(item.url || '').match(
      /cdn\.dailyvid\.click\/videos\/([a-z0-9]{6,32})\//i,
    )
    if (fromUrl?.[1]) videoId = fromUrl[1]
  }

  const detail = String(item.detailUrl || '').trim()
  if (!videoId) {
    const pageUrl =
      detail ||
      ( /hoofoot\.net/i.test(String(item.url || ''))
        ? String(item.url || '').trim()
        : '')
    if (!pageUrl || !/hoofoot\.net/i.test(pageUrl)) {
      return { ok: false, error: 'Missing Hoofoot match page' }
    }
    const page = await fetchHtml(pageUrl)
    if (!page.ok) return { ok: false, error: page.error }
    videoId = extractHoofootVideoId(page.html)
  }

  if (!videoId) {
    return {
      ok: false,
      error: 'Hoofoot listed this match but has not published a video yet',
    }
  }

  const daily = await resolveDailyvidUrl(videoId)
  if (daily) return { ok: true, mode: 'hls', url: daily, referer: HOOFOOT_REFERER }

  const viaPlayer = await resolveViaThertstv(videoId)
  if (viaPlayer) {
    return { ok: true, mode: 'hls', url: viaPlayer, referer: `${HOOFOOT_PLAYER_ORIGIN}/` }
  }
  return { ok: false, error: 'Could not resolve Hoofoot stream' }
}
