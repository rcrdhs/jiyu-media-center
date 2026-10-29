/**
 * Playability cache for TMDB-routed catalog rows (TMDB Kids / Series, Zenox
 * kids + adult animation). Those rows only play through Movy (+ Atlantic /
 * Streamo), so a synced title with no listed sources just says "Could not find
 * a stream". We check S1E1 once in the background, cache the answer, and hide
 * titles that have nothing so Added today and the Kids/Series shelves only
 * show titles that can play.
 *
 * Cost: 1 seed + up to 11 city lookups (+ Atlantic/Streamo only when every
 * city is empty) per title, once per OK_TTL / DEAD_TTL. Movy rate-limits the
 * seed endpoint, so the queue runs one check at a time, spaced out, and backs
 * off (without caching anything) whenever Movy can't be reached.
 *
 * Samsung TV is stricter (checkMovyTvPlayable): it resolves S1E1 the way
 * playback does and loads the master, first variant and first segment through
 * the relay, so titles that only *list* sources (dub-only cities, "please
 * wait" CDNs, relay-blocked segments) stay hidden. Those answers carry v: 2;
 * older "ok" entries stay visible but are re-checked first.
 */
import { checkMovyTvAvailability, checkMovyTvPlayable } from './movy'
import { resolveAnimeTmdbTvId, rivestreamTmdbIdFromItem } from './rivestream'
import { isTizenTv } from './tvMode'
import { isTmdbTvCatalogItem } from './tmdbTv'
import { cleanShowDisplayTitle } from './torrents'
import type { StreamItem } from '../types'

const STORAGE_KEY = 'jiyu.playability.v1'
const OK_TTL_MS = 14 * 24 * 60 * 60 * 1000
const DEAD_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** Gap between checks — keeps us well under Movy's seed rate limit. */
const CHECK_GAP_MS = 4_000
/** Movy unreachable / rate-limited: wait before trying again. */
const ERROR_BACKOFF_MS = 10 * 60 * 1000
const TIZEN_ERROR_BACKOFF_MS = 2 * 60 * 1000
/** Leave Movy alone while the user is opening something to watch. */
const PLAYBACK_QUIET_MS = 90 * 1000
const MAX_ENTRIES = 20_000

export const PLAYABILITY_CHANGED = 'jiyu:playability-changed'

/** v: 2 = Samsung real-playback check (or a real Samsung playback). */
type Entry = { ok: boolean; at: number; v?: number }

const TIZEN_VERIFIED = 2
/** A job that keeps erroring (timeouts) goes to the back of the queue after this many tries. */
const MAX_JOB_ERRORS = 3

let cache: Record<string, Entry> | null = null
const queue: Array<{
  key: string
  tmdbId: string
  title: string
  anime?: boolean
  originalLanguage?: string
  errors?: number
}> = []
const queued = new Set<string>()
let running = false
let pausedUntil = 0
let changedTimer: ReturnType<typeof setTimeout> | null = null

function load(): Record<string, Entry> {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, Entry>) : {}
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    cache = {}
  }
  return cache
}

function save() {
  const data = load()
  const keys = Object.keys(data)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (data[a]?.at ?? 0) - (data[b]?.at ?? 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete data[k])
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* storage full / unavailable */
  }
}

function emitChanged() {
  if (changedTimer != null) return
  changedTimer = setTimeout(() => {
    changedTimer = null
    window.dispatchEvent(new CustomEvent(PLAYABILITY_CHANGED))
  }, 1_500)
}

/**
 * Samsung TV has no torrent engine, so SubsPlease / Nyaa anime rows only play
 * through Movy (then Bilibili) after an AniList/TMDB title match. Those rows are
 * hidden on Tizen until a check confirms Movy has the show — desktop / Android
 * never get this key, so their shelves are unchanged.
 */
function isTizenTorrentAnime(item: StreamItem): boolean {
  if (item.category !== 'anime') return false
  if (!isTizenTv()) return false
  if (item.transport === 'torrent' || item.sourceKind === 'torrent') return true
  return /^magnet:/i.test(String(item.torrentUri || item.url || ''))
}

function animeTitleKey(item: StreamItem): string {
  const title = (cleanShowDisplayTitle(item.title) || item.title || '').toLowerCase()
  return title.replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Cache key for rows whose only play path is Movy/Atlantic/Streamo; null = not checked. */
export function playabilityKey(item: StreamItem): string | null {
  if (isTizenTorrentAnime(item)) {
    const t = animeTitleKey(item)
    return t ? `anime:${t}` : null
  }
  // Anime also tries Bilibili + Nyaa, so a Movy miss doesn't mean unplayable.
  if (item.category !== 'kids' && item.category !== 'series') return null
  if (!isTmdbTvCatalogItem(item)) return null
  const tmdbId = rivestreamTmdbIdFromItem(item)
  if (!tmdbId) return null
  return `tv:${tmdbId}`
}

function fresh(entry: Entry | undefined, now = Date.now()): entry is Entry {
  if (!entry) return false
  return now - entry.at < (entry.ok ? OK_TTL_MS : DEAD_TTL_MS)
}

/** Needs a (re)check: no fresh answer, or (Samsung) an "ok" from the old list-only check. */
function needsCheck(entry: Entry | undefined, tizen: boolean, now = Date.now()): boolean {
  if (!fresh(entry, now)) return true
  return tizen && entry.ok && entry.v !== TIZEN_VERIFIED
}

/** True only when a recent check found no source for this title. */
export function isKnownUnplayable(item: StreamItem): boolean {
  const key = playabilityKey(item)
  if (!key) return false
  const entry = load()[key]
  return fresh(entry) && !entry.ok
}

export function filterKnownPlayable(items: StreamItem[]): StreamItem[] {
  const data = load()
  const tizen = isTizenTv()
  if (!tizen && Object.keys(data).length === 0) return items
  const now = Date.now()
  return items.filter((item) => {
    const key = playabilityKey(item)
    if (!key) return true
    const entry = data[key]
    // Tizen torrent anime: show only once a check found a non-torrent stream.
    if (key.startsWith('anime:')) return fresh(entry, now) && entry.ok
    return !(fresh(entry, now) && !entry.ok)
  })
}

/** Record a real playback result (Movy played S1E1, etc.). */
export function notePlayable(item: StreamItem) {
  const key = playabilityKey(item)
  if (!key) return
  const data = load()
  const was = data[key]
  data[key] = isTizenTv() ? { ok: true, at: Date.now(), v: TIZEN_VERIFIED } : { ok: true, at: Date.now() }
  save()
  if (was && !was.ok) emitChanged()
}

/** Call when the user starts opening a title so checks don't compete with it. */
export function notePlaybackActivity() {
  pausedUntil = Math.max(pausedUntil, Date.now() + PLAYBACK_QUIET_MS)
}

/** Queue background checks for titles that have no fresh answer yet. */
export function queuePlayabilityChecks(items: StreamItem[], limit = 400) {
  const data = load()
  const now = Date.now()
  const tizen = isTizenTv()
  let added = 0
  const recheck: typeof queue = []
  for (const item of items) {
    if (added >= limit) break
    const key = playabilityKey(item)
    if (!key || queued.has(key) || !needsCheck(data[key], tizen, now)) continue
    const title = cleanShowDisplayTitle(item.title) || item.title
    if (!title) continue
    queued.add(key)
    const job = {
      key,
      tmdbId: rivestreamTmdbIdFromItem(item),
      title,
      anime: key.startsWith('anime:'),
      originalLanguage: item.originalLanguage,
    }
    // Samsung: shown-but-unverified titles first (they may be the ones that won't play).
    if (tizen && fresh(data[key], now)) recheck.push(job)
    else queue.push(job)
    added += 1
  }
  if (recheck.length) queue.unshift(...recheck)
  if (added > 0) void drain()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function drain() {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const wait = pausedUntil - Date.now()
      if (wait > 0) {
        await sleep(Math.min(wait, 60_000))
        continue
      }
      const job = queue[0]!
      const tizen = isTizenTv()
      let verdict: Awaited<ReturnType<typeof checkMovyTvAvailability>>
      try {
        let tmdbId = job.tmdbId
        if (job.anime) {
          // AniList/TMDB match; null = no TMDB show → nothing non-torrent can play it.
          tmdbId = (await resolveAnimeTmdbTvId(job.title, tmdbId || null)) || ''
        }
        verdict = !tmdbId
          ? 'none'
          : tizen
            ? await checkMovyTvPlayable({
                tmdbId,
                title: job.title,
                originalLanguage: job.originalLanguage || (job.anime ? 'ja' : undefined),
              })
            : await checkMovyTvAvailability({ tmdbId, title: job.title })
      } catch {
        verdict = 'error'
      }
      if (verdict === 'error') {
        // Seed blocked / rate-limited — never cache, retry this job later.
        // Samsung goes through the shared Cloudflare relay, whose egress IPs Movy
        // rate-limits per minute: retry sooner there instead of idling 10 min.
        pausedUntil = Date.now() + (tizen ? TIZEN_ERROR_BACKOFF_MS : ERROR_BACKOFF_MS)
        job.errors = (job.errors ?? 0) + 1
        // One title that always times out must not block the rest of the queue.
        if (job.errors >= MAX_JOB_ERRORS && queue.length > 1) {
          queue.shift()
          job.errors = 0
          queue.push(job)
        }
        continue
      }
      queue.shift()
      queued.delete(job.key)
      const data = load()
      const prev = data[job.key]
      data[job.key] = tizen
        ? { ok: verdict === 'ok', at: Date.now(), v: TIZEN_VERIFIED }
        : { ok: verdict === 'ok', at: Date.now() }
      save()
      if (!prev || prev.ok !== (verdict === 'ok')) emitChanged()
      await sleep(CHECK_GAP_MS)
    }
  } finally {
    running = false
  }
}