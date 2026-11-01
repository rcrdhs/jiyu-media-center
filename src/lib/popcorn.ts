/**
 * PopcornMovies (popcornmovies.ac) — TMDB → /api/sources → dlproxy HLS.
 * Standby behind Movy when Direct is missing or fails.
 *
 * Needs a page-issued `playToken` (from the watch HTML). Cloudflare may block
 * bare fetches; desktop Electron / a cleared CF session works best. Tizen uses
 * the same fetch path (relay allowlists the hosts).
 */
import { isTizenTv } from './tvMode'
import { tizenRelayUrl, shouldRelayFetch } from './tizenRelay'

export const POPCORN_ORIGIN = 'https://popcornmovies.ac'
export const POPCORN_PLAY_REFERER = `${POPCORN_ORIGIN}/`

export type PopcornMediaType = 'movie' | 'tv'

export interface PopcornResolveOptions {
  tmdbId: string | number
  title: string
  mediaType: PopcornMediaType
  year?: number | string
  season?: number
  episode?: number
}

export type PopcornPlayResult =
  | {
      ok: true
      mode: 'hls'
      url: string
      referer: string
      provider: string
      tmdbId: string
      quality?: string
      backend: 'popcorn'
    }
  | { ok: false; error: string }

function watchPath(opts: PopcornResolveOptions): string {
  const id = encodeURIComponent(String(opts.tmdbId))
  if (opts.mediaType === 'tv') {
    const qs = new URLSearchParams()
    if (opts.season != null) qs.set('season', String(opts.season))
    if (opts.episode != null) qs.set('episode', String(opts.episode))
    const q = qs.toString()
    return `/watch/tv/${id}${q ? `?${q}` : ''}`
  }
  return `/watch/movie/${id}`
}

function extractPlayToken(html: string): string | null {
  const m =
    html.match(/\\"playToken\\":\\"([^\\"\\]+)\\"/) ||
    html.match(/"playToken"\s*:\s*"([^"]+)"/) ||
    html.match(/playToken\\?":\\?"([0-9]+\.[a-f0-9]+)/i)
  return m?.[1] || null
}

async function fetchText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchHtml) {
    const r = await window.signalDesktop.fetchHtml(url, { referer: POPCORN_PLAY_REFERER })
    const body = String(r?.content || r?.error || '')
    if (r?.ok && body) return { status: 200, text: body }
    if (r && typeof r.status === 'number') return { status: r.status, text: body }
  }
  const target =
    isTizenTv() && shouldRelayFetch(url, 'GET') ? tizenRelayUrl(url) : url
  const res = await fetch(target, {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
    headers: { Accept: 'text/html,application/json', ...headers },
  })
  return { status: res.status, text: await res.text() }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown; text: string }> {
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    // Desktop helper has no custom headers — fall through for x-play-token.
  }
  const target =
    isTizenTv() && shouldRelayFetch(url, 'GET') ? tizenRelayUrl(url) : url
  const res = await fetch(target, {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
    headers: { Accept: 'application/json', ...headers },
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* */
  }
  return { status: res.status, json, text }
}

type PopcornSource = {
  provider?: string
  label?: string
  url?: string
  kind?: string
  quality?: string
  language?: string | null
}

function pickHls(sources: PopcornSource[]): PopcornSource | null {
  const list = sources.filter((s) => /^https:\/\//i.test(String(s.url || '')))
  if (!list.length) return null
  const vs = list.find((s) => /\/v1\/vs\/.+\.m3u8/i.test(String(s.url)) || /\.m3u8(\?|$)/i.test(String(s.url)))
  if (vs) return vs
  const hls = list.find((s) => String(s.kind || '').toLowerCase() === 'hls')
  return hls || list[0] || null
}

export function isPopcornStreamUrl(url: string): boolean {
  return /(?:^https:\/\/)?(?:api|cdn)\.dlproxy\.com\//i.test(url) || /popcornmovies\.ac/i.test(url)
}

/** Resolve a playable Popcorn/dlproxy HLS URL for a TMDB title. */
export async function resolvePopcornPlay(options: PopcornResolveOptions): Promise<PopcornPlayResult> {
  const tmdbId = String(options.tmdbId || '').trim()
  const title = String(options.title || '').trim() || 'Title'
  if (!tmdbId) return { ok: false, error: 'Missing TMDB id for Popcorn' }

  const watchUrl = `${POPCORN_ORIGIN}${watchPath(options)}`
  let page: { status: number; text: string }
  try {
    page = await fetchText(watchUrl, { Referer: POPCORN_PLAY_REFERER, Origin: POPCORN_ORIGIN })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Popcorn page failed' }
  }
  if (/Just a moment|cf-mitigated|challenge-platform/i.test(page.text)) {
    return { ok: false, error: 'Popcorn is behind Cloudflare right now' }
  }
  const playToken = extractPlayToken(page.text)
  if (!playToken) {
    return {
      ok: false,
      error: page.status === 403 || page.status === 429 ? 'Popcorn blocked this request' : 'Popcorn play token missing',
    }
  }

  const qs = new URLSearchParams({
    type: options.mediaType === 'tv' ? 'tv' : 'movie',
    tmdbId,
    title,
  })
  const year = options.year != null && String(options.year).trim() ? String(options.year).trim() : ''
  if (year) qs.set('year', year.slice(0, 4))
  if (options.mediaType === 'tv') {
    if (options.season != null) qs.set('season', String(options.season))
    if (options.episode != null) qs.set('episode', String(options.episode))
  }
  const sourcesUrl = `${POPCORN_ORIGIN}/api/sources?${qs}`
  let srcRes: { status: number; json: unknown; text: string }
  try {
    srcRes = await fetchJson(sourcesUrl, {
      Referer: watchUrl,
      Origin: POPCORN_ORIGIN,
      'x-play-token': playToken,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Popcorn sources failed' }
  }
  if (srcRes.status === 401 || /unauthorized/i.test(srcRes.text)) {
    return { ok: false, error: 'Popcorn unauthorized (play token rejected)' }
  }
  const sources = (srcRes.json as { sources?: PopcornSource[] } | null)?.sources
  if (!Array.isArray(sources) || sources.length === 0) {
    return { ok: false, error: 'Popcorn has no stream for this title' }
  }
  const pick = pickHls(sources)
  if (!pick?.url) return { ok: false, error: 'Popcorn returned no HLS URL' }

  return {
    ok: true,
    mode: 'hls',
    url: pick.url,
    referer: POPCORN_PLAY_REFERER,
    provider: String(pick.label || pick.provider || 'popcorn'),
    tmdbId,
    quality: pick.quality ? String(pick.quality) : undefined,
    backend: 'popcorn',
  }
}
