/**
 * Futbol-x (futbol-x.xyz) — sports catalog with Flussonic HLS.
 * Catalog: /api/stream + /api/{category}.json
 * Play: unsigned .m3u8 → /api/token.js → signed HLS (≈15 min). Native player, no embed.
 */

import type { StreamItem } from '../types'

export const FUTBOLX_ORIGIN = 'https://www.futbol-x.xyz'
export const FUTBOLX_ID_PREFIX = 'futbolx-'

export interface FutbolXFeed {
  title?: string
  url: string
}

export interface FutbolXMatch {
  name: string
  uri_name: string
  poster?: string
  tag?: string
  starts_at?: string
  ends_at?: string
  always_live?: number | boolean
  streams?: FutbolXFeed[]
}

type CategoryPayload = {
  success?: boolean
  streams?: Array<{
    category?: string
    streams?: FutbolXMatch[]
  }>
}

async function fetchJson<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${FUTBOLX_ORIGIN}${path}`
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, `${FUTBOLX_ORIGIN}/`)
    if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null') as T }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' }
    }
  }
  try {
    if (typeof window !== 'undefined') {
      const { Capacitor } = await import('@capacitor/core')
      if (Capacitor.isNativePlatform()) {
        const { nativeFetchJson } = await import('./nativeHttp')
        const result = await nativeFetchJson<T>(url, {
          referer: `${FUTBOLX_ORIGIN}/`,
          headers: { Accept: 'application/json' },
        })
        if (!result.ok || result.data == null) {
          return { ok: false, error: result.error || 'Futbol-x request failed' }
        }
        return { ok: true, data: result.data }
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Referer: `${FUTBOLX_ORIGIN}/` },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

export function futbolXItemId(uriName: string): string {
  return `${FUTBOLX_ID_PREFIX}${encodeURIComponent(uriName)}`
}

export function isFutbolXCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
}): boolean {
  if (item.id?.startsWith(FUTBOLX_ID_PREFIX)) return true
  if (item.tags?.some((t) => /^futbolx$/i.test(t))) return true
  if (/^futbol-?x$/i.test(String(item.source || ''))) return true
  try {
    if (item.url) {
      const host = new URL(item.url).hostname.replace(/^www\./, '').toLowerCase()
      if (host.endsWith('futbol-x.xyz') || host.endsWith('futx.nx.kg')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** Site stores wall times without Z; their frontend assumes +03:00. */
export function parseFutbolXTimeMs(raw?: string): number {
  const s = String(raw || '').trim()
  if (!s) return 0
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : 0
  }
  const t = Date.parse(`${s}+03:00`)
  return Number.isFinite(t) ? t : 0
}

export function pickFutbolXFeed(feeds: FutbolXFeed[] | undefined): FutbolXFeed | null {
  const list = (feeds || []).filter((f) => /^https?:\/\//i.test(String(f?.url || '')))
  if (!list.length) return null
  const main = list.find((f) => /main/i.test(String(f.title || '')))
  return main || list[0]
}

export function isFutbolXLiveNow(match: FutbolXMatch, nowMs = Date.now()): boolean {
  if (match.always_live === 1 || match.always_live === true) return true
  const start = parseFutbolXTimeMs(match.starts_at)
  const end = parseFutbolXTimeMs(match.ends_at) || (start ? start + 3 * 60 * 60 * 1000 : 0)
  if (!start) return false
  return start <= nowMs && nowMs <= end
}

export function futbolXMatchToItem(match: FutbolXMatch, nowMs = Date.now()): StreamItem | null {
  const name = String(match.name || '').trim()
  const uri = String(match.uri_name || '').trim()
  const feed = pickFutbolXFeed(match.streams)
  if (!name || !uri || !feed) return null

  const live = isFutbolXLiveNow(match, nowMs)
  const startMs = parseFutbolXTimeMs(match.starts_at)
  const endMs = parseFutbolXTimeMs(match.ends_at) || undefined
  const tag = String(match.tag || 'Football').trim()
  const alts = (match.streams || [])
    .filter((f) => f.url && f.url !== feed.url)
    .map((f) => ({ label: String(f.title || 'Feed').trim() || 'Feed', url: f.url }))

  return {
    id: futbolXItemId(uri),
    title: name,
    description: [tag, 'Futbol-x', live ? 'Live' : 'Upcoming'].filter(Boolean).join(' · '),
    category: 'sports',
    url: feed.url,
    detailUrl: `${FUTBOLX_ORIGIN}/live/${encodeURIComponent(uri)}`,
    poster: match.poster && /^https?:\/\//i.test(match.poster) ? match.poster : undefined,
    tags: [
      'live',
      'futbolx',
      'hls',
      'football',
      live ? 'live-now' : 'upcoming',
    ],
    source: 'Futbol-x',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: startMs || Date.now(),
    eventStartsAt: startMs || undefined,
    eventEndsAt: endMs,
    eventSport: tag,
    sportsAltSources: alts.length ? alts : undefined,
    httpReferrer: `${FUTBOLX_ORIGIN}/`,
  }
}

function flattenCategory(data: CategoryPayload | null | undefined): FutbolXMatch[] {
  const out: FutbolXMatch[] = []
  for (const block of data?.streams || []) {
    if (Array.isArray(block?.streams)) {
      for (const m of block.streams) out.push(m)
    }
  }
  return out
}

export async function fetchFutbolXFootballCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchJson<CategoryPayload>('/api/football.json')
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  if (!result.data?.success) {
    return { ok: false, error: 'Futbol-x football payload failed', items: [] }
  }
  const nowMs = Date.now()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const match of flattenCategory(result.data)) {
    const item = futbolXMatchToItem(match, nowMs)
    if (!item || seen.has(item.id)) continue
    // Shelf: live now + next 6h (so evening cards show up for testing).
    const start = item.eventStartsAt || 0
    const live = item.tags?.includes('live-now')
    if (!live && (start < nowMs - 30 * 60_000 || start > nowMs + 6 * 60 * 60_000)) continue
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

export type FutbolXPlayResult =
  | { ok: true; url: string; expiresInSec: number; rawUrl: string }
  | { ok: false; error: string }

/** Pick Futbol-x HLS alts off a sports card after PPV / StreamFree / StreamCorner fail. */
export function futbolXAltUrlsFromItem(item: {
  url?: string
  sportsAltSources?: Array<{ label?: string; url?: string }>
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const alt of item.sportsAltSources || []) {
    const url = String(alt?.url || '').trim()
    if (!url || seen.has(url)) continue
    if (!/\.m3u8(?:$|[?#])/i.test(url)) continue
    const labeled = /futbol/i.test(String(alt?.label || ''))
    const hostFx = /futbol-x\.xyz|futx\.nx\.kg/i.test(url)
    if (!labeled && !hostFx) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export async function resolveFutbolXBackupPlay(item: {
  url?: string
  sportsAltSources?: Array<{ label?: string; url?: string }>
}): Promise<FutbolXPlayResult> {
  const urls = futbolXAltUrlsFromItem(item)
  let lastError = 'No Futbol-x backup on this match'
  for (const url of urls) {
    const signed = await resolveFutbolXPlay(url)
    if (signed.ok) return signed
    lastError = signed.error
  }
  return { ok: false, error: lastError }
}

/** Sign a Flussonic m3u8 for playback (~15 min). */
export async function resolveFutbolXPlay(rawUrl: string): Promise<FutbolXPlayResult> {
  const raw = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: 'No Futbol-x stream URL' }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: 'Bad Futbol-x stream URL' }
  }
  if (!/\.m3u8(?:$|[?#])/i.test(parsed.pathname + parsed.search)) {
    return { ok: false, error: 'Futbol-x feed is not HLS' }
  }

  const qs = new URLSearchParams({
    path: parsed.pathname,
    sourceHost: parsed.hostname,
    expires: '900',
  })
  const tokenUrl = `${FUTBOLX_ORIGIN}/api/token.js?${qs.toString()}`
  const result = await fetchJson<{
    success?: boolean
    tokenRequired?: boolean
    provider?: string
    url?: string
    expiresIn?: number
    error?: string
  }>(tokenUrl)

  if (!result.ok) return { ok: false, error: result.error }
  const data = result.data
  if (!data?.success) {
    return { ok: false, error: data?.error || 'Token generation failed' }
  }
  if (data.tokenRequired === false) {
    return { ok: true, url: raw, expiresInSec: 900, rawUrl: raw }
  }
  if (data.tokenRequired && data.url) {
    return {
      ok: true,
      url: data.url,
      expiresInSec: Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 900,
      rawUrl: raw,
    }
  }
  return { ok: false, error: 'No signed HLS URL from Futbol-x' }
}
