import type { CategoryId } from '../types'

const KEY = 'jiyu.watch-history.v1'
const MAX_ENTRIES = 48
/** Ignore tiny accidental opens. */
const MIN_SECONDS = 30
const COMPLETE_RATIO = 0.95

export const WATCH_HISTORY_EVENT = 'jiyu:watch-history'

export type VodCategoryId = 'movies' | 'series' | 'anime' | 'kids'
export type WatchHistoryFilter = 'all' | VodCategoryId

export interface WatchHistoryEntry {
  id: string
  title: string
  poster?: string
  category: CategoryId
  playlistIndex: number
  episodeTitle?: string
  /** Last known playhead (seconds). */
  currentTime: number
  duration: number
  runtimeSeconds?: number
  finished: boolean
  updatedAt: number
  torrentUri?: string
  detailUrl?: string
  playUrl?: string
  source?: string
}

export const WATCH_HISTORY_FILTERS: WatchHistoryFilter[] = [
  'all',
  'movies',
  'series',
  'anime',
  'kids',
]

function isVodCategory(category: CategoryId | undefined): category is VodCategoryId {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
}

function isFinished(playhead: number, duration: number): boolean {
  if (!Number.isFinite(playhead) || playhead < 0) return false
  if (!Number.isFinite(duration) || duration < 60) return false
  return playhead / duration >= COMPLETE_RATIO
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function categoryLabel(category: CategoryId): string {
  if (category === 'movies') return 'Movie'
  if (category === 'series') return 'Series'
  if (category === 'anime') return 'Anime'
  return category
}

function readAll(): WatchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as WatchHistoryEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.title === 'string' &&
          isVodCategory(entry.category) &&
          typeof entry.updatedAt === 'number',
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function writeAll(entries: WatchHistoryEntry[]) {
  const unique = new Map<string, WatchHistoryEntry>()
  for (const entry of entries.sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry)
  }
  const sliced = [...unique.values()].slice(0, MAX_ENTRIES)
  const next = JSON.stringify(sliced)
  let membershipChanged = true
  try {
    const prevRaw = localStorage.getItem(KEY)
    if (prevRaw) {
      const prev = JSON.parse(prevRaw) as WatchHistoryEntry[]
      const prevIds = prev.map((e) => `${e.id}:${e.finished}`).join('\0')
      const nextIds = sliced.map((e) => `${e.id}:${e.finished}`).join('\0')
      membershipChanged = prevIds !== nextIds
    }
  } catch {
    membershipChanged = true
  }
  localStorage.setItem(KEY, next)
  if (membershipChanged) {
    window.dispatchEvent(new CustomEvent(WATCH_HISTORY_EVENT))
  }
}

export function listWatchHistory(filter: WatchHistoryFilter = 'all'): WatchHistoryEntry[] {
  const all = readAll()
  if (filter === 'all') return all
  return all.filter((entry) => entry.category === filter)
}

export function removeWatchHistoryEntry(id: string) {
  writeAll(readAll().filter((entry) => entry.id !== id))
}

export function clearWatchHistory() {
  writeAll([])
}

export interface WatchHistoryInput {
  id: string
  title: string
  poster?: string
  category: CategoryId
  playlistIndex?: number
  episodeTitle?: string
  currentTime: number
  duration?: number
  runtimeSeconds?: number
  finished?: boolean
  torrentUri?: string
  detailUrl?: string
  playUrl?: string
  source?: string
}

/**
 * Upsert a history row. Finished titles stay after they drop off Continue watching.
 */
export function recordWatchHistory(entry: WatchHistoryInput) {
  if (!isVodCategory(entry.category)) return
  const playhead = Math.max(0, Number(entry.currentTime) || 0)
  const duration = Math.max(0, Number(entry.duration) || Number(entry.runtimeSeconds) || 0)
  const finished = entry.finished === true || isFinished(playhead, duration)

  if (!finished && playhead < MIN_SECONDS) return

  const existing = readAll().find((item) => item.id === entry.id)
  const next: WatchHistoryEntry = {
    id: entry.id,
    title: entry.title,
    poster: entry.poster || existing?.poster,
    category: entry.category,
    playlistIndex: entry.playlistIndex ?? existing?.playlistIndex ?? 0,
    episodeTitle: entry.episodeTitle ?? existing?.episodeTitle,
    currentTime: finished ? Math.max(playhead, existing?.currentTime || 0) : playhead,
    duration: duration || existing?.duration || 0,
    runtimeSeconds: entry.runtimeSeconds || existing?.runtimeSeconds,
    finished: finished || Boolean(existing?.finished),
    updatedAt: Date.now(),
    torrentUri: entry.torrentUri || existing?.torrentUri,
    detailUrl: entry.detailUrl || existing?.detailUrl,
    playUrl: entry.playUrl || existing?.playUrl,
    source: entry.source || existing?.source,
  }

  const others = readAll().filter((item) => item.id !== next.id)
  writeAll([next, ...others])
}

function relativeDay(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`
  if (diff < 86400_000) return `${Math.max(1, Math.round(diff / 3600_000))}h ago`
  if (diff < 86400_000 * 7) return `${Math.max(1, Math.round(diff / 86400_000))}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatHistoryLabel(entry: WatchHistoryEntry): string {
  const parts: string[] = [categoryLabel(entry.category)]
  if (entry.category !== 'movies') {
    if (entry.episodeTitle) parts.push(entry.episodeTitle)
    else if (entry.playlistIndex > 0) parts.push(`Episode ${entry.playlistIndex + 1}`)
  }
  if (entry.finished) parts.push('Finished')
  else if (entry.currentTime > 0) parts.push(`Stopped at ${formatClock(entry.currentTime)}`)
  parts.push(relativeDay(entry.updatedAt))
  return parts.join(' · ')
}

export function watchHistoryFilterLabel(filter: WatchHistoryFilter): string {
  if (filter === 'all') return 'All'
  if (filter === 'movies') return 'Movies'
  if (filter === 'series') return 'Series'
  if (filter === 'anime') return 'Anime'
  if (filter === 'kids') return 'Kids'
  return 'All'
}
