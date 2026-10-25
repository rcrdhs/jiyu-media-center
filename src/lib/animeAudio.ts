/**
 * Anime Sub / Dub preference + English-dub lookup.
 *
 * - Preference: a global default (Settings) plus a per-show override (player picker).
 *   Stored in localStorage, so each device keeps its own choice.
 * - Dub source: M2Box (aoneroom) lists language variants of a show on its detail page
 *   (`dubs`: "Original Audio" ja, "English dub" en, …). Each variant is its own subject
 *   id that plays through the normal M2Box play API with the same season/episode numbers.
 * - Lookup cost: search page + detail page (~0.3–0.6 s each), once per show, then cached
 *   (7 days found / 1 day not found). Sub users run it in the background after playback
 *   starts; only Dub users wait for it, and only the first time per show.
 */

import {
  type M2BoxSeasonInfo,
  m2boxDetailUrl,
  parseM2BoxSeasonsFromHtml,
  reviveNuxtPayload,
} from './m2box'
import { nativeFetchText } from './nativeHttp'

export type AnimeAudioMode = 'sub' | 'dub'

const GLOBAL_KEY = 'jiyu.animeAudio.default'
const SHOW_KEY_PREFIX = 'jiyu.animeAudio.show:'
const DUB_CACHE_PREFIX = 'jiyu.animeDub.v1:'
const DUB_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DUB_MISSING_TTL_MS = 24 * 60 * 60 * 1000
const M2BOX_WEB_ORIGIN = 'https://m2box.org'
export const ANIME_AUDIO_CHANGED_EVENT = 'jiyu:anime-audio-changed'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Stable per-show key: lowercase title without season / bracket noise. */
export function animeShowKey(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:season|s)\s*\d+(?:\s*-\s*s?\d+)?\b/g, ' ')
    .replace(/\b(?:english|dub(?:bed)?|sub(?:bed)?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function getGlobalAnimeAudioMode(): AnimeAudioMode {
  return storage()?.getItem(GLOBAL_KEY) === 'dub' ? 'dub' : 'sub'
}

export function setGlobalAnimeAudioMode(mode: AnimeAudioMode): void {
  storage()?.setItem(GLOBAL_KEY, mode)
  try {
    window.dispatchEvent(new CustomEvent(ANIME_AUDIO_CHANGED_EVENT))
  } catch {
    /* ignore */
  }
}

/** Per-show override, or null when the show follows the global default. */
export function getShowAnimeAudioMode(title: string): AnimeAudioMode | null {
  const key = animeShowKey(title)
  if (!key) return null
  const v = storage()?.getItem(SHOW_KEY_PREFIX + key)
  return v === 'dub' || v === 'sub' ? v : null
}

export function setShowAnimeAudioMode(title: string, mode: AnimeAudioMode): void {
  const key = animeShowKey(title)
  if (!key) return
  storage()?.setItem(SHOW_KEY_PREFIX + key, mode)
}

export function effectiveAnimeAudioMode(title: string): AnimeAudioMode {
  return getShowAnimeAudioMode(title) ?? getGlobalAnimeAudioMode()
}

/** Torrent release / file name that carries both Japanese and English audio. */
export function isDualAudioReleaseName(name: string): boolean {
  const t = String(name || '')
  if (/\b(?:dual|multi)[\s._-]?audio\b/i.test(t)) return true
  return (
    /\b(?:jpn?|jap|japanese)[\s._]*[+&/,][\s._]*(?:eng?|english)\b/i.test(t) ||
    /\b(?:eng?|english)[\s._]*[+&/,][\s._]*(?:jpn?|jap|japanese)\b/i.test(t)
  )
}

export type AnimeDubVariant = { subjectId: string; slug: string }

export type AnimeDubInfo = {
  /** English dub subject. */
  dub: AnimeDubVariant
  /** Original-audio subject (Japanese for anime), when M2Box lists one. */
  original?: AnimeDubVariant
  seasons: M2BoxSeasonInfo[]
}

type CacheRow = { at: number; info: AnimeDubInfo | null }

function readCache(key: string): CacheRow | undefined {
  try {
    const raw = storage()?.getItem(DUB_CACHE_PREFIX + key)
    if (!raw) return undefined
    const row = JSON.parse(raw) as CacheRow
    const ttl = row.info ? DUB_FOUND_TTL_MS : DUB_MISSING_TTL_MS
    if (!row || typeof row.at !== 'number' || Date.now() - row.at > ttl) return undefined
    return row
  } catch {
    return undefined
  }
}

function writeCache(key: string, info: AnimeDubInfo | null): void {
  try {
    storage()?.setItem(DUB_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), info }))
  } catch {
    /* quota — skip */
  }
}

/** Cached result only (no network). `undefined` = never looked up / expired. */
export function cachedAnimeDub(title: string): AnimeDubInfo | null | undefined {
  const key = animeShowKey(title)
  if (!key) return null
  const row = readCache(key)
  return row ? row.info : undefined
}

type NuxtSubject = {
  subjectId?: unknown
  title?: unknown
  detailPath?: unknown
  dubs?: unknown
}

type NuxtDub = {
  subjectId?: unknown
  lanName?: unknown
  lanCode?: unknown
  original?: unknown
  detailPath?: unknown
}

function nuxtSubjects(html: string): NuxtSubject[] {
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return []
  let revived: unknown[]
  try {
    revived = reviveNuxtPayload(m[1]!)
  } catch {
    return []
  }
  const seen = new Set<object>()
  const hits: NuxtSubject[] = []
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 14) return
    seen.add(o)
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1)
      return
    }
    const rec = o as Record<string, unknown>
    if (rec.subjectId && typeof rec.title === 'string') hits.push(rec as NuxtSubject)
    for (const v of Object.values(rec)) walk(v, depth + 1)
  }
  walk(revived, 0)
  return hits
}

function variant(d: NuxtDub | undefined): AnimeDubVariant | undefined {
  if (!d) return undefined
  const subjectId = String(d.subjectId ?? '').trim()
  const slug = String(d.detailPath ?? '').trim()
  if (!/^\d{6,}$/.test(subjectId) || !slug) return undefined
  return { subjectId, slug }
}

async function fetchPage(url: string): Promise<string> {
  const res = await nativeFetchText(url, { quiet: true })
  return res.ok ? res.content || '' : ''
}

const inflight = new Map<string, Promise<AnimeDubInfo | null>>()

/**
 * Find an English dub for an anime title on M2Box (cached). Never throws.
 * Returns null when no English dub is listed.
 */
export function findAnimeEnglishDub(title: string): Promise<AnimeDubInfo | null> {
  const key = animeShowKey(title)
  if (!key) return Promise.resolve(null)
  const cached = readCache(key)
  if (cached) return Promise.resolve(cached.info)
  const running = inflight.get(key)
  if (running) return running
  const job = (async (): Promise<AnimeDubInfo | null> => {
    try {
      const searchHtml = await fetchPage(
        `${M2BOX_WEB_ORIGIN}/web/searchResult?keyword=${encodeURIComponent(
          String(title).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
        )}`,
      )
      if (!searchHtml) return null // network miss — don't cache, try again next time
      // Same show only: compare titles with "[English]", "S1-S3" etc. stripped.
      const matches = nuxtSubjects(searchHtml).filter(
        (s) => typeof s.detailPath === 'string' && animeShowKey(String(s.title)) === key,
      )
      // Original-language entry first (its detail lists every variant).
      matches.sort(
        (a, b) =>
          Number(/\[english\]/i.test(String(a.title))) -
          Number(/\[english\]/i.test(String(b.title))),
      )
      const pick = matches[0]
      if (!pick) {
        writeCache(key, null)
        return null
      }
      const detailHtml = await fetchPage(m2boxDetailUrl(M2BOX_WEB_ORIGIN, String(pick.detailPath)))
      if (!detailHtml) return null
      const withDubs = nuxtSubjects(detailHtml).find(
        (s) => Array.isArray(s.dubs) && (s.dubs as unknown[]).length > 0,
      )
      const dubs = (withDubs?.dubs as NuxtDub[] | undefined) || []
      const english = dubs.find(
        (d) => String(d.lanCode).toLowerCase() === 'en' && /dub/i.test(String(d.lanName)),
      )
      const original = dubs.find((d) => d.original === true)
      const dub = variant(english)
      if (!dub) {
        writeCache(key, null)
        return null
      }
      let seasons: M2BoxSeasonInfo[] = []
      try {
        seasons = parseM2BoxSeasonsFromHtml(detailHtml).seasons
      } catch {
        seasons = []
      }
      const info: AnimeDubInfo = { dub, original: variant(original), seasons }
      writeCache(key, info)
      return info
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, job)
  return job
}

/** M2Box lists this season/episode (unknown season list → assume yes). */
export function animeDubHasEpisode(info: AnimeDubInfo, season: number, episode: number): boolean {
  if (!info.seasons.length) return true
  const row = info.seasons.find((s) => s.season === season)
  if (!row) return false
  return !row.maxEpisode || episode <= row.maxEpisode
}

/** Detail URL resolveM2BoxPlay accepts for a variant. */
export function animeDubDetailUrl(v: AnimeDubVariant): string {
  return m2boxDetailUrl(M2BOX_WEB_ORIGIN, v.slug)
}

/** Remux URL with the audio preference flipped (desktop + Android remuxers read it). */
export function remuxUrlWithAudio(url: string, mode: AnimeAudioMode): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('anime')
    parsed.searchParams.delete('audio')
    parsed.searchParams.delete('t')
    parsed.searchParams.delete('exact')
    parsed.searchParams.delete('r')
    if (mode === 'dub') parsed.searchParams.set('audio', 'en')
    else parsed.searchParams.set('anime', '1')
    return parsed.toString()
  } catch {
    return url
  }
}

/** Remux URL does not ask for Japanese audio (so the remuxer picks English when present). */
export function remuxUrlIsDub(url: string): boolean {
  try {
    const parsed = new URL(url)
    const audio = (parsed.searchParams.get('audio') || '').toLowerCase()
    return parsed.searchParams.get('anime') !== '1' && audio !== 'ja' && audio !== 'jpn'
  } catch {
    return false
  }
}

/** M2Box row that is itself the English dub ("Title [English]"). */
export function isAnimeDubRowTitle(title: string | undefined): boolean {
  return /\[english\]/i.test(String(title || ''))
}

export type AnimeAudioPick = {
  mode: AnimeAudioMode
  detailUrl: string
  subjectId: string
  info: AnimeDubInfo
}

/**
 * Opening an anime episode: the M2Box subject that matches the user's Sub / Dub choice
 * when it differs from what the source would play anyway, else null (play as usual).
 * Costs nothing when the preference already matches; otherwise one cached lookup.
 */
export async function pickAnimeAudioSubject(opts: {
  title: string
  season: number
  episode: number
  /** The row is an M2Box subject (can switch to the original too). */
  m2boxRow: boolean
  /** Dub row title ("… [English]"). */
  dubRow?: boolean
  /** Highest local episode number in this season (guards merged M2Box seasons). */
  localMaxEpisode?: number
  timeoutMs?: number
}): Promise<AnimeAudioPick | null> {
  const current: AnimeAudioMode = opts.dubRow ? 'dub' : 'sub'
  const want: AnimeAudioMode = opts.dubRow
    ? getShowAnimeAudioMode(opts.title) ?? 'dub'
    : effectiveAnimeAudioMode(opts.title)
  if (want === current) return null
  if (want === 'sub' && !opts.m2boxRow) return null
  let timer = 0
  const info = await Promise.race([
    findAnimeEnglishDub(opts.title),
    new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), opts.timeoutMs ?? 10_000)
    }),
  ]).finally(() => window.clearTimeout(timer))
  if (!info || !animeDubHasEpisode(info, opts.season, opts.episode)) return null
  if (opts.localMaxEpisode) {
    const m2Max = info.seasons.find((s) => s.season === opts.season)?.maxEpisode || 0
    if (m2Max && m2Max > opts.localMaxEpisode + 2) return null
  }
  const v = want === 'dub' ? info.dub : info.original
  if (!v) return null
  return { mode: want, detailUrl: animeDubDetailUrl(v), subjectId: v.subjectId, info }
}
