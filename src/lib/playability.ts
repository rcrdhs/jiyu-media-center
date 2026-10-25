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
 */
import { checkMovyTvAvailability } from './movy'
import { rivestreamTmdbIdFromItem } from './rivestream'
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
/** Leave Movy alone while the user is opening something to watch. */
const PLAYBACK_QUIET_MS = 90 * 1000
const MAX_ENTRIES = 20_000

export const PLAYABILITY_CHANGED = 'jiyu:playability-changed'

type Entry = { ok: boolean; at: number }

let cache: Record<string, Entry> | null = null
const queue: Array<{ key: string; tmdbId: string; title: string }> = []
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

/** Cache key for rows whose only play path is Movy/Atlantic/Streamo; null = not checked. */
export function playabilityKey(item: StreamItem): string | null {
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

/** True only when a recent check found no source for this title. */
export function isKnownUnplayable(item: StreamItem): boolean {
  const key = playabilityKey(item)
  if (!key) return false
  const entry = load()[key]
  return fresh(entry) && !entry.ok
}

export function filterKnownPlayable(items: StreamItem[]): StreamItem[] {
  const data = load()
  if (Object.keys(data).length === 0) return items
  const now = Date.now()
  return items.filter((item) => {
    const key = playabilityKey(item)
    if (!key) return true
    const entry = data[key]
    return !(fresh(entry, now) && !entry.ok)
  })
}

/** Record a real playback result (Movy played S1E1, etc.). */
export function notePlayable(item: StreamItem) {
  const key = playabilityKey(item)
  if (!key) return
  const data = load()
  const was = data[key]
  data[key] = { ok: true, at: Date.now() }
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
  let added = 0
  for (const item of items) {
    if (added >= limit) break
    const key = playabilityKey(item)
    if (!key || queued.has(key) || fresh(data[key], now)) continue
    const title = cleanShowDisplayTitle(item.title) || item.title
    if (!title) continue
    queued.add(key)
    queue.push({ key, tmdbId: rivestreamTmdbIdFromItem(item), title })
    added += 1
  }
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
      let verdict: Awaited<ReturnType<typeof checkMovyTvAvailability>>
      try {
        verdict = await checkMovyTvAvailability({ tmdbId: job.tmdbId, title: job.title })
      } catch {
        verdict = 'error'
      }
      if (verdict === 'error') {
        // Seed blocked / rate-limited — never cache, retry this job later.
        pausedUntil = Date.now() + ERROR_BACKOFF_MS
        continue
      }
      queue.shift()
      queued.delete(job.key)
      const data = load()
      const prev = data[job.key]
      data[job.key] = { ok: verdict === 'ok', at: Date.now() }
      save()
      if (!prev || prev.ok !== (verdict === 'ok')) emitChanged()
      await sleep(CHECK_GAP_MS)
    }
  } finally {
    running = false
  }
}