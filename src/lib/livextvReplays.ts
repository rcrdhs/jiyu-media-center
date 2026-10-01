/**
 * LiveXTV sports replays (full match VODs).
 * Catalog: livextv-backend.onrender.com/api/replays
 * Play: unwrap soccerfull → prefer native HLS when present, else Web Browser
 * embed (DoodStream-style), same sports path as Streamed / PPV.st.
 */

import type { StreamItem, StreamPlaylistItem } from '../types'

export const LIVEXTV_ORIGIN = 'https://livextv.hybrows.workers.dev'
export const LIVEXTV_API_ORIGIN = 'https://livextv-backend.onrender.com/api'
export const LIVEXTV_REPLAY_ID_PREFIX = 'livextv-replay-'

/** Keep the Replay shelf recent — ~3 days of completed matches. */
export const LIVEXTV_REPLAY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

export interface LivextvReplayServer {
  name?: string
  type?: string
  url?: string
}

export interface LivextvReplay {
  id: string
  title: string
  category?: string
  subcategory?: string
  poster?: string
  date?: number
  dateString?: string
  servers?: LivextvReplayServer[]
}

type SportBucket = 'football' | 'boxing' | 'cricket' | 'motorsport'

const SPORT_CHIP_NAMES: Record<SportBucket, string> = {
  football: 'Football',
  boxing: 'Boxing',
  cricket: 'Cricket',
  motorsport: 'Motorsport',
}

export function livextvReplayItemId(replayId: string): string {
  return `${LIVEXTV_REPLAY_ID_PREFIX}${replayId}`
}

export function isLivextvReplayCatalogItem(item: {
  id?: string
  tags?: string[]
  source?: string
  url?: string
  detailUrl?: string
}): boolean {
  if (item.id?.startsWith(LIVEXTV_REPLAY_ID_PREFIX)) return true
  if (item.tags?.includes('replay') && item.tags?.includes('livextv')) return true
  if (/^livextv$/i.test(String(item.source || ''))) return true
  try {
    for (const raw of [item.url, item.detailUrl]) {
      if (!raw) continue
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'livextv.hybrows.workers.dev') return true
      if (host === 'livextv.com' || host.endsWith('.livextv.com')) return true
      if (host === 'livextv.pro' || host.endsWith('.livextv.pro')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** Map LiveXTV category → our allowlist; null = skip (baseball, rugby, …). */
export function livextvReplaySportBucket(
  category?: string,
  subcategory?: string,
): SportBucket | null {
  const blob = `${category || ''} ${subcategory || ''}`.toLowerCase()
  if (/baseball|\bmlb\b/.test(blob)) return null
  if (/\brugby\b|\bnrl\b/.test(blob)) return null
  if (/cricket/.test(blob)) return 'cricket'
  if (/boxing|fight|ufc|\bmma\b/.test(blob)) return 'boxing'
  if (/motor|formula|nascar|indycar|wrc|wsbk|\bf1\b/.test(blob)) return 'motorsport'
  if (
    /football|soccer|premier league|la liga|serie a|ligue 1|bundesliga|champions league|europa|world cup/.test(
      blob,
    )
  ) {
    return 'football'
  }
  return null
}

export function livextvReplaySportId(item: StreamItem): string | null {
  if (!isLivextvReplayCatalogItem(item)) return null
  const tag = item.tags?.find((t) =>
    /^(football|boxing|cricket|motorsport)$/i.test(String(t || '')),
  )
  return tag ? String(tag).toLowerCase() : null
}

export function livextvReplaySportChipsFromItems(
  items: StreamItem[],
): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string }> = []
  for (const item of items) {
    const id = livextvReplaySportId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: SPORT_CHIP_NAMES[id as SportBucket] || id })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function iframeServers(replay: LivextvReplay): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = []
  const seen = new Set<string>()
  for (const row of replay.servers || []) {
    const url = String(row?.url || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const name = String(row?.name || '').trim() || `Part ${out.length + 1}`
    out.push({ name, url })
  }
  return out
}

function withinReplayWindow(dateMs: number, nowMs: number): boolean {
  if (!Number.isFinite(dateMs) || dateMs <= 0) return false
  // Kickoff in the last 3 days (allow a few hours of clock skew / TZ).
  const age = nowMs - dateMs
  return age >= -6 * 60 * 60 * 1000 && age <= LIVEXTV_REPLAY_MAX_AGE_MS
}

/** LiveXTV often puts an ISO datetime in `poster` instead of an image URL. */
function isHttpImageUrl(raw?: string): boolean {
  const url = String(raw || '').trim()
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const u = new URL(url)
    return Boolean(u.hostname) && !/\s/.test(url)
  } catch {
    return false
  }
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Split-crest-style placeholder when LiveXTV has no real thumbnail. */
function replayPosterFallback(title: string, league: string): string {
  const parts = title.split(/\s+vs\.?\s+/i).map((p) => p.trim()).filter(Boolean)
  const home = escapeSvgText((parts[0] || title).slice(0, 28))
  const away = escapeSvgText((parts[1] || 'Replay').slice(0, 28))
  const sub = escapeSvgText((league || 'Replay').slice(0, 24))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2332"/>
      <stop offset="50%" stop-color="#121820"/>
      <stop offset="100%" stop-color="#0d3b2e"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <rect x="0" y="0" width="320" height="360" fill="#1e3a5f" opacity="0.55"/>
  <rect x="320" y="0" width="320" height="360" fill="#1a4d3a" opacity="0.55"/>
  <text x="160" y="175" text-anchor="middle" fill="#f3f6fb" font-family="Segoe UI,Arial,sans-serif" font-size="28" font-weight="700">${home}</text>
  <text x="480" y="175" text-anchor="middle" fill="#f3f6fb" font-family="Segoe UI,Arial,sans-serif" font-size="28" font-weight="700">${away}</text>
  <circle cx="320" cy="180" r="28" fill="#0b1220" stroke="#e8eef8" stroke-width="2"/>
  <text x="320" y="186" text-anchor="middle" fill="#e8eef8" font-family="Segoe UI,Arial,sans-serif" font-size="14" font-weight="700">VS</text>
  <text x="320" y="330" text-anchor="middle" fill="#9aa8bc" font-family="Segoe UI,Arial,sans-serif" font-size="16">${sub}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function livextvPoster(raw: string | undefined, title: string, league: string): string {
  if (isHttpImageUrl(raw)) return String(raw).trim()
  return replayPosterFallback(title, league)
}

export function livextvReplayToItem(
  replay: LivextvReplay,
  nowMs = Date.now(),
): StreamItem | null {
  const id = String(replay?.id || '').trim()
  const title = String(replay?.title || '').trim()
  if (!id || !title) return null

  const bucket = livextvReplaySportBucket(replay.category, replay.subcategory)
  if (!bucket) return null

  const dateMs = Number(replay.date) || 0
  if (!withinReplayWindow(dateMs, nowMs)) return null

  const servers = iframeServers(replay)
  if (servers.length === 0) return null

  const league = String(replay.subcategory || replay.category || SPORT_CHIP_NAMES[bucket]).trim()
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

  const watchPage = `${LIVEXTV_ORIGIN}/replays/watch/${encodeURIComponent(id)}`
  const play = servers[0]!.url

  return {
    id: livextvReplayItemId(id),
    title,
    description: [league, 'Replay', partsLabel, when].filter(Boolean).join(' · '),
    category: 'sports',
    url: play,
    detailUrl: watchPage,
    poster: livextvPoster(replay.poster, title, league),
    tags: ['replay', 'livextv', 'web-embed', bucket, league.toLowerCase().replace(/\s+/g, '-')],
    source: 'LiveXTV',
    sourceKind: 'builtin',
    transport: 'direct',
    releasedAt: dateMs > 0 ? dateMs : nowMs,
    eventStartsAt: dateMs > 0 ? dateMs : undefined,
    eventEndsAt: dateMs > 0 ? dateMs : undefined,
    eventSport: league || SPORT_CHIP_NAMES[bucket],
    playlist,
  }
}

async function fetchJson<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = path.startsWith('http') ? path : `${LIVEXTV_API_ORIGIN}${path}`
  const { nativeFetchJson, isNativeHttpPlatform } = await import('./nativeHttp')

  // Desktop Electron + Android CapacitorHttp (3MB+ JSON fails CORS/plain fetch on Android).
  if (window.signalDesktop?.fetchJsonGet || isNativeHttpPlatform()) {
    const result = await nativeFetchJson<T>(url, {
      referer: `${LIVEXTV_ORIGIN}/replays`,
      headers: {
        Accept: 'application/json',
        Origin: LIVEXTV_ORIGIN,
      },
    })
    if (!result.ok || result.data == null) {
      return { ok: false, error: result.error || 'LiveXTV replays unavailable' }
    }
    return { ok: true, data: result.data }
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: `${LIVEXTV_ORIGIN}/replays`,
        Origin: LIVEXTV_ORIGIN,
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

/** Fetch + filter Replay shelf (football / boxing / cricket / motorsport, ~3 days). */
export async function fetchLivextvReplayCatalog(): Promise<
  { ok: true; items: StreamItem[] } | { ok: false; error: string; items: StreamItem[] }
> {
  const result = await fetchJson<{ success?: boolean; data?: LivextvReplay[] }>('/replays')
  if (!result.ok) return { ok: false, error: result.error, items: [] }
  const rows = Array.isArray(result.data?.data) ? result.data.data : []
  const nowMs = Date.now()
  const items: StreamItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const item = livextvReplayToItem(row, nowMs)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  items.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
  return { ok: true, items }
}

export type LivextvReplayPlayResult =
  | { ok: true; mode: 'hls'; url: string; referer: string }
  | { ok: true; mode: 'embed'; url: string }
  | { ok: false; error: string }

async function fetchReplayHtml(
  url: string,
): Promise<{ ok: boolean; content: string; status?: number }> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url, {
      quiet: true,
      referer: `${LIVEXTV_ORIGIN}/replays`,
    })
    return {
      ok: Boolean(result.ok && result.content),
      content: result.content || '',
      status: result.status,
    }
  }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchText } = await import('./nativeHttp')
      const result = await nativeFetchText(url, {
        quiet: true,
        headers: {
          Accept: 'text/html',
          Referer: `${LIVEXTV_ORIGIN}/replays`,
        },
      })
      return {
        ok: Boolean(result.ok && result.content),
        content: result.content || '',
        status: result.status,
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html',
        Referer: `${LIVEXTV_ORIGIN}/replays`,
      },
    })
    const content = await res.text()
    return { ok: res.ok, content, status: res.status }
  } catch {
    return { ok: false, content: '' }
  }
}

function looksLikeNginx404(html: string, status?: number): boolean {
  if (status === 404) return true
  return /404\s*Not\s*Found/i.test(html) && /nginx/i.test(html)
}

function extractSoccerfullTargets(html: string): { hls: string[]; embeds: string[] } {
  const hls: string[] = []
  const embeds: string[] = []
  const seen = new Set<string>()
  const push = (list: string[], raw: string) => {
    const url = raw.replace(/&amp;/g, '&').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    list.push(url)
  }
  for (const m of html.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)) {
    const url = m[0] || ''
    if (/\.m3u8(\?|$)/i.test(url)) push(hls, url)
  }
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    const url = (m[1] || '').replace(/&amp;/g, '&').trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (/jquery|jsdelivr|hls\.js|artplayer|cloudflareinsights/i.test(url)) continue
    push(embeds, url)
  }
  return { hls, embeds }
}

async function embedLooksPlayable(url: string): Promise<boolean> {
  // Dead Videas embeds return HTML 404; skip them and try the next part.
  if (/videas\.fr\/embed/i.test(url)) {
    const page = await fetchReplayHtml(url)
    if (!page.ok || /page not found|404/i.test(page.content.slice(0, 400))) return false
    return true
  }
  return true
}

/**
 * Unwrap a catalog replay into a playable HLS or embed URL.
 * Tries each part until one resolves (soccerfull pages often wrap DoodStream / Videas).
 */
export async function resolveLivextvReplayPlay(
  item: Pick<StreamItem, 'url' | 'detailUrl' | 'playlist' | 'id'>,
  preferredIndex = 0,
): Promise<LivextvReplayPlayResult> {
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

  const tried = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue
    tried.add(candidate)

    // Already a direct HLS link.
    if (/\.m3u8(\?|$)/i.test(candidate)) {
      return { ok: true, mode: 'hls', url: candidate, referer: 'https://soccerfull.net/' }
    }

    // Direct DoodStream-style player.
    try {
      const path = new URL(candidate).pathname
      if (/^\/[de]\/[a-z0-9]{6,}/i.test(path)) {
        if (await embedLooksPlayable(candidate)) {
          return { ok: true, mode: 'embed', url: candidate }
        }
        continue
      }
    } catch {
      /* ignore */
    }

    // Soccerfull wrapper — unwrap nested player / HLS.
    if (/soccerfull\.net\/play\//i.test(candidate)) {
      const page = await fetchReplayHtml(candidate)
      if (looksLikeNginx404(page.content, page.status) || !page.ok) {
        continue
      }
      const { hls, embeds } = extractSoccerfullTargets(page.content)
      if (hls[0]) {
        return { ok: true, mode: 'hls', url: hls[0], referer: candidate }
      }
      for (const embed of embeds) {
        if (!(await embedLooksPlayable(embed))) continue
        return { ok: true, mode: 'embed', url: embed }
      }
    } else if (/^https?:\/\//i.test(candidate)) {
      if (await embedLooksPlayable(candidate)) {
        return { ok: true, mode: 'embed', url: candidate }
      }
    }
  }

  // Last resort: LiveXTV watch page (has their own multi-part UI).
  if (item.detailUrl && /livextv/i.test(item.detailUrl)) {
    return { ok: true, mode: 'embed', url: item.detailUrl }
  }

  return { ok: false, error: 'No working replay source for this match' }
}

