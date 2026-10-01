/**
 * PPV.st (api.ppv.st) — live / upcoming sports & PPV schedule.
 * Catalog: /api/streams → Sports → Live. Play: site iframe in Web Browser.
 */

import type { StreamItem } from '../types'

export const PPV_ST_ORIGIN = 'https://ppv.st'
export const PPV_ST_API_ORIGIN = 'https://api.ppv.st'
export const PPV_ST_ID_PREFIX = 'ppvst-'

export interface PpvStStream {
  id: number
  name: string
  tag?: string
  source_tag?: string
  poster?: string
  uri_name?: string
  starts_at?: number
  ends_at?: number
  always_live?: number | boolean
  category_name?: string
  iframe?: string
  /** Live viewer count from api.ppv.st (string in API responses). */
  viewers?: string | number
}

export interface PpvStCategory {
  category: string
  id?: number
  always_live?: boolean
  streams?: PpvStStream[]
}

function unixSecondsNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function ppvStItemId(streamId: string | number): string {
  return `${PPV_ST_ID_PREFIX}${streamId}`
}

export function isPpvStCatalogItem(item: {
  id?: string
  url?: string
  detailUrl?: string
  tags?: string[]
  source?: string
}): boolean {
  if (item.id?.startsWith(PPV_ST_ID_PREFIX)) return true
  if (item.tags?.some((t) => /^ppv\.?st$/i.test(t))) return true
  if (/^ppv\.st$/i.test(String(item.source || ''))) return true
  try {
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'ppv.st' || host.endsWith('.ppv.st')) return true
      if (host === 'embedindia.st' || host.endsWith('.embedindia.st')) return true
      if (host === 'embed.ppv.st' || host.endsWith('.ppvservices.st')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export function isPpvStLiveNow(item: StreamItem, nowSec = unixSecondsNow()): boolean {
  if (!isPpvStCatalogItem(item)) return false
  if (item.tags?.includes('always-live')) return true
  if (item.tags?.includes('live-now')) return true
  const start = item.releasedAt ? Math.floor(item.releasedAt / 1000) : 0
  // endsAt encoded in description is fragile — prefer tag from mapper.
  if (item.tags?.includes('upcoming')) return false
  if (start > 0 && start <= nowSec) return true
  return false
}

async function fetchJson<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${PPV_ST_API_ORIGIN}${path}`
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, `${PPV_ST_ORIGIN}/`)
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
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJson } = await import('./nativeHttp')
      const result = await nativeFetchJson<T>(url, {
        referer: `${PPV_ST_ORIGIN}/`,
        headers: {
          Accept: 'application/json',
          Origin: PPV_ST_ORIGIN,
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
        Referer: `${PPV_ST_ORIGIN}/`,
        Origin: PPV_ST_ORIGIN,
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

function watchPageUrl(stream: PpvStStream): string {
  const uri = String(stream.uri_name || '').replace(/^\/+/, '')
  if (uri) return `${PPV_ST_ORIGIN}/live/${uri}`
  return PPV_ST_ORIGIN
}

function playUrl(stream: PpvStStream): string {
  const iframe = String(stream.iframe || '').trim()
  if (/^https?:\/\//i.test(iframe)) return iframe
  return watchPageUrl(stream)
}

function isActiveStream(stream: PpvStStream, nowSec: number): boolean {
  if (stream.always_live) return true
  const start = Number(stream.starts_at) || 0
  const end = Number(stream.ends_at) || 0
  if (start > 0 && start <= nowSec && (!end || end >= nowSec)) return true
  // Upcoming within ~3 days — keep schedule useful without dumping the whole archive.
  if (start > nowSec && start <= nowSec + 3 * 24 * 60 * 60) return true
  return false
}

function streamStatus(
  stream: PpvStStream,
  nowSec: number,
): 'live-now' | 'always-live' | 'upcoming' {
  if (stream.always_live) return 'always-live'
  const start = Number(stream.starts_at) || 0
  const end = Number(stream.ends_at) || 0
  if (start > 0 && start <= nowSec && (!end || end >= nowSec)) return 'live-now'
  return 'upcoming'
}

function sportLabelFromPpv(stream: PpvStStream): string {
  const tag = String(stream.tag || '').trim()
  const cat = String(stream.category_name || '').trim()
  // tag is the league chip on PPV cards (NFL, MLB, Liga MX); skip generic 24/7 tag.
  if (tag && !/^24\s*\/\s*7/i.test(tag)) return tag
  return cat || 'Sports'
}

/**
 * Route non-sports always-on channels out of Sports.
 * - Cows: drop
 * - South Park / Family Guy / Simpsons → TV Series · 24/7
 * - SpongeBob → Kids · Live
 */
function routeAlwaysOnEntertainment(title: string): 'exclude' | 'series' | 'kids' | null {
  const t = title.trim()
  if (/\bcows?\b/i.test(t)) return 'exclude'
  if (/south\s*park/i.test(t)) return 'series'
  if (/family\s*guy/i.test(t)) return 'series'
  if (/simpsons/i.test(t)) return 'series'
  if (/sponge\s*bob|spongebob/i.test(t)) return 'kids'
  return null
}

export function ppvStStreamToItem(stream: PpvStStream, nowSec = unixSecondsNow()): StreamItem | null {
  const id = stream?.id
  const title = String(stream?.name || '').trim()
  if (!id || !title) return null

  const route = routeAlwaysOnEntertainment(title)
  if (route === 'exclude') return null

  const status = streamStatus(stream, nowSec)
  const sport = sportLabelFromPpv(stream)
  const shelfSport = String(stream.category_name || stream.tag || 'Sports').trim()
  const startSec = Number(stream.starts_at) || 0
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
  const statusLabel =
    status === 'live-now' ? 'Live now' : status === 'always-live' ? '24/7' : 'Upcoming'
  const play = playUrl(stream)
  const page = watchPageUrl(stream)
  const viewersRaw = Number(stream.viewers)
  const eventViewers = Number.isFinite(viewersRaw) && viewersRaw >= 0 ? viewersRaw : undefined

  if (route === 'series') {
    return {
      id: ppvStItemId(id),
      title,
      description: ['24/7', statusLabel, stream.source_tag].filter(Boolean).join(' · '),
      category: 'series',
      url: play,
      detailUrl: page,
      poster: stream.poster || undefined,
      tags: ['live', 'ppv.st', 'always-live', '247-series', 'web-embed'].filter(Boolean),
      source: 'PPV.st',
      sourceKind: 'builtin',
      transport: 'direct',
      releasedAt: Date.now(),
      eventViewers,
      eventSport: '24/7',
    }
  }

  if (route === 'kids') {
    return {
      id: ppvStItemId(id),
      title,
      description: ['Kids', '24/7', statusLabel, stream.source_tag].filter(Boolean).join(' · '),
      category: 'kids',
      url: play,
      detailUrl: page,
      poster: stream.poster || undefined,
      tags: ['live', 'ppv.st', 'always-live', 'kids-live', 'web-embed'].filter(Boolean),
      source: 'PPV.st',
      sourceKind: 'builtin',
      transport: 'direct',
      releasedAt: Date.now(),
      eventViewers,
      eventSport: '24/7',
    }
  }

  return {
    id: ppvStItemId(id),
    title,
    description: [sport, statusLabel, stream.source_tag, when].filter(Boolean).join(' · '),
    category: 'sports',
    url: play,
    detailUrl: page,
    poster: stream.poster || undefined,
    tags: [
      'live',
      'ppv.st',
      shelfSport.toLowerCase().replace(/\s+/g, '-'),
      status,
    ].filter(Boolean),
    source: 'PPV.st',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: startSec > 0 ? startSec * 1000 : Date.now(),
    eventStartsAt: startSec > 0 ? startSec * 1000 : undefined,
    eventEndsAt: Number(stream.ends_at) > 0 ? Number(stream.ends_at) * 1000 : undefined,
    eventViewers,
    eventSport: sport,
  }
}

/** Sport filter chips from PPV.st rows currently on the Live shelf. */
export function ppvStSportChipsFromItems(
  items: StreamItem[],
): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>()
  const skip = new Set(['live', 'ppv.st', 'live-now', 'always-live', 'upcoming'])
  for (const item of items) {
    if (!isPpvStCatalogItem(item)) continue
    for (const raw of item.tags || []) {
      const tag = String(raw || '').trim().toLowerCase()
      if (!tag || skip.has(tag) || tag.includes('.')) continue
      if (byId.has(tag)) continue
      const name = tag
        .split('-')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
      byId.set(tag, name || tag)
    }
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Fetch live + near-term upcoming PPV.st events for Sports → Live. */
export async function fetchPpvStLiveCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchJson<{
    success?: boolean
    streams?: PpvStCategory[]
    error?: string
  }>('/api/streams')
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  if (!result.data?.success || !Array.isArray(result.data.streams)) {
    return {
      ok: false,
      error: result.data?.error || 'PPV.st returned no streams',
      items: [],
    }
  }

  const nowSec = unixSecondsNow()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const cat of result.data.streams) {
    for (const stream of cat.streams || []) {
      if (!isActiveStream(stream, nowSec)) continue
      // Prefer category name from the bucket when the row omits it.
      if (!stream.category_name && cat.category) {
        stream.category_name = cat.category
      }
      const item = ppvStStreamToItem(stream, nowSec)
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }

  items.sort((a, b) => {
    const rank = (item: StreamItem) => {
      if (item.tags?.includes('live-now')) return 0
      if (item.tags?.includes('always-live')) return 1
      return 2
    }
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return (a.releasedAt || 0) - (b.releasedAt || 0)
  })

  return { ok: true, items }
}
