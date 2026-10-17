/**
 * Movy (movy.sx) — TMDB-backed Direct streams via api.wecollege.net.
 * Seed + STREAMCRYPTO (enc=2) → JSON { sources, subtitles }.
 * Desktop/native Player path only — not an embed shell.
 */

import { Capacitor } from '@capacitor/core'
import { resolveAtlanticPlay } from './atlanticHls'
import { getPerformanceKnobs } from './deviceProfile'
import { resolveStreamoPlay } from './streamo'
import {
  getLearnedStreamScore,
  recordStreamProbeResult,
} from './streamLearning'
import { getViewingQuality, resolveRequestedQuality } from './viewingQuality'

export const MOVY_STREAM_ORIGIN = 'https://api.wecollege.net'
export const MOVY_PLAY_REFERER = 'https://www.movy.sx/'

/**
 * Cities each carry a different slice of the catalog (reality TV often only on
 * atlanta / phoenix / portland), so all are queried in parallel. CDN links need
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
  'orlando',
  'tampa',
  'paris',
] as const

const MOVY_SOURCES_TIMEOUT_MS = 8_000
const MOVY_DURATION_TIMEOUT_MS = 4_000
/** After the first live English city, wait briefly for a peer (duration vote) then pick. */
const MOVY_EARLY_PEER_GRACE_MS = 750
/** Same-episode renditions differ by under a minute; a different file is far off. */
const MOVY_DURATION_TOLERANCE_SEC = 120

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
    if (!r.ok) throw new Error(r.error || `Source HTTP ${r.status}`)
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
    if (!r.ok || r.data == null) throw new Error(r.error || 'Source JSON failed')
    return r.data
  } catch (err) {
    if (err instanceof Error && /Source|Movy|JSON/.test(err.message)) throw err
  }
  const res = await fetch(url, {
    headers: {
      Origin: 'https://www.movy.sx',
      Referer: MOVY_PLAY_REFERER,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Source HTTP ${res.status}`)
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
  if (!seed) throw new Error('Source seed missing')
  seedCache.set(cacheKey, { seed, expiresAt: now + (data.ttlMs ?? 30_000) })
  return seed
}

export type MovyMediaType = 'movie' | 'tv'
export type MovyBackend = 'movy' | 'atlantic' | 'streamo'

export interface MovyResolveOptions {
  tmdbId: string | number
  title: string
  mediaType: MovyMediaType
  year?: number | string
  season?: number
  episode?: number
  imdbId?: string
  totalSeasons?: number
  /** Prefer the backend that last played this title on this device. */
  preferBackend?: MovyBackend
  /** Prefer a Movy city that worked last time (e.g. miami). */
  preferProvider?: string
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
      /** movy city providers vs Atlantic (hls.lol) / Streamo (ShowBox) fallbacks. */
      backend?: MovyBackend
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
      if (/^en\b|english|\beng\b/.test(blob)) return 0
      if (!blob.trim() || /^(und|unknown)$/.test(blob)) return 1
      return 3
    }
    return score(a) - score(b)
  })
  const best = scored[0]
  if (!best?.url) return undefined
  const blob = `${best.lang || ''} ${best.label || ''}`.toLowerCase()
  // Only attach clearly English (or unlabeled) — never JA/FR as the default softsub.
  if (/^en\b|english|\beng\b/.test(blob)) return best.url
  if (!blob.trim() || /^(und|unknown)$/.test(blob)) return best.url
  return undefined
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
  // Rank for the current device/network target — not blindly highest.
  const cap = movyQualityCap()
  sources.sort((a, b) => compareMovySources(a, b, cap))
  return { sources, subtitles }
}

/**
 * Same target as Player Auto / torrent picks: viewing pref ∩ device maxQuality.
 * Android WebView + Movy Direct: Auto never locks a single 2160p playlist
 * (10MB+/6s segments) unless the user explicitly chose 4K.
 */
function movyQualityCap(): number {
  const preference = getViewingQuality()
  let cap = Math.min(resolveRequestedQuality(preference), getPerformanceKnobs().maxQuality)
  try {
    if (
      preference !== 2160 &&
      cap > 1080 &&
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === 'android'
    ) {
      cap = 1080
    }
  } catch {
    /* browser / Node probes */
  }
  return cap
}

function sourceHeight(s: MovyStreamSource): number {
  const fromLabel = Number(String(s.quality || '').replace(/[^\d]/g, ''))
  if (Number.isFinite(fromLabel) && fromLabel > 0) return fromLabel
  // Miami Direct embeds height in the playlist name (index-s2160p-…).
  const fromUrl = /\b(?:s)?(2160|1440|1080|720|480|360)p\b/i.exec(s.url)
  return fromUrl ? Number(fromUrl[1]) : 0
}

function isAutoQualityLabel(s: MovyStreamSource): boolean {
  return /^auto$/i.test(String(s.quality || '').trim())
}

/**
 * Prefer Auto (ABR master, like movy.sx) when under the quality cap, then highest
 * fixed ladder at/under cap. Unlabeled / over-cap last.
 */
function compareMovySources(a: MovyStreamSource, b: MovyStreamSource, cap: number): number {
  const aAuto = isAutoQualityLabel(a)
  const bAuto = isAutoQualityLabel(b)
  // Auto masters ABR like the website — prefer over a locked 1080p city label.
  if (aAuto !== bAuto) return aAuto ? -1 : 1
  const ha = sourceHeight(a)
  const hb = sourceHeight(b)
  const aOk = ha > 0 && ha <= cap
  const bOk = hb > 0 && hb <= cap
  if (aOk !== bOk) return aOk ? -1 : 1
  if (aOk && bOk) return hb - ha
  if (ha === 0 && hb === 0) return 0
  if (ha === 0) return 1
  if (hb === 0) return -1
  return ha - hb
}

function pickMovySource(sources: MovyStreamSource[]): MovyStreamSource | null {
  if (!sources.length) return null
  const cap = movyQualityCap()
  return [...sources].sort((a, b) => compareMovySources(a, b, cap))[0] ?? null
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
/** Soft probe budget — paleoak masters often need ~6s; Auto cities answer in <500ms. */
const MOVY_PROBE_TIMEOUT_MS = 7_500

export type MovyProbeResult = { ok: boolean; ms: number; abrMaster?: boolean }

function classifyMovyPlaylistBody(body: string): { ok: boolean; abrMaster: boolean } {
  const text = String(body || '').trim()
  if (!text) return { ok: false, abrMaster: false }
  if (/please wait|file process|not (yet )?ready|processing/i.test(text)) {
    return { ok: false, abrMaster: false }
  }
  if (!/#EXTM3U/i.test(text)) return { ok: false, abrMaster: false }
  // Paleoak often labels the master "1080p" even though it is a full ladder.
  return { ok: true, abrMaster: /#EXT-X-STREAM-INF/i.test(text) }
}

/**
 * Probe a Movy HLS URL. Returns latency so resolvers can prefer website-fast
 * Auto CDNs over multi-second paleoak masters that stall anime playback.
 */
export async function probeMovyHlsUrlDetailed(
  url: string,
  referer: string = MOVY_PLAY_REFERER,
): Promise<MovyProbeResult> {
  if (!url) return { ok: false, ms: 0 }
  const headers: Record<string, string> = {
    Accept: '*/*',
    Referer: referer,
    Origin: 'https://www.movy.sx',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  const started = Date.now()
  const elapsed = () => Date.now() - started
  try {
    if (typeof window !== 'undefined') {
      try {
        const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
        if (Capacitor.isNativePlatform()) {
          const res = await CapacitorHttp.get({
            url,
            headers,
            responseType: 'text',
            connectTimeout: MOVY_PROBE_TIMEOUT_MS,
            readTimeout: MOVY_PROBE_TIMEOUT_MS,
          })
          if (res.status < 200 || res.status >= 300) return { ok: false, ms: elapsed() }
          const classified = classifyMovyPlaylistBody(String(res.data ?? ''))
          return { ...classified, ms: elapsed() }
        }
      } catch {
        /* fall through */
      }
    }

    if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
      const r = await Promise.race([
        window.signalDesktop.fetchJsonGet(url, referer),
        new Promise<{ ok: false; status: number; content: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, status: 0, content: '' }), MOVY_PROBE_TIMEOUT_MS),
        ),
      ])
      if (!r.ok && !(Number(r.status) >= 200)) return { ok: false, ms: elapsed() }
      if (Number(r.status) >= 400) return { ok: false, ms: elapsed() }
      const classified = classifyMovyPlaylistBody(String(r.content || ''))
      return { ...classified, ms: elapsed() }
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(MOVY_PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, ms: elapsed() }
    const classified = classifyMovyPlaylistBody(await res.text().catch(() => ''))
    return { ...classified, ms: elapsed() }
  } catch {
    return { ok: false, ms: elapsed() }
  }
}

export async function probeMovyHlsUrl(
  url: string,
  referer: string = MOVY_PLAY_REFERER,
): Promise<boolean> {
  return (await probeMovyHlsUrlDetailed(url, referer)).ok
}

/**
 * Movy "paris" (and similarly named cities) often ship French dubs.
 * Prefer US cities whenever any non-FR city answered.
 */
function isLikelyForeignDubMovyProvider(provider: string): boolean {
  const p = String(provider || '')
    .trim()
    .toLowerCase()
  return p === 'paris' || /french|france|\bfr\b/.test(p)
}

function rankMovyProviders(
  base: readonly string[],
  preferProvider?: string,
): string[] {
  const pref = String(preferProvider || '')
    .trim()
    .toLowerCase()
  // Never pin a French-dub city first from "last played" memory.
  const prefer = pref && !isLikelyForeignDubMovyProvider(pref) ? pref : ''
  return [...base].sort((a, b) => {
    const foreignA = isLikelyForeignDubMovyProvider(a) ? 1 : 0
    const foreignB = isLikelyForeignDubMovyProvider(b) ? 1 : 0
    if (foreignA !== foreignB) return foreignA - foreignB
    if (prefer) {
      if (a === prefer && b !== prefer) return -1
      if (b === prefer && a !== prefer) return 1
    }
    const scoreA = getLearnedStreamScore(a)
    const scoreB = getLearnedStreamScore(b)
    if (Math.abs(scoreB - scoreA) >= 0.02) return scoreB - scoreA
    return base.indexOf(a) - base.indexOf(b)
  })
}

export async function resolveMovyPlay(options: MovyResolveOptions): Promise<MovyPlayResult> {
  const tmdbId = String(options.tmdbId || '').trim()
  const title = String(options.title || '').trim()
  if (!tmdbId) return { ok: false, error: 'No TMDB id for this title' }
  if (!title) return { ok: false, error: 'No title for this source' }

  const season = options.mediaType === 'tv' ? Math.max(1, options.season || 1) : undefined
  const episode = options.mediaType === 'tv' ? Math.max(1, options.episode || 1) : undefined
  const providers = rankMovyProviders(
    options.mediaType === 'tv' ? MOVY_TV_PROVIDERS : MOVY_MOVIE_PROVIDERS,
    options.preferProvider,
  )

  const tryAtlanticFallback = async (): Promise<MovyPlayResult | null> => {
    const started = Date.now()
    try {
      const alt = await resolveAtlanticPlay({
        tmdbId,
        mediaType: options.mediaType,
        season,
        episode,
        title,
      })
      if (!alt.ok) {
        recordStreamProbeResult('atlantic', false, Date.now() - started)
        return null
      }
      recordStreamProbeResult('atlantic', true, Date.now() - started)
      if (alt.provider) recordStreamProbeResult(alt.provider, true, Date.now() - started)
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
      recordStreamProbeResult('atlantic', false, Date.now() - started)
      return null
    }
  }

  const tryStreamoFallback = async (): Promise<MovyPlayResult | null> => {
    const started = Date.now()
    try {
      const alt = await resolveStreamoPlay({ tmdbId, mediaType: options.mediaType, season, episode })
      recordStreamProbeResult('streamo', alt.ok, Date.now() - started)
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
        backend: 'streamo',
      }
    } catch {
      recordStreamProbeResult('streamo', false, Date.now() - started)
      return null
    }
  }

  const resolveMovyCities = async (): Promise<MovyPlayResult | null> => {
    type AliveCity = {
      provider: string
      decoded: NonNullable<Awaited<ReturnType<typeof fetchProviderSources>>>
      best: NonNullable<ReturnType<typeof pickMovySource>>
      started: number
      probeMs: number
      /** True when the playlist is a multi-bitrate master (true ABR ladder). */
      abrMaster: boolean
    }

    const buildResult = (pick: AliveCity): MovyPlayResult => {
      const sub = pickEnglishSubtitle(pick.decoded.subtitles)
      return {
        ok: true,
        mode: 'hls',
        url: pick.best.url,
        referer: MOVY_PLAY_REFERER,
        provider: pick.best.provider || pick.provider,
        tmdbId,
        season,
        episode,
        quality: pick.best.quality,
        subtitleUrl: sub,
        subtitleKind: sub ? 'file' : undefined,
        backend: 'movy',
      }
    }

    const pickFromPool = async (englishAlive: AliveCity[]): Promise<MovyPlayResult | null> => {
      if (englishAlive.length === 0) return null
      let pool = englishAlive
      // Prefer website-fast Auto CDNs (majorplay ~200ms) over paleoak (~6s masters
      // + 9s segments) that buffer/stall anime on desktop and Android.
      const fast = pool.filter((c) => c.probeMs > 0 && c.probeMs <= 2_000)
      if (fast.length > 0) pool = fast
      pool = [...pool].sort((a, b) => {
        // Prefer real ABR masters (incl. paleoak "1080p" labels that are ladders).
        const aAbr = a.abrMaster || isAutoQualityLabel(a.best) ? 0 : 1
        const bAbr = b.abrMaster || isAutoQualityLabel(b.best) ? 0 : 1
        if (aAbr !== bAbr) return aAbr - bAbr
        return a.probeMs - b.probeMs
      })

      let pick = pool[0]!
      // Some cities hand back the wrong episode (another file of the season) —
      // keep the rendition whose runtime most other cities agree on, then fastest.
      if (options.mediaType === 'tv' && pool.length >= 2) {
        const durations = await Promise.all(
          pool.map((c) =>
            withTimeoutOr(fetchHlsDurationSec(c.best.url), MOVY_DURATION_TIMEOUT_MS, 0),
          ),
        )
        let bestVotes = -1
        let bestMs = Number.POSITIVE_INFINITY
        pool.forEach((c, i) => {
          const d = durations[i]!
          const votes =
            d > 0
              ? durations.filter((o) => o > 0 && Math.abs(o - d) <= MOVY_DURATION_TOLERANCE_SEC)
                  .length
              : 0
          if (votes > bestVotes || (votes === bestVotes && c.probeMs < bestMs)) {
            bestVotes = votes
            bestMs = c.probeMs
            pick = c
          }
        })
      }
      return buildResult(pick)
    }

    /**
     * Race city providers: HTTP 500/empty drop immediately; probe survivors as they
     * arrive; return as soon as an English city is live instead of waiting for
     * miami/seattle/boise (etc.) to finish their timeouts.
     */
    const raceCities = (s: string): Promise<MovyPlayResult | null> =>
      new Promise((resolve) => {
        let finished = false
        let pending = providers.length
        const englishAlive: AliveCity[] = []
        const seenUrls = new Set<string>()
        let graceTimer: ReturnType<typeof setTimeout> | null = null

        const settleOne = () => {
          pending -= 1
          if (pending <= 0) void finalize()
        }

        const finalize = async () => {
          if (finished) return
          finished = true
          if (graceTimer != null) {
            clearTimeout(graceTimer)
            graceTimer = null
          }
          // Skip French-dub-only answers so Atlantic/Streamo can try English.
          resolve(await pickFromPool(englishAlive))
        }

        const armEarlyPick = () => {
          if (finished || graceTimer != null) return
          graceTimer = setTimeout(() => {
            graceTimer = null
            void finalize()
          }, MOVY_EARLY_PEER_GRACE_MS)
        }

        for (const provider of providers) {
          void (async () => {
            const started = Date.now()
            const decoded = await withTimeoutOr(
              fetchProviderSources(provider, options, s),
              MOVY_SOURCES_TIMEOUT_MS,
              null,
            )
            if (finished) {
              settleOne()
              return
            }
            if (!decoded?.sources.length) {
              recordStreamProbeResult(provider, false, Date.now() - started)
              settleOne()
              return
            }
            const best = pickMovySource(decoded.sources)
            if (!best?.url) {
              recordStreamProbeResult(provider, false, Date.now() - started)
              settleOne()
              return
            }
            if (seenUrls.has(best.url)) {
              settleOne()
              return
            }
            seenUrls.add(best.url)

            const probe = await probeMovyHlsUrlDetailed(best.url, MOVY_PLAY_REFERER)
            recordStreamProbeResult(provider, probe.ok, Date.now() - started)
            recordStreamProbeResult(best.url, probe.ok, Date.now() - started)
            if (finished) {
              settleOne()
              return
            }
            if (
              probe.ok &&
              !isLikelyForeignDubMovyProvider(provider)
            ) {
              englishAlive.push({
                provider,
                decoded,
                best,
                started,
                probeMs: probe.ms,
                abrMaster: Boolean(probe.abrMaster),
              })
              // Two English cities: pick now (duration vote). One live city: short
              // grace so a peer can join, then pick without waiting on 500/hung cities.
              if (englishAlive.length >= 2) {
                void finalize()
                return
              }
              armEarlyPick()
            }
            settleOne()
          })()
        }
      })

    let seed: string
    try {
      seed = await fetchMovySeed(tmdbId)
    } catch {
      return null
    }
    const seedKey = `${MOVY_STREAM_ORIGIN}|${tmdbId}`
    let result = await raceCities(seed)
    // fetchProviderSources drops the cached seed on 401 — refresh once and retry.
    if (!result && !seedCache.has(seedKey)) {
      try {
        seed = await fetchMovySeed(tmdbId)
        result = await raceCities(seed)
      } catch {
        /* keep first pass */
      }
    }
    return result
  }

  // Kick fallbacks immediately — Streamo alone needs ~9s for its provider lookup.
  const fallbacks = {
    atlantic: tryAtlanticFallback(),
    streamo: tryStreamoFallback(),
  }
  const fallbackOrder: Array<keyof typeof fallbacks> =
    options.preferBackend === 'streamo' ? ['streamo', 'atlantic'] : ['atlantic', 'streamo']

  const preferred = options.preferBackend
  if (preferred === 'atlantic' || preferred === 'streamo') {
    const first = await fallbacks[preferred]
    if (first) return first
  }

  const movy = await resolveMovyCities()
  if (movy) return movy

  for (const key of fallbackOrder) {
    if (key === preferred) continue
    const alt = await fallbacks[key]
    if (alt) return alt
  }

  return { ok: false, error: 'No streams for this title' }
}

function withTimeoutOr<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/** Total #EXTINF seconds of an HLS stream (first variant of a master). 0 if unknown. */
async function fetchHlsDurationSec(url: string): Promise<number> {
  let res = await fetchText(url)
  if (!res.ok) return 0
  if (/#EXT-X-STREAM-INF/i.test(res.text)) {
    const variant = res.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    if (!variant) return 0
    res = await fetchText(new URL(variant, url).href)
    if (!res.ok) return 0
  }
  let total = 0
  for (const m of res.text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number(m[1]) || 0
  return total
}
