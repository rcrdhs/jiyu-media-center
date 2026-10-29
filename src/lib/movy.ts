/**
 * Movy (movy.sx) — TMDB-backed Direct streams via api.wecollege.net.
 * Seed + STREAMCRYPTO (enc=2) → JSON { sources, subtitles }.
 * Desktop/native Player path only — not an embed shell.
 */

import { Capacitor } from '@capacitor/core'
import { resolveAtlanticPlay } from './atlanticHls'
import { getPerformanceKnobs } from './deviceProfile'
import {
  getLearnedStreamScore,
  recordStreamProbeResult,
} from './streamLearning'
import { getViewingQuality, resolveRequestedQuality } from './viewingQuality'
import { normalizeLanguageCode } from './language'
import { tizenHlsSource } from './tizenRelay'
import { isTizenTv } from './tvMode'

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
/** Samsung: how long to wait for Helios when Movy only offered fMP4. */
const MOVY_TIZEN_HELIOS_WAIT_MS = 8_000
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
    if (!r.ok || r.data == null) {
      // An HTTP status (429 / 403 ...) is the answer: a second plain fetch of the
      // same URL only doubles the request count against Movy's rate limit.
      const msg = r.error || ''
      throw new Error(/^HTTP \d+/.test(msg) ? `Source ${msg}` : msg || 'Source JSON failed')
    }
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
  let data: { seed: string; ttlMs?: number }
  try {
    data = await fetchJson<{ seed: string; ttlMs?: number }>(
      `${MOVY_STREAM_ORIGIN}/seed?mediaId=${encodeURIComponent(id)}`,
    )
  } catch (err) {
    if (err instanceof Error && /\b429\b/.test(err.message)) movyRateLimitedAt = Date.now()
    throw err
  }
  const seed = String(data.seed || '').trim()
  if (!seed) throw new Error('Source seed missing')
  seedCache.set(cacheKey, { seed, expiresAt: now + (data.ttlMs ?? 30_000) })
  return seed
}

export type MovyMediaType = 'movie' | 'tv'
export type MovyBackend = 'movy' | 'atlantic'

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
  /**
   * TMDB original_language (ISO 639-1). Cities that list several language
   * streams (austin: Hindi / English / Tamil...) pick this first, then English.
   * Looked up from TMDB when omitted.
   */
  originalLanguage?: string
  /** Audio menu: play this language key (see MovyAudioOption.key) when listed. */
  audioLanguage?: string
  /** Retry: skip this city so a different source is picked. */
  avoidProvider?: string
  /**
   * Only ask these cities (Audio menu re-resolve on the current city). Skips the
   * Atlantic fallback, which have no language choice.
   */
  providers?: string[]
}

export interface MovyStreamSource {
  url: string
  quality?: string
  provider: string
  /** Spoken language read from the source label ("Hindi", "English"...); '' when unlabeled. */
  language?: string
  /** Label says "Subbed" (subtitled release). */
  subbed?: boolean
}

/** One same-city language stream for the Player Audio menu. */
export interface MovyAudioOption {
  /** Language code, "<code>:sub" for subbed releases, or "und" for unlabeled. */
  key: string
  label: string
  url: string
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
      /** movy city providers vs the Atlantic (hls.lol) fallback. */
      backend?: MovyBackend
      /** Audio key of the chosen Movy source (see MovyAudioOption.key). */
      language?: string
      /**
       * False when the stream is a dub in a language other than the original /
       * English (only possible when the Audio menu forced it). Callers must not
       * remember such a pick as "last good".
       */
      languageOk?: boolean
      /** Same-city language streams (2+ when the city offers a choice). */
      audioOptions?: MovyAudioOption[]
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
    const quality = row.quality ? String(row.quality) : undefined
    const lang = movySourceLanguage(quality)
    sources.push({ url, quality, provider, language: lang.language, subbed: lang.subbed })
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

const MOVY_LANGUAGE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(english|eng)\b/i, 'en'],
  [/\bhindi\b/i, 'hi'],
  [/\btamil\b/i, 'ta'],
  [/\btelugu\b/i, 'te'],
  [/\b(bengali|bangla)\b/i, 'bn'],
  [/\bmalayalam\b/i, 'ml'],
  [/\bkannada\b/i, 'kn'],
  [/\bmarathi\b/i, 'mr'],
  [/\bpunjabi\b/i, 'pa'],
  [/\burdu\b/i, 'ur'],
  [/\b(spanish|espanol|latino|castellano)\b|espa\u00f1ol/i, 'es'],
  [/\b(french|francais)\b|fran\u00e7ais/i, 'fr'],
  [/\b(german|deutsch)\b/i, 'de'],
  [/\b(italian|italiano)\b/i, 'it'],
  [/\b(portuguese|portugues)\b|portugu\u00eas/i, 'pt'],
  [/\brussian\b/i, 'ru'],
  [/\bjapanese\b/i, 'ja'],
  [/\bkorean\b/i, 'ko'],
  [/\b(chinese|mandarin|cantonese)\b/i, 'zh'],
  [/\barabic\b/i, 'ar'],
  [/\bturkish\b/i, 'tr'],
  [/\bthai\b/i, 'th'],
  [/\bindonesian\b/i, 'id'],
  [/\bpolish\b/i, 'pl'],
  [/\bvietnamese\b/i, 'vi'],
]

/**
 * Some cities (austin) label each source with a spoken language instead of a
 * height: "Hindi", "English", "Tamil", "Hindi Subbed". Each is its own master
 * with a single audio track, so the language must be chosen per source.
 */
export function movySourceLanguage(label?: string): { language: string; subbed: boolean } {
  const text = String(label || '').trim()
  if (!text || /\b(dual|multi)\b/i.test(text)) return { language: '', subbed: false }
  for (const [re, code] of MOVY_LANGUAGE_PATTERNS) {
    if (re.test(text)) {
      return { language: code, subbed: /\bsub(bed|s|titled)?\b/i.test(text) && !/\bdub/i.test(text) }
    }
  }
  return { language: '', subbed: false }
}

/** Audio menu key: "hi", "hi:sub", or "und" for unlabeled sources. */
export function movyAudioKey(s: Pick<MovyStreamSource, 'language' | 'subbed'>): string {
  if (!s.language) return 'und'
  return s.subbed ? `${s.language}:sub` : s.language
}

type MovyLanguagePref = {
  /** Normalized TMDB original language ('' when unknown). */
  original: string
  /** Audio-menu key the user picked ('' = automatic). */
  forced: string
}

const MOVY_LANGUAGE_OK_RANK = 2

/**
 * 0 original audio (or English / unlabeled for English-original titles),
 * 1 unlabeled on a non-English title, 2 English dub of a non-English title,
 * 3 subbed release, 4 another language's dub.
 */
function movyBaseLanguageRank(s: MovyStreamSource, original: string): number {
  const englishOriginal = !original || original === 'en'
  if (s.subbed) return s.language === original && !englishOriginal ? 1 : 3
  if (!s.language) return englishOriginal ? 0 : 1
  if (original && s.language === original) return 0
  if (s.language === 'en') return englishOriginal ? 0 : 2
  return 4
}

function movyLanguageRank(s: MovyStreamSource, pref?: MovyLanguagePref): number {
  if (!pref) return 0
  const base = movyBaseLanguageRank(s, pref.original)
  if (pref.forced) return movyAudioKey(s) === pref.forced ? 0 : base + 10
  return base
}

function isMovyLanguageOk(s: MovyStreamSource, pref: MovyLanguagePref): boolean {
  return movyBaseLanguageRank(s, pref.original) <= MOVY_LANGUAGE_OK_RANK
}

function movyAudioLabel(s: MovyStreamSource): string {
  if (!s.language) return 'Default'
  const raw = String(s.quality || '').replace(/\s+/g, ' ').trim()
  if (raw && raw.length <= 24) return raw
  return s.subbed ? `${s.language.toUpperCase()} (sub)` : s.language.toUpperCase()
}

function buildMovyAudioOptions(sources: MovyStreamSource[], pref: MovyLanguagePref): MovyAudioOption[] {
  if (!sources.some((s) => s.language)) return []
  const cap = movyQualityCap()
  const byKey = new Map<string, MovyStreamSource>()
  for (const s of [...sources].sort((a, b) => compareMovySources(a, b, cap))) {
    const key = movyAudioKey(s)
    if (!byKey.has(key)) byKey.set(key, s)
  }
  if (byKey.size < 2) return []
  const auto: MovyLanguagePref = { original: pref.original, forced: '' }
  return [...byKey.entries()]
    .sort((a, b) => movyLanguageRank(a[1], auto) - movyLanguageRank(b[1], auto))
    .map(([key, s]) => ({ key, label: movyAudioLabel(s), url: s.url }))
}

/** What the Player needs to show the Audio menu / rotate a Movy movie. */
export type MovyPlaySession = {
  provider: string
  backend: MovyBackend
  /** Current audio key ('' when not a Movy city). */
  language: string
  audioOptions: MovyAudioOption[]
  /** The resolve request that produced this URL (Audio menu re-resolves with it). */
  request: MovyResolveOptions
}

const movyPlaySessions = new Map<string, MovyPlaySession>()

/** Kept in memory by played URL so option URLs never land in persisted StreamItems. */
export function rememberMovyPlaySession(url: string, session: MovyPlaySession): void {
  if (!url) return
  movyPlaySessions.delete(url)
  movyPlaySessions.set(url, session)
  while (movyPlaySessions.size > 40) {
    const oldest = movyPlaySessions.keys().next().value
    if (oldest == null) break
    movyPlaySessions.delete(oldest)
  }
}

export function getMovyPlaySession(url: string | undefined | null): MovyPlaySession | null {
  if (!url) return null
  return movyPlaySessions.get(url) ?? null
}

const tmdbOriginalLanguageCache = new Map<string, string>()

async function lookupMovyOriginalLanguage(tmdbId: string, mediaType: MovyMediaType): Promise<string> {
  const key = `${mediaType}:${tmdbId}`
  const hit = tmdbOriginalLanguageCache.get(key)
  if (hit != null) return hit
  try {
    // Lazy: rivestream pulls in the torrent stack; keep it off movy's load path.
    const { fetchTmdbOriginalLanguage } = await import('./rivestream')
    const lang = normalizeLanguageCode(await fetchTmdbOriginalLanguage(tmdbId, mediaType))
    tmdbOriginalLanguageCache.set(key, lang)
    return lang
  } catch {
    return ''
  }
}

/**
 * Prefer Auto (ABR master, like movy.sx) when under the quality cap, then highest
 * fixed ladder at/under cap. Unlabeled / over-cap last. With a language pref,
 * the spoken language outranks quality (austin labels sources by language only).
 */
function compareMovySources(
  a: MovyStreamSource,
  b: MovyStreamSource,
  cap: number,
  pref?: MovyLanguagePref,
): number {
  if (pref) {
    const la = movyLanguageRank(a, pref)
    const lb = movyLanguageRank(b, pref)
    if (la !== lb) return la - lb
  }
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

function pickMovySource(
  sources: MovyStreamSource[],
  pref?: MovyLanguagePref,
): MovyStreamSource | null {
  if (!sources.length) return null
  const cap = movyQualityCap()
  return [...sources].sort((a, b) => compareMovySources(a, b, cap, pref))[0] ?? null
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
  if (res.status === 429) movyRateLimitedAt = Date.now()
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
  const baseProviders = options.mediaType === 'tv' ? MOVY_TV_PROVIDERS : MOVY_MOVIE_PROVIDERS
  const onlyProviders = (options.providers || [])
    .map((p) => String(p || '').trim().toLowerCase())
    .filter((p) => (baseProviders as readonly string[]).includes(p))
  const avoidProvider = String(options.avoidProvider || '').trim().toLowerCase()
  let providers = rankMovyProviders(
    onlyProviders.length ? onlyProviders : baseProviders,
    options.preferProvider,
  )
  // Retry: rotate away from the city that just failed / played the wrong file.
  if (avoidProvider && providers.length > 1) {
    providers = providers.filter((p) => p !== avoidProvider)
  }
  const citiesOnly = onlyProviders.length > 0
  const forcedAudio = String(options.audioLanguage || '').trim().toLowerCase()
  const givenOriginal = normalizeLanguageCode(options.originalLanguage)
  // Fetched in parallel with the seed; a slow TMDB just means "assume English".
  const originalLanguagePromise: Promise<string> = givenOriginal
    ? Promise.resolve(givenOriginal)
    : withTimeoutOr(lookupMovyOriginalLanguage(tmdbId, options.mediaType), 3_000, '')

  const withSession = (result: MovyPlayResult): MovyPlayResult => {
    if (result.ok) {
      rememberMovyPlaySession(result.url, {
        provider: result.provider,
        backend: result.backend ?? 'movy',
        language: result.language ?? '',
        audioOptions: result.audioOptions ?? [],
        request: { ...options, tmdbId, title },
      })
    }
    return result
  }

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

  /** Set by pickFromPool: on Samsung every Movy city answered with fMP4 only. */
  let tizenMovyFmp4Only = false

  const resolveMovyCities = async (): Promise<MovyPlayResult | null> => {
    type AliveCity = {
      provider: string
      decoded: NonNullable<Awaited<ReturnType<typeof fetchProviderSources>>>
      best: NonNullable<ReturnType<typeof pickMovySource>>
      started: number
      probeMs: number
      /** True when the playlist is a multi-bitrate master (true ABR ladder). */
      abrMaster: boolean
      /** movyLanguageRank of best (0 = wanted audio). */
      languageRank: number
    }

    const buildResult = (pick: AliveCity): MovyPlayResult => {
      const sub = pickEnglishSubtitle(pick.decoded.subtitles)
      const audioOptions = buildMovyAudioOptions(pick.decoded.sources, pref)
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
        language: movyAudioKey(pick.best),
        languageOk: isMovyLanguageOk(pick.best, pref),
        audioOptions: audioOptions.length >= 2 ? audioOptions : undefined,
      }
    }

    const pickFromPool = async (englishAlive: AliveCity[]): Promise<MovyPlayResult | null> => {
      if (englishAlive.length === 0) return null
      // Spoken language first: original / English audio beats a faster dub.
      const minRank = Math.min(...englishAlive.map((c) => c.languageRank))
      let pool = englishAlive.filter((c) => c.languageRank === minRank)
      // Samsung: muxed fMP4 (#EXT-X-MAP, e.g. goldenkite) buffers but never decodes
      // in Tizen MSE (readyState stays 1). Prefer TS cities when any answered.
      let tizenAllFmp4 = false
      if (isTizenTv()) {
        const fmp4 = await Promise.all(
          pool.map((c) => withTimeoutOr(isFmp4Hls(c.best.url), MOVY_DURATION_TIMEOUT_MS, false)),
        )
        const ts = pool.filter((_, i) => !fmp4[i])
        if (ts.length > 0) pool = ts
        else tizenAllFmp4 = true
      }
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
      tizenMovyFmp4Only = tizenAllFmp4
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
        // Audio menu: keep waiting until a city that lists the picked language answers.
        const satisfied = () => !pref.forced || englishAlive.some((c) => c.languageRank === 0)
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
          // Skip French-dub-only answers so Atlantic can try English.
          resolve(await pickFromPool(englishAlive))
        }

        const armEarlyPick = () => {
          if (finished || graceTimer != null || !satisfied()) return
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
            const best = pickMovySource(decoded.sources, pref)
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
            const languageRank = movyLanguageRank(best, pref)
            // A city whose best source is still another language's dub (austin
            // listing only Hindi/Tamil...) counts like paris: never auto-picked.
            const languageAcceptable =
              (pref.forced && languageRank === 0) || isMovyLanguageOk(best, pref)
            const foreignCity = isLikelyForeignDubMovyProvider(provider) && pref.original !== 'fr'
            if (
              probe.ok &&
              languageAcceptable &&
              (!foreignCity || (pref.forced && languageRank === 0))
            ) {
              englishAlive.push({
                provider,
                decoded,
                best,
                started,
                probeMs: probe.ms,
                abrMaster: Boolean(probe.abrMaster),
                languageRank,
              })
              // Two English cities: pick now (duration vote). One live city: short
              // grace so a peer can join, then pick without waiting on 500/hung cities.
              if (englishAlive.length >= 2 && satisfied()) {
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
    let pref: MovyLanguagePref
    try {
      ;[seed, pref] = await Promise.all([
        fetchMovySeed(tmdbId),
        originalLanguagePromise.then((original) => ({ original, forced: forcedAudio })),
      ])
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

  if (citiesOnly) {
    const movy = await resolveMovyCities()
    return movy ? withSession(movy) : { ok: false, error: 'No streams for this title' }
  }

  // Kick the Atlantic fallback immediately so it overlaps the Movy city lookups.
  const atlanticFallback = tryAtlanticFallback()

  if (options.preferBackend === 'atlantic') {
    const first = await atlanticFallback
    if (first) return withSession(first)
  }

  const movy = await resolveMovyCities()
  if (movy && tizenMovyFmp4Only && options.preferBackend !== 'atlantic') {
    // Samsung: Movy only had fMP4 (stalls on Tizen), so try Helios before it.
    const alt = await withTimeoutOr(atlanticFallback, MOVY_TIZEN_HELIOS_WAIT_MS, null)
    if (alt) return withSession(alt)
  }
  if (movy) return withSession(movy)

  if (options.preferBackend !== 'atlantic') {
    const alt = await atlanticFallback
    if (alt) return withSession(alt)
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

/** True when the stream's first media playlist is fMP4 (#EXT-X-MAP init segment). */
async function isFmp4Hls(url: string): Promise<boolean> {
  let res = await fetchText(url)
  if (!res.ok) return false
  if (/#EXT-X-STREAM-INF/i.test(res.text)) {
    const variant = res.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    if (!variant) return false
    res = await fetchText(new URL(variant, url).href)
    if (!res.ok) return false
  }
  return /#EXT-X-MAP/i.test(res.text)
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

export type MovyAvailability = 'ok' | 'none' | 'error'

/** Last time a Movy city answered 429 — lets checks tell "rate-limited" from "nothing". */
let movyRateLimitedAt = 0

/** True when a Movy seed / city answered 429 at or after `since` (ms epoch). */
export function movyRateLimitedSince(since: number): boolean {
  return movyRateLimitedAt >= since
}

type HlsVerdict = 'ok' | 'dead' | 'limited'

async function fetchHead(
  url: string,
  ms: number,
  firstChunkOnly = false,
): Promise<{ status: number; url: string; type: string; text: string; bytes: number }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    const type = String(res.headers.get('content-type') || '')
    if (!firstChunkOnly) {
      const text = res.ok ? await res.text() : ''
      return { status: res.status, url: res.url || url, type, text, bytes: text.length }
    }
    let bytes = 0
    let head = ''
    const reader = res.ok && res.body ? res.body.getReader() : null
    if (reader) {
      const chunk = await reader.read()
      const value = chunk.value
      if (value && value.length) {
        bytes = value.length
        head = String.fromCharCode(...Array.from(value.subarray(0, 64)))
      }
      void reader.cancel().catch(() => {})
    } else if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer())
      bytes = buf.length
      head = String.fromCharCode(...Array.from(buf.subarray(0, 64)))
    }
    ctl.abort()
    return { status: res.status, url: res.url || url, type, text: head, bytes }
  } finally {
    clearTimeout(timer)
  }
}

function firstUri(playlist: string): string {
  return (
    playlist
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || ''
  )
}

/**
 * Samsung only: load an HLS stream the way the TV player does (relay /hls for
 * Referer-locked hosts) — master, first variant, first bytes of the first
 * segment. A listed source whose CDN answers "please wait", 403s through the
 * relay or serves an HTML error page instead of media counts as dead.
 */
async function verifyTizenHlsPlayable(url: string, referer?: string): Promise<HlsVerdict> {
  try {
    const src = await tizenHlsSource(url, referer)
    let pl = await fetchHead(src, 9_000)
    if (pl.status === 429) return 'limited'
    if (!classifyMovyPlaylistBody(pl.text).ok) return 'dead'
    if (/#EXT-X-STREAM-INF/i.test(pl.text)) {
      const variant = firstUri(pl.text)
      if (!variant) return 'dead'
      pl = await fetchHead(new URL(variant, pl.url).href, 9_000)
      if (pl.status === 429) return 'limited'
      if (!classifyMovyPlaylistBody(pl.text).ok) return 'dead'
    }
    if (!/#EXTINF/i.test(pl.text)) return 'dead'
    const segment = firstUri(pl.text)
    if (!segment) return 'dead'
    const seg = await fetchHead(new URL(segment, pl.url).href, 12_000, true)
    if (seg.status === 429) return 'limited'
    if (seg.status < 200 || seg.status >= 300 || seg.bytes === 0) return 'dead'
    if (/text\/html/i.test(seg.type) || /^\s*(<|\{|please wait)/i.test(seg.text)) return 'dead'
    return 'ok'
  } catch {
    return 'dead'
  }
}

/**
 * Samsung (Tizen) shelf check: resolve S1E1 exactly like playback does
 * (resolveMovyPlay — probed, language-acceptable cities, then Atlantic) * and load the stream through the relay. Titles that only *list*
 * sources (French-dub-only cities, "please wait" CDNs, relay-blocked
 * segments) come back 'none'. Rate limits / Movy outages → 'error' (not cached).
 */
export async function checkMovyTvPlayable(opts: {
  tmdbId: string
  title: string
  season?: number
  episode?: number
  originalLanguage?: string
}): Promise<MovyAvailability> {
  const tmdbId = String(opts.tmdbId || '').trim()
  const title = String(opts.title || '').trim()
  if (!tmdbId || !title) return 'none'
  const started = Date.now()
  try {
    await fetchMovySeed(tmdbId)
  } catch {
    return 'error'
  }
  const base: MovyResolveOptions = {
    tmdbId,
    title,
    mediaType: 'tv',
    season: Math.max(1, opts.season || 1),
    episode: Math.max(1, opts.episode || 1),
    originalLanguage: opts.originalLanguage || undefined,
  }
  const tried = new Set<string>()
  let limited = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const avoid = [...tried].pop()
    const play = await withTimeoutOr(
      resolveMovyPlay(avoid ? { ...base, avoidProvider: avoid } : base).catch(() => null),
      45_000,
      null,
    )
    if (!play) return 'error'
    if (!play.ok) break
    const verdict = await verifyTizenHlsPlayable(play.url, play.referer)
    if (verdict === 'ok') return 'ok'
    if (verdict === 'limited') {
      limited = true
      break
    }
    // Dead stream: one more pass avoiding that Movy city (Atlantic
    // answers have no city to rotate away from).
    if ((play.backend ?? 'movy') !== 'movy' || !play.provider || tried.has(play.provider)) break
    tried.add(play.provider)
  }
  if (limited || movyRateLimitedAt >= started) return 'error'
  return 'none'
}

/**
 * Cheap "does any backend list this episode?" check for catalog playability.
 * Asks every Movy city for sources (no HLS probe / duration vote), then the
 * Atlantic fallback. Returns 'error' when Movy itself is unreachable
 * (seed failed) so a blocked network never marks a title dead.
 */
export async function checkMovyTvAvailability(opts: {
  tmdbId: string
  title: string
  season?: number
  episode?: number
}): Promise<MovyAvailability> {
  const tmdbId = String(opts.tmdbId || '').trim()
  const title = String(opts.title || '').trim()
  if (!tmdbId || !title) return 'none'
  const resolveOpts: MovyResolveOptions = {
    tmdbId,
    title,
    mediaType: 'tv',
    season: Math.max(1, opts.season || 1),
    episode: Math.max(1, opts.episode || 1),
  }
  let seed: string
  try {
    seed = await fetchMovySeed(tmdbId)
  } catch {
    return 'error'
  }
  const anyCity = await new Promise<boolean>((resolve) => {
    let pending = MOVY_TV_PROVIDERS.length
    let done = false
    for (const provider of MOVY_TV_PROVIDERS) {
      void withTimeoutOr(fetchProviderSources(provider, resolveOpts, seed), MOVY_SOURCES_TIMEOUT_MS, null)
        .catch(() => null)
        .then((decoded) => {
          if (done) return
          if (decoded?.sources.some((s) => s.url)) {
            done = true
            resolve(true)
            return
          }
          pending -= 1
          if (pending <= 0) resolve(false)
        })
    }
  })
  if (anyCity) return 'ok'
  const atlantic = await withTimeoutOr(
    resolveAtlanticPlay({ tmdbId, mediaType: 'tv', season: resolveOpts.season, episode: resolveOpts.episode, title }).catch(() => null),
    12_000,
    null,
  )
  return atlantic?.ok ? 'ok' : 'none'
}
