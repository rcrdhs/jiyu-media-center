import type { CategoryId, StreamItem, StreamSourceKind, StreamTransport } from '../types'

const KEY = 'jiyu.continue.v1'
/** Max resume titles kept per VOD shelf — movies / series / anime never evict each other. */
const MAX_PER_CATEGORY = 8
/** Save after a short watch so resume appears without a long wait. */
const MIN_SECONDS = 5
/** Watched this much of the title → treat as finished (no Continue watching). */
export const COMPLETE_RATIO = 0.95
export const FORCE_SAVE_CONTINUE_EVENT = 'jiyu:force-save-continue'

/** Titles that support Continue watching / mid-playback resume. */
export const VOD_CATEGORIES = ['movies', 'series', 'anime'] as const
export type VodCategoryId = (typeof VOD_CATEGORIES)[number]

export function isVodCategory(category: CategoryId | undefined): category is VodCategoryId {
  return category === 'movies' || category === 'series' || category === 'anime'
}

export interface ContinueWatchingEntry {
  id: string
  title: string
  poster?: string
  category: CategoryId
  playlistIndex: number
  episodeTitle?: string
  currentTime: number
  /** 0 when the player has not reported a real duration yet (common for torrent remux). */
  duration: number
  updatedAt: number
  /** Snapshot so resume works for torrent-only plays and missing catalog rows. */
  torrentUri?: string
  detailUrl?: string
  playUrl?: string
  transport?: StreamTransport
  sourceKind?: StreamSourceKind
  source?: string
}

export const CONTINUE_WATCHING_EVENT = 'jiyu:continue-watching'

const CATEGORY_LABEL: Record<VodCategoryId, string> = {
  movies: 'Movie',
  series: 'Series',
  anime: 'Anime',
}

export function vodCategoryLabel(category: CategoryId): string {
  return isVodCategory(category) ? CATEGORY_LABEL[category] : category
}

function readAll(): ContinueWatchingEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ContinueWatchingEntry[]
    if (!Array.isArray(parsed)) return []
    return trimPerCategory(
      parsed.filter(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.title === 'string' &&
          typeof entry.currentTime === 'number' &&
          typeof entry.duration === 'number' &&
          isVodCategory(entry.category) &&
          !isEpisodeComplete(entry.currentTime, entry.duration),
      ),
    )
  } catch {
    return []
  }
}

/** Keep up to MAX_PER_CATEGORY per shelf so anime resumes are never replaced by movies, etc. */
function trimPerCategory(entries: ContinueWatchingEntry[]): ContinueWatchingEntry[] {
  const buckets: Record<VodCategoryId, ContinueWatchingEntry[]> = {
    movies: [],
    series: [],
    anime: [],
  }
  for (const entry of entries) {
    if (!isVodCategory(entry.category)) continue
    buckets[entry.category].push(entry)
  }
  const merged: ContinueWatchingEntry[] = []
  for (const category of VOD_CATEGORIES) {
    const unique = new Map<string, ContinueWatchingEntry>()
    for (const entry of buckets[category].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!unique.has(entry.id)) unique.set(entry.id, entry)
    }
    merged.push(...[...unique.values()].slice(0, MAX_PER_CATEGORY))
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt)
}

function writeAll(entries: ContinueWatchingEntry[]) {
  const sliced = trimPerCategory(entries)
  const next = JSON.stringify(sliced)
  let membershipChanged = true
  try {
    const prevRaw = localStorage.getItem(KEY)
    if (prevRaw) {
      const prev = JSON.parse(prevRaw) as ContinueWatchingEntry[]
      const prevIds = prev.map((entry) => `${entry.category}:${entry.id}`).join('\0')
      const nextIds = sliced.map((entry) => `${entry.category}:${entry.id}`).join('\0')
      membershipChanged = prevIds !== nextIds
    }
  } catch {
    membershipChanged = true
  }
  localStorage.setItem(KEY, next)
  // Avoid re-rendering Continue watching on every progress tick (causes poster flicker).
  if (membershipChanged) {
    window.dispatchEvent(new CustomEvent(CONTINUE_WATCHING_EVENT))
  }
}

export function listContinueWatching(category?: CategoryId): ContinueWatchingEntry[] {
  const all = readAll()
  if (!category) return all
  return all.filter((entry) => entry.category === category)
}

export function getContinueEntry(id: string): ContinueWatchingEntry | null {
  return readAll().find((entry) => entry.id === id) ?? null
}

export function removeContinueEntry(id: string) {
  writeAll(readAll().filter((entry) => entry.id !== id))
}

export function clearContinueWatching() {
  localStorage.removeItem(KEY)
  window.dispatchEvent(new CustomEvent(CONTINUE_WATCHING_EVENT))
}

/** Rebuild a playable catalog-shaped item from a continue row (movies / series / anime). */
export function streamItemFromContinueEntry(entry: ContinueWatchingEntry): StreamItem {
  const transport =
    entry.transport ||
    (entry.torrentUri || entry.sourceKind === 'torrent' ? 'torrent' : 'direct')
  return {
    id: entry.id,
    title: entry.title,
    description: entry.episodeTitle || '',
    category: entry.category,
    poster: entry.poster,
    url: entry.playUrl || entry.detailUrl || entry.torrentUri || '',
    torrentUri: entry.torrentUri,
    detailUrl: entry.detailUrl || entry.playUrl,
    transport,
    sourceKind: entry.sourceKind || (transport === 'torrent' ? 'torrent' : undefined),
    source: entry.source,
  }
}

/** Minimum duration we trust as a real title length (not progressive-remux buffer length). */
const TRUSTED_DURATION_SECONDS = 5 * 60

/** True for local torrent/remux URLs that often omit or misreport duration. */
export function isLocalPlaybackUrl(url: string | undefined): boolean {
  return Boolean(
    url && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url),
  )
}

function isTrustedDuration(duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration !== Infinity &&
    duration >= TRUSTED_DURATION_SECONDS
  )
}

/**
 * True when the viewer has reached at least 95% of a known full duration.
 * Requires a trusted length so progressive remux buffer sizes don’t count as “done”.
 */
export function isEpisodeComplete(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || currentTime < MIN_SECONDS) return false
  if (!isTrustedDuration(duration)) return false
  return currentTime / duration >= COMPLETE_RATIO
}

export function shouldTrackProgress(
  duration: number,
  currentTime: number,
  options?: { allowUnknownDuration?: boolean },
): boolean {
  if (!Number.isFinite(currentTime) || currentTime < MIN_SECONDS) return false
  if (isEpisodeComplete(currentTime, duration)) return false

  const durationUnknown =
    !Number.isFinite(duration) || duration === Infinity || duration <= 0

  // Progressive remux often reports “duration” as only what’s buffered so far.
  // Track by playhead alone until we see a trusted full length.
  if (options?.allowUnknownDuration) {
    if (!isTrustedDuration(duration)) return true
    return !isEpisodeComplete(currentTime, duration)
  }

  if (durationUnknown) return false
  if (duration < 60) return false
  return true
}

export function upsertContinueEntry(
  entry: Omit<ContinueWatchingEntry, 'updatedAt'> & { updatedAt?: number },
  options?: { allowUnknownDuration?: boolean },
) {
  if (!isVodCategory(entry.category)) return

  const existing = getContinueEntry(entry.id)
  // Prefer a trusted full length (saved or newly reported) for the 95% complete check.
  const durationForComplete = isTrustedDuration(entry.duration)
    ? entry.duration
    : existing?.duration && isTrustedDuration(existing.duration)
      ? existing.duration
      : 0

  // Finished (≥95%) — drop from Continue watching instead of saving.
  if (isEpisodeComplete(entry.currentTime, durationForComplete)) {
    removeContinueEntry(entry.id)
    return
  }

  if (!shouldTrackProgress(entry.duration, entry.currentTime, options)) {
    return
  }

  const trusted = isTrustedDuration(entry.duration)
  const next: ContinueWatchingEntry = {
    ...existing,
    ...entry,
    // Don’t persist truncated remux durations — they look “almost done” on Home.
    duration: trusted ? entry.duration : existing?.duration && existing.duration > 0 ? existing.duration : 0,
    updatedAt: entry.updatedAt ?? Date.now(),
  }

  // Re-check after merging a previously saved trusted duration.
  if (isEpisodeComplete(next.currentTime, next.duration)) {
    removeContinueEntry(entry.id)
    return
  }

  // Replace only this title id — never drop other categories' resumes.
  const others = readAll().filter((item) => item.id !== next.id)
  writeAll([next, ...others])
}

export function progressPercent(entry: ContinueWatchingEntry): number {
  if (!entry.duration || entry.duration <= 0) {
    // Unknown length — show a modest bar so the card still looks in-progress.
    return Math.min(85, Math.max(8, Math.round((entry.currentTime / 1400) * 100)))
  }
  return Math.min(99, Math.max(1, Math.round((entry.currentTime / entry.duration) * 100)))
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function formatResumeLabel(entry: ContinueWatchingEntry): string {
  const parts: string[] = [vodCategoryLabel(entry.category)]
  if (entry.category !== 'movies') {
    if (entry.episodeTitle) parts.push(entry.episodeTitle)
    else if (entry.playlistIndex > 0) parts.push(`Episode ${entry.playlistIndex + 1}`)
  }

  if (entry.duration > 0) {
    const left = Math.max(0, entry.duration - entry.currentTime)
    parts.push(`${formatClock(left)} left`)
  } else {
    parts.push(`Resume at ${formatClock(entry.currentTime)}`)
  }
  return parts.join(' · ')
}

/** Best-effort shelf for a torrent title when the catalog category is unknown. */
export function guessVodCategory(title: string, hintUrl = ''): VodCategoryId {
  const text = `${title} ${hintUrl}`.toLowerCase()
  if (/anime|subsplease|nyaa|erai-raws|horriblesubs/.test(text)) return 'anime'
  if (
    /\b(?:s\d{1,2}e\d{1,2}|season\s*\d+|episode\s*\d+|e\d{2}\b|complete\s*series|tv\s*series|television)\b/.test(
      text,
    ) ||
    /\/(?:television|tv|series|show)\b/.test(text)
  ) {
    return 'series'
  }
  if (/\/(?:movie|movies|film)\b/.test(text) || /\b(?:19|20)\d{2}\b/.test(text)) return 'movies'
  return 'movies'
}
