/**
 * Streamo (streamo.pro) — TMDB → ShowBox/FebBox HLS on hls.shegu.net.
 * guest-token → premium-providers (fast:false) → resolve?ref=&stoken=.
 * Signed URLs expire in hours, so resolve at play time only.
 */

import { nativeFetchJson, nativeFetchJsonPost } from './nativeHttp'

export const STREAMO_ORIGIN = 'https://streamo.pro'
export const STREAMO_PLAY_REFERER = 'https://streamo.pro/'

const HEADERS = { Origin: STREAMO_ORIGIN }

export interface StreamoResolveOptions {
  tmdbId: string | number
  mediaType: 'movie' | 'tv'
  season?: number
  episode?: number
}

export type StreamoPlayResult =
  | { ok: true; url: string; referer: string; provider: string }
  | { ok: false; error: string }

interface StreamoProvider {
  name?: string
  kind?: string
  url?: string
}

export async function resolveStreamoPlay(opts: StreamoResolveOptions): Promise<StreamoPlayResult> {
  const tmdbId = Number(opts.tmdbId)
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return { ok: false, error: 'No TMDB id' }
  const body: Record<string, unknown> = { tmdbId, type: opts.mediaType }
  if (opts.mediaType === 'tv') {
    body.season = Math.max(1, opts.season || 1)
    body.episode = Math.max(1, opts.episode || 1)
  }
  const post = <T>(path: string, data: Record<string, unknown>) =>
    nativeFetchJsonPost<T>(`${STREAMO_ORIGIN}${path}`, data, {
      referer: STREAMO_PLAY_REFERER,
      headers: HEADERS,
    })

  const [token, list] = await Promise.all([
    post<{ data?: { token?: string } }>('/api/streaming/guest-token', body),
    // fast:true skips the ShowBox lookup and usually comes back empty.
    post<{ data?: { providers?: StreamoProvider[] } }>('/api/streaming/premium-providers', {
      ...body,
      fast: false,
    }),
  ])
  const stoken = token.data?.data?.token
  if (!stoken) return { ok: false, error: 'Streamo token failed' }
  // Torbox/mp4 refs are MKV or slow direct files — only ShowBox HLS plays in hls.js.
  const refs = (list.data?.data?.providers || []).filter(
    (p) => p.kind === 'showbox' && typeof p.url === 'string' && p.url,
  )
  for (const p of refs) {
    const qs = new URLSearchParams({ ref: p.url!, stoken })
    const r = await nativeFetchJson<{ url?: string }>(
      `${STREAMO_ORIGIN}/api/streaming/resolve?${qs.toString()}`,
      { referer: STREAMO_PLAY_REFERER, headers: HEADERS },
    )
    const url = String(r.data?.url || '').trim()
    if (/^https?:\/\/[^?]+\.m3u8(\?|$)/i.test(url)) {
      return { ok: true, url, referer: STREAMO_PLAY_REFERER, provider: `streamo:${p.name || 'showbox'}` }
    }
  }
  return { ok: false, error: 'No Streamo stream for this title' }
}
