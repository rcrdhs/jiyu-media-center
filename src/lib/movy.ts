/**
 * Movy (movy.sx) — TMDB-backed Direct streams via api.wecollege.net.
 * Seed + STREAMCRYPTO (enc=2) → JSON { sources, subtitles }.
 * Desktop/native Player path only — not an embed shell.
 */

import { resolveAtlanticPlay } from './atlanticHls'

export const MOVY_STREAM_ORIGIN = 'https://api.wecollege.net'
export const MOVY_PLAY_REFERER = 'https://www.movy.sx/'

/**
 * Prefer providers that answered for TV. Keep the list short — CDN links need
 * Referer: movy.sx, so bare health probes 403 and must not gate resolution.
 */
const MOVY_TV_PROVIDERS = [
  'miami',
  'seattle',
  'boise',
  'atlanta',
  'phoenix',
  'portland',
  'austin',
  'dallas',
] as const

const MOVY_MOVIE_PROVIDERS = MOVY_TV_PROVIDERS

const KDF_TABLE = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174,
] as const

const MAGIC = new Uint8Array([109, 118, 109, 49]) // mvm1

type SeedCacheEntry = { seed: string; expiresAt: number }
const seedCache = new Map<string, SeedCacheEntry>()

function rotl(v: number, n: number): number {
  v >>>= 0
  n &= 31
  if (n === 0) return v >>> 0
  return ((v << n) | (v >>> (32 - n))) >>> 0
}

function mix(v: number): number {
  v >>>= 0
  v ^= v >>> 16
  v = Math.imul(v, 0x85ebca6b) >>> 0
  v ^= v >>> 13
  v = Math.imul(v, 0xc2b2ae35) >>> 0
  return (v ^= v >>> 16) >>> 0
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x1000193) >>> 0
  }
  return mix(h)
}

function isTriEven(n: number): boolean {
  return ((n * (n + 1)) & 1) === 0
}

function buildKeystreamState(seed: string, mediaId: number): { S: number[]; acc: number } {
  const S = Array<number>(61)
  let n = mix(fnv1a(seed) ^ mix((mediaId >>> 0) ^ 0x9e3779b9)) >>> 0
  for (let e = 0; e < 8; e++) {
    if (isTriEven(e)) {
      const a = n % 61
      n = rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & e))
      S[a] = (n ^ mix(n)) >>> 0
      n = mix((n + a) >>> 0)
    } else {
      S[e] = KDF_TABLE[15 & e]!
    }
  }
  return { S, acc: mix(0xa5a5a5a5 ^ n) >>> 0 }
}

function nextKeyWord(state: { S: number[]; acc: number }, step: number): number {
  const n = state.S
  let l = state.acc
  const d = l % 61
  const i = 0 - Number(d in n)
  const r = (n[d] ?? 0) >>> 0
  const c = Math.imul(0x9e3779b9, step + 1) >>> 0
  let b = ((l ^ ((r ^ c) >>> 0)) >>> 0 | ((l & ((r ^ c) >>> 0) & i) >>> 0)) >>> 0
  b = (rotl((b + l) >>> 0, 31 & d) ^ rotl(l, 31 & Math.imul(d, 7))) >>> 0
  l = mix((b + 0x9e3779b9) >>> 0)
  n[d] = l >>> 0
  state.acc = l
  return l >>> 0
}

function b64ToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(input.length / 4), '=')
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Decrypt STREAMCRYPTO enc=2 body → UTF-8 JSON string. */
export function decryptMovySources(ciphertext: string, seed: string, mediaId: string | number): string {
  const idNum = Number(mediaId)
  if (!Number.isFinite(idNum)) throw new Error('mediaId is required to decode sources')
  const bytes = b64ToBytes(ciphertext)
  const state = buildKeystreamState(seed, idNum)
  const key = new Uint8Array(bytes.length)
  let step = 0
  for (let i = 0; i < bytes.length; ) {
    const w = nextKeyWord(state, step++)
    key[i++] = w & 255
    if (i < bytes.length) key[i++] = (w >>> 8) & 255
    if (i < bytes.length) key[i++] = (w >>> 16) & 255
    if (i < bytes.length) key[i++] = (w >>> 24) & 255
  }
  for (let i = 0; i < bytes.length; i++) bytes[i]! ^= key[i]!
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('decrypt failed: bad seed or tampered payload')
  }
  const payload = bytes.subarray(MAGIC.length)
  return new TextDecoder('utf-8').decode(payload)
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    const r = await window.signalDesktop.fetchJsonGet(url, MOVY_PLAY_REFERER)
    return { ok: r.ok, status: r.status, text: String(r.content || '') }
  }
  try {
    const { nativeFetchText } = await import('./nativeHttp')
    const r = await nativeFetchText(url, {
      headers: {
        Accept: '*/*',
        Origin: 'https://www.movy.sx',
        Referer: MOVY_PLAY_REFERER,
      },
    })
    return { ok: r.ok, status: r.status, text: String(r.content || '') }
  } catch {
    /* fall through */
  }
  const res = await fetch(url, {
    headers: {
      Origin: 'https://www.movy.sx',
      Referer: MOVY_PLAY_REFERER,
      Accept: '*/*',
    },
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

async function fetchJson<T>(url: string): Promise<T> {
  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    const r = await window.signalDesktop.fetchJsonGet(url, MOVY_PLAY_REFERER)
    if (!r.ok) throw new Error(r.error || `Movy HTTP ${r.status}`)
    return JSON.parse(r.content || 'null') as T
  }
  try {
    const { nativeFetchJson } = await import('./nativeHttp')
    const r = await nativeFetchJson<T>(url, {
      referer: MOVY_PLAY_REFERER,
      headers: {
        Accept: 'application/json',
        Origin: 'https://www.movy.sx',
      },
    })
    if (!r.ok || r.data == null) throw new Error(r.error || 'Movy JSON failed')
    return r.data
  } catch (err) {
    if (err instanceof Error && /Movy|JSON/.test(err.message)) throw err
  }
  const res = await fetch(url, {
    headers: {
      Origin: 'https://www.movy.sx',
      Referer: MOVY_PLAY_REFERER,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Movy HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function fetchMovySeed(mediaId: string | number): Promise<string> {
  const id = String(mediaId).trim()
  const cacheKey = `${MOVY_STREAM_ORIGIN}|${id}`
  const now = Date.now()
  const hit = seedCache.get(cacheKey)
  if (hit && hit.expiresAt - 5000 > now) return hit.seed
  const data = await fetchJson<{ seed: string; ttlMs?: number }>(
    `${MOVY_STREAM_ORIGIN}/seed?mediaId=${encodeURIComponent(id)}`,
  )
  const seed = String(data.seed || '').trim()
  if (!seed) throw new Error('Movy seed missing')
  seedCache.set(cacheKey, { seed, expiresAt: now + (data.ttlMs ?? 30_000) })
  return seed
}

export type MovyMediaType = 'movie' | 'tv'

export interface MovyResolveOptions {
  tmdbId: string | number
  title: string
  mediaType: MovyMediaType
  year?: number | string
  season?: number
  episode?: number
  imdbId?: string
  totalSeasons?: number
}

export interface MovyStreamSource {
  url: string
  quality?: string
  provider: string
}

export interface MovySubtitle {
  url: string
  lang?: string
  label?: string
}

export type MovyPlayResult =
  | {
      ok: true
      mode: 'hls'
      url: string
      referer: string
      provider: string
      tmdbId: string
      season?: number
      episode?: number
      quality?: string
      subtitleUrl?: string
      subtitleKind?: 'file'
      /** movy city providers vs Atlantic/Cinecat hls.lol fallback after exhaust. */
      backend?: 'movy' | 'atlantic'
    }
  | { ok: false; error: string }

interface MovyDecodedPayload {
  sources?: Array<{ url?: string; quality?: string; file?: string }>
  subtitles?: Array<{ url?: string; lang?: string; language?: string; label?: string; file?: string }>
}

function pickEnglishSubtitle(subs: MovySubtitle[]): string | undefined {
  if (subs.length === 0) return undefined
  const scored = [...subs].sort((a, b) => {
    const score = (s: MovySubtitle) => {
      const blob = `${s.lang || ''} ${s.label || ''}`.toLowerCase()
      if (/^en\b|english|eng/.test(blob)) return 0
      if (/ja|jp|japanese/.test(blob)) return 2
      return 1
    }
    return score(a) - score(b)
  })
  return scored[0]?.url
}

function normalizeSources(raw: MovyDecodedPayload, provider: string): {
  sources: MovyStreamSource[]
  subtitles: MovySubtitle[]
} {
  const sources: MovyStreamSource[] = []
  for (const row of raw.sources || []) {
    const url = String(row.url || row.file || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    sources.push({ url, quality: row.quality ? String(row.quality) : undefined, provider })
  }
  const subtitles: MovySubtitle[] = []
  for (const row of raw.subtitles || []) {
    const url = String(row.url || row.file || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    subtitles.push({
      url,
      lang: row.lang || row.language,
      label: row.label,
    })
  }
  // Prefer higher quality labels first.
  sources.sort((a, b) => {
    const q = (s?: string) => {
      const n = Number(String(s || '').replace(/[^\d]/g, ''))
      return Number.isFinite(n) ? n : 0
    }
    return q(b.quality) - q(a.quality)
  })
  return { sources, subtitles }
}

async function fetchProviderSources(
  provider: string,
  opts: MovyResolveOptions,
  seed: string,
): Promise<{ sources: MovyStreamSource[]; subtitles: MovySubtitle[] } | null> {
  const params = new URLSearchParams()
  // URLSearchParams encodes once — double-encoding breaks some providers.
  params.set('title', opts.title)
  params.set('mediaType', opts.mediaType)
  if (opts.year != null && String(opts.year).trim()) params.set('year', String(opts.year))
  if (opts.totalSeasons != null) params.set('totalSeasons', String(opts.totalSeasons))
  if (opts.mediaType === 'tv') {
    params.set('seasonId', String(Math.max(1, opts.season || 1)))
    params.set('episodeId', String(Math.max(1, opts.episode || 1)))
  }
  params.set('tmdbId', String(opts.tmdbId))
  if (opts.imdbId) params.set('imdbId', opts.imdbId)
  params.set('enc', '2')
  params.set('seed', seed)

  const url = `${MOVY_STREAM_ORIGIN}/${provider}/sources?${params.toString()}`
  const res = await fetchText(url)
  if (res.status === 401) {
    seedCache.delete(`${MOVY_STREAM_ORIGIN}|${opts.tmdbId}`)
    return null
  }
  if (!res.ok || !res.text.trim()) return null
  try {
    const json = decryptMovySources(res.text.trim(), seed, opts.tmdbId)
    return normalizeSources(JSON.parse(json) as MovyDecodedPayload, provider)
  } catch {
    return null
  }
}

/**
 * Movy CDNs often return HTTP 200/400 bodies like "Please wait file process."
 * instead of a playlist while the object is still baking — treat as dead.
 */
export async function probeMovyHlsUrl(
  url: string,
  referer: string = MOVY_PLAY_REFERER,
): Promise<boolean> {
  if (!url) return false
  const headers: Record<string, string> = {
    Accept: '*/*',
    Referer: referer,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  try {
    // Android: short CapacitorHttp timeouts — default nativeHttp is 30–45s and
    // left "Trying Movy…" stuck for minutes while paleoak/zenoak hung.
    if (typeof window !== 'undefined') {
      try {
        const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
        if (Capacitor.isNativePlatform()) {
          const res = await CapacitorHttp.get({
            url,
            headers,
            responseType: 'text',
            connectTimeout: 2_500,
            readTimeout: 2_500,
          })
          const body = String(res.data ?? '').trim()
          if (res.status < 200 || res.status >= 300) return false
          if (!body) return false
          if (/please wait|file process|not (yet )?ready|processing/i.test(body)) return false
          return /#EXTM3U/i.test(body)
        }
      } catch {
        /* fall through */
      }
    }

    if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
      const r = await Promise.race([
        window.signalDesktop.fetchJsonGet(url, referer),
        new Promise<{ ok: false; status: number; content: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, status: 0, content: '' }), 2_500),
        ),
      ])
      const body = String(r.content || '').trim()
      if (!r.ok && !(Number(r.status) >= 200)) return false
      if (!body) return false
      if (/please wait|file process|not (yet )?ready|processing/i.test(body)) return false
      if (Number(r.status) >= 400) return false
      return /#EXTM3U/i.test(body)
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2_500),
    })
    const body = (await res.text().catch(() => '')).trim()
    if (!res.ok) return false
    if (!body) return false
    if (/please wait|file process|not (yet )?ready|processing/i.test(body)) return false
    return /#EXTM3U/i.test(body)
  } catch {
    return false
  }
}

export async function resolveMovyPlay(options: MovyResolveOptions): Promise<MovyPlayResult> {
  const tmdbId = String(options.tmdbId || '').trim()
  const title = String(options.title || '').trim()
  if (!tmdbId) return { ok: false, error: 'No TMDB id for Movy' }
  if (!title) return { ok: false, error: 'No title for Movy' }

  const season = options.mediaType === 'tv' ? Math.max(1, options.season || 1) : undefined
  const episode = options.mediaType === 'tv' ? Math.max(1, options.episode || 1) : undefined
  // Keep the city walk short — CDN objects are shared; 8×45s hung Android on "Trying Movy…".
  const providers = (
    options.mediaType === 'tv' ? MOVY_TV_PROVIDERS : MOVY_MOVIE_PROVIDERS
  ).slice(0, 2)

  const tryAtlanticFallback = async (): Promise<MovyPlayResult | null> => {
    try {
      const alt = await resolveAtlanticPlay({
        tmdbId,
        mediaType: options.mediaType,
        season,
        episode,
        title,
      })
      if (!alt.ok) return null
      return {
        ok: true,
        mode: 'hls',
        url: alt.url,
        referer: alt.referer,
        provider: alt.provider,
        tmdbId,
        season,
        episode,
        backend: 'atlantic',
      }
    } catch {
      return null
    }
  }

  // Kick Atlantic immediately so a dead Movy CDN doesn't block the whole resolve.
  const atlanticPromise = tryAtlanticFallback()

  let seed: string
  try {
    seed = await fetchMovySeed(tmdbId)
  } catch (err) {
    const atlantic = await atlanticPromise
    if (atlantic) return atlantic
    return { ok: false, error: err instanceof Error ? err.message : 'Movy seed failed' }
  }

  let seedRefreshTried = false

  for (const provider of providers) {
    let decoded = await fetchProviderSources(provider, options, seed)
    if (!decoded && !seedRefreshTried) {
      seedRefreshTried = true
      try {
        seedCache.delete(`${MOVY_STREAM_ORIGIN}|${tmdbId}`)
        seed = await fetchMovySeed(tmdbId)
        decoded = await fetchProviderSources(provider, options, seed)
      } catch {
        decoded = null
      }
    }
    if (!decoded || decoded.sources.length === 0) continue

    const best = decoded.sources[0]!
    const alive = await probeMovyHlsUrl(best.url, MOVY_PLAY_REFERER)
    if (!alive) {
      // One dead CDN object → skip remaining Movy cities and take Atlantic.
      break
    }
    const sub = pickEnglishSubtitle(decoded.subtitles)
    return {
      ok: true,
      mode: 'hls',
      url: best.url,
      referer: MOVY_PLAY_REFERER,
      provider: best.provider,
      tmdbId,
      season,
      episode,
      quality: best.quality,
      subtitleUrl: sub,
      subtitleKind: sub ? 'file' : undefined,
      backend: 'movy',
    }
  }

  const atlantic = await atlanticPromise
  if (atlantic) return atlantic

  return { ok: false, error: 'No Movy or Atlantic streams for this title' }
}
