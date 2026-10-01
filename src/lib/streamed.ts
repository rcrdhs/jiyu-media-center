/**
 * Streamed (streamed.pk) — free sports match API.
 * Catalog: live matches → Sports shelf. Play: embed.st URL in Jiyu Web Browser
 * (no stable native HLS from the public API).
 */

import type { StreamItem } from '../types'
import { rankSourcesWithLearning, recordStreamProbeResult } from './streamLearning'

export const STREAMED_API_ORIGIN = 'https://streamed.pk'
export const STREAMED_ID_PREFIX = 'streamed-'

export interface StreamedMatchSource {
  source: string
  id: string
}

export interface StreamedMatch {
  id: string
  title: string
  category: string
  date: number
  poster?: string
  popular?: boolean
  teams?: {
    home?: { name: string; badge?: string }
    away?: { name: string; badge?: string }
  }
  sources: StreamedMatchSource[]
}

export interface StreamedStream {
  id: string
  streamNo: number
  language: string
  hd: boolean
  embedUrl: string
  source: string
  viewers?: number
}

export type StreamedPlayResult =
  | { ok: true; url: string; language?: string; hd?: boolean; streamNo?: number }
  | { ok: false; error: string }

function absoluteImageUrl(path?: string): string | undefined {
  if (!path) return undefined
  if (/^https?:\/\//i.test(path)) return path
  return `${STREAMED_API_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`
}

export function streamedItemId(matchId: string): string {
  return `${STREAMED_ID_PREFIX}${matchId}`
}

export function isStreamedCatalogItem(item: {
  id?: string
  streamedMatchId?: string
  url?: string
}): boolean {
  if (item.streamedMatchId) return true
  if (item.id?.startsWith(STREAMED_ID_PREFIX)) return true
  try {
    if (item.url) {
      const host = new URL(item.url).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'streamed.pk' || host.endsWith('.streamed.pk')) return true
      if (host === 'embed.st' || host.endsWith('.embed.st')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

async function fetchJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${STREAMED_API_ORIGIN}${path}`
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, `${STREAMED_API_ORIGIN}/`)
    if (!result.ok) {
      return { ok: false, error: result.error || `HTTP ${result.status}` }
    }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null') as T }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }
  // Android: CapacitorHttp (Referer + no WebView CORS surprises).
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJson } = await import('./nativeHttp')
      const result = await nativeFetchJson<T>(url, {
        referer: `${STREAMED_API_ORIGIN}/`,
        headers: { Accept: 'application/json' },
      })
      if (!result.ok || result.data == null) {
        return { ok: false, error: result.error || 'Streamed request failed' }
      }
      return { ok: true, data: result.data }
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: `${STREAMED_API_ORIGIN}/`,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Streamed request failed',
    }
  }
}

export interface StreamedSport {
  id: string
  name: string
}

export async function fetchStreamedSports(): Promise<
  { ok: true; sports: StreamedSport[] } | { ok: false; error: string }
> {
  const result = await fetchJson<StreamedSport[]>('/api/sports')
  if (!result.ok) return result
  if (!Array.isArray(result.data)) return { ok: false, error: 'Invalid sports response' }
  return {
    ok: true,
    sports: result.data
      .map((s) => ({
        id: String(s?.id || '').trim(),
        name: String(s?.name || '').trim(),
      }))
      .filter((s) => s.id && s.name),
  }
}

/** Currently live matches (optionally popular-only). */
export async function fetchStreamedLiveMatches(
  popularOnly = false,
): Promise<{ ok: true; matches: StreamedMatch[] } | { ok: false; error: string }> {
  const path = popularOnly ? '/api/matches/live/popular' : '/api/matches/live'
  const result = await fetchJson<StreamedMatch[]>(path)
  if (!result.ok) return result
  if (!Array.isArray(result.data)) return { ok: false, error: 'Invalid matches response' }
  return { ok: true, matches: result.data }
}

/**
 * Merge `/api/matches/live` + `/api/matches/live/popular`.
 * Popular endpoint wins the popular flag even when the live row omits it.
 */
export function mergeStreamedLiveCatalog(
  live: StreamedMatch[],
  popular: StreamedMatch[],
): StreamItem[] {
  const popularIds = new Set(
    popular.map((m) => String(m?.id || '').trim()).filter(Boolean),
  )
  const byId = new Map<string, StreamedMatch>()
  for (const match of [...popular, ...live]) {
    const id = String(match?.id || '').trim()
    if (!id) continue
    const prev = byId.get(id)
    byId.set(id, {
      ...prev,
      ...match,
      id,
      popular: popularIds.has(id) || Boolean(match.popular) || Boolean(prev?.popular),
      sources:
        Array.isArray(match.sources) && match.sources.length > 0
          ? match.sources
          : prev?.sources || [],
    })
  }
  return streamedMatchesToItems([...byId.values()])
}

export function streamedItemSportId(item: StreamItem): string | undefined {
  if (!isStreamedCatalogItem(item)) return undefined
  return item.tags?.find(
    (t) => t && t !== 'live' && t !== 'streamed' && t !== 'popular',
  )
}

export function isStreamedPopularItem(item: StreamItem): boolean {
  return isStreamedCatalogItem(item) && Boolean(item.tags?.includes('popular'))
}

export function streamedMatchToItem(match: StreamedMatch): StreamItem | null {
  if (!match?.id || !match.title) return null
  if (!Array.isArray(match.sources) || match.sources.length === 0) return null

  const sport = (match.category || 'sports').replace(/-/g, ' ')
  const eventSport = sport
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
  const when =
    Number.isFinite(match.date) && match.date > 0
      ? new Date(match.date).toLocaleString(undefined, {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })
      : ''
  const home = match.teams?.home?.name
  const away = match.teams?.away?.name
  const teamsLine = home && away ? `${home} vs ${away}` : match.title

  const poster =
    absoluteImageUrl(match.poster) ||
    absoluteImageUrl(
      match.teams?.home?.badge
        ? `/api/images/badge/${match.teams.home.badge}.webp`
        : undefined,
    )

  return {
    id: streamedItemId(match.id),
    title: match.title,
    description: [eventSport || sport, when, teamsLine !== match.title ? teamsLine : '']
      .filter(Boolean)
      .join(' · '),
    category: 'sports',
    url: `${STREAMED_API_ORIGIN}/`,
    detailUrl: `${STREAMED_API_ORIGIN}/`,
    poster,
    tags: ['live', 'streamed', match.category, match.popular ? 'popular' : '']
      .filter(Boolean),
    source: 'Streamed',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: Number.isFinite(match.date) ? match.date : Date.now(),
    eventStartsAt: Number.isFinite(match.date) && match.date > 0 ? match.date : undefined,
    eventSport: eventSport || undefined,
    streamedMatchId: match.id,
    streamedSources: match.sources.map((s) => ({
      source: String(s.source || '').trim(),
      id: String(s.id || '').trim(),
    })).filter((s) => s.source && s.id),
  }
}

export function streamedMatchesToItems(matches: StreamedMatch[]): StreamItem[] {
  const out: StreamItem[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const item = streamedMatchToItem(match)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  // Popular + soonest first
  out.sort((a, b) => {
    const ap = a.tags?.includes('popular') ? 1 : 0
    const bp = b.tags?.includes('popular') ? 1 : 0
    if (ap !== bp) return bp - ap
    return (b.releasedAt || 0) - (a.releasedAt || 0)
  })
  return out
}

function pickBestStream(streams: StreamedStream[]): StreamedStream | null {
  if (!streams.length) return null
  const ranked = [...streams].sort((a, b) => {
    if (a.hd !== b.hd) return a.hd ? -1 : 1
    return (b.viewers || 0) - (a.viewers || 0) || a.streamNo - b.streamNo
  })
  return ranked[0] || null
}

/** Prefer sources that have higher learned reliability and usually return playable embeds. */
function rankStreamedSources(
  sources: Array<{ source: string; id: string }>,
): Array<{ source: string; id: string }> {
  return rankSourcesWithLearning(sources)
}

/** Resolve a catalog item / match sources to an embed.st (or other) player URL. */
export async function resolveStreamedPlay(
  item: Pick<StreamItem, 'streamedMatchId' | 'streamedSources' | 'title'>,
): Promise<StreamedPlayResult> {
  let sources = (item.streamedSources || []).filter((s) => s.source && s.id)

  // Always refresh from live API when possible — catalog rows go stale and
  // `echo` sources often return [] while admin/delta still work.
  if (item.streamedMatchId) {
    const live = await fetchStreamedLiveMatches(false)
    if (live.ok) {
      const match = live.matches.find((m) => m.id === item.streamedMatchId)
      if (match?.sources?.length) {
        sources = match.sources
          .map((s) => ({
            source: String(s.source || '').trim(),
            id: String(s.id || '').trim(),
          }))
          .filter((s) => s.source && s.id)
      }
    }
  }

  sources = rankStreamedSources(sources)

  if (sources.length === 0) {
    return { ok: false, error: 'No Streamed sources for this match' }
  }

  let lastError = 'No playable streams'
  for (const src of sources) {
    const started = Date.now()
    const result = await fetchJson<StreamedStream[]>(
      `/api/stream/${encodeURIComponent(src.source)}/${encodeURIComponent(src.id)}`,
    )
    const latencyMs = Date.now() - started
    if (!result.ok) {
      recordStreamProbeResult(src.source, false, latencyMs)
      lastError = result.error
      continue
    }
    if (!Array.isArray(result.data) || result.data.length === 0) {
      recordStreamProbeResult(src.source, false, latencyMs)
      lastError = `No streams from ${src.source}`
      continue
    }
    const best = pickBestStream(result.data)
    if (!best?.embedUrl) {
      recordStreamProbeResult(src.source, false, latencyMs)
      lastError = 'No embed URL'
      continue
    }
    recordStreamProbeResult(src.source, true, latencyMs)
    if (best.embedUrl) recordStreamProbeResult(best.embedUrl, true, latencyMs)
    return {
      ok: true,
      url: best.embedUrl,
      language: best.language,
      hd: best.hd,
      streamNo: best.streamNo,
    }
  }

  return { ok: false, error: lastError }
}
