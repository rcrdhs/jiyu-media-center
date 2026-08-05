import type { CategoryId, StreamItem, StreamSourceKind, StreamTransport } from '../types'

function mirrorWatchHistory(
  entry: Omit<ContinueWatchingEntry, 'updatedAt'> & { updatedAt?: number; finished?: boolean },
) {
  // Dynamic import avoids a static cycle with watchHistory helpers.
  void import('./watchHistory').then(({ recordWatchHistory }) => {
    recordWatchHistory(entry)
  })
}

const KEY = 'jiyu.continue.v1'
/** Max resume titles kept per VOD shelf — movies / series / anime never evict each other. */
const MAX_PER_CATEGORY = 8
/** Save after a short watch so resume appears without a long wait. */
const MIN_SECONDS = 5
/** Watched this much of the title → treat as finished (no Continue watching). */
export const COMPLETE_RATIO = 0.95
export const FORCE_SAVE_CONTINUE_EVENT = 'jiyu:force-save-continue'

/** Titles that support Continue watching / mid-playback resume. */
export const VOD_CATEGORIES = ['movies', 'series', 'anime', 'kids'] as const
export type VodCategoryId = (typeof VOD_CATEGORIES)[number]

export function isVodCategory(category: CategoryId | undefined): category is VodCategoryId {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
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
  /** Authoritative runtime (YTS/ffprobe) — preferred over remux buffer duration. */
  runtimeSeconds?: number
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
  const entry = readAll().find((item) => item.id === id) ?? null
  if (!entry) return null
  return sanitizeContinueEntry(entry)
}

/**
 * Clamp / recover a playhead against an authoritative runtime.
 * Severe overruns (watch-clock / remux offset bugs) fold back into the title
 * instead of offering Resume past EOF.
 */
export function normalizeContinuePlayhead(
  currentTime: number,
  runtimeSeconds?: number | null,
): { currentTime: number; finished: boolean; repaired: boolean } {
  const runtime = Number(runtimeSeconds) || 0
  const t = Math.max(0, Number(currentTime) || 0)
  if (!isTrustedDuration(runtime) || !Number.isFinite(t)) {
    return { currentTime: t, finished: false, repaired: false }
  }
  if (t <= runtime * COMPLETE_RATIO) {
    return { currentTime: Math.min(t, runtime), finished: false, repaired: t > runtime }
  }
  // Slightly past the real end — treat as finished.
  if (t <= runtime * 1.12) {
    return { currentTime: t, finished: true, repaired: false }
  }
  // Severe overrun: fold wall-clock / accrued time back into the movie.
  let folded = t % runtime
  if (folded < MIN_SECONDS) {
    return { currentTime: t, finished: true, repaired: true }
  }
  if (folded >= runtime * COMPLETE_RATIO) {
    return { currentTime: t, finished: true, repaired: true }
  }
  // Rewind a few seconds so Resume isn't parked on a remux gap edge.
  return {
    currentTime: Math.max(MIN_SECONDS, folded - 10),
    finished: false,
    repaired: true,
  }
}

/** Apply runtime clamp to a continue row; removes the row when past the real end. */
export function sanitizeContinueEntry(
  entry: ContinueWatchingEntry,
  runtimeSeconds?: number | null,
): ContinueWatchingEntry | null {
  const runtime =
    Number(runtimeSeconds) ||
    Number(entry.runtimeSeconds) ||
    (isTrustedDuration(entry.duration) ? entry.duration : 0)
  if (!isTrustedDuration(runtime)) return entry

  const normalized = normalizeContinuePlayhead(entry.currentTime, runtime)
  if (normalized.finished) {
    removeContinueEntry(entry.id)
    return null
  }
  const needsWrite =
    normalized.repaired ||
    entry.currentTime !== normalized.currentTime ||
    entry.runtimeSeconds !== runtime ||
    (isTrustedDuration(runtime) && entry.duration !== runtime)
  if (!needsWrite) return entry

  const next: ContinueWatchingEntry = {
    ...entry,
    currentTime: normalized.currentTime,
    duration: runtime,
    runtimeSeconds: runtime,
    updatedAt: Date.now(),
  }
  const others = readAll().filter((item) => item.id !== next.id)
  writeAll([next, ...others])
  return next
}

/**
 * When playback learns a trusted runtime, repair a bloated Continue row so
 * Resume offers a real in-title time (not 2h+ past EOF).
 */
export function repairContinueWithRuntime(
  id: string,
  runtimeSeconds: number,
): ContinueWatchingEntry | null {
  const entry = readAll().find((item) => item.id === id) ?? null
  if (!entry) return null
  return sanitizeContinueEntry(entry, runtimeSeconds)
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
    runtimeSeconds: entry.runtimeSeconds,
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

export function isTrustedDuration(duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration !== Infinity &&
    duration >= TRUSTED_DURATION_SECONDS
  )
}

/** Prefer the longer of two trusted runtimes (catalog vs ffprobe). */
export function mergeRuntimeSeconds(
  a?: number | null,
  b?: number | null,
): number | undefined {
  const left = Number(a) || 0
  const right = Number(b) || 0
  const best = Math.max(left, right)
  return best > 0 ? best : undefined
}

/**
 * Pick an authoritative title length: catalog/YTS/ffprobe runtime first, then a
 * saved Continue duration that does not look like a remux buffer stub.
 */
export function resolveTrustedRuntimeSeconds(options: {
  runtimeSeconds?: number | null
  savedDuration?: number | null
  reportedDuration?: number | null
  playbackUrl?: string
  currentTime?: number
}): number {
  const runtime = Number(options.runtimeSeconds) || 0
  if (isTrustedDuration(runtime)) return runtime

  const saved = Number(options.savedDuration) || 0
  const playhead = Number(options.currentTime) || 0
  if (
    isTrustedDuration(saved) &&
    !isLikelyPartialDuration(saved, playhead, {
      assumeProgressive: true,
      playbackUrl: options.playbackUrl,
    })
  ) {
    return saved
  }

  const reported = Number(options.reportedDuration) || 0
  if (
    isTrustedDuration(reported) &&
    !isLocalPlaybackUrl(options.playbackUrl) &&
    !isLikelyPartialDuration(reported, playhead, { playbackUrl: options.playbackUrl })
  ) {
    return reported
  }
  return 0
}

/**
 * Progressive remux / torrent pipes often report duration ≈ buffered end ≈ playhead.
 * Treating that as the real episode length falsely marks mid-watch as “finished”
 * and wipes Continue watching (common around 10–15 minutes into anime).
 */
export function isLikelyPartialDuration(
  duration: number,
  currentTime: number,
  options?: { assumeProgressive?: boolean; playbackUrl?: string },
): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false
  if (!Number.isFinite(currentTime) || currentTime < 0) return false
  const progressive =
    Boolean(options?.assumeProgressive) || isLocalPlaybackUrl(options?.playbackUrl)
  if (progressive) {
    // Still downloading / remuxing — length tracks the buffer, not the file.
    // Use a tight window: real titles still have many minutes left at mid-watch.
    return duration <= currentTime + 90
  }
  // Non-progressive: only reject the obvious “duration hugs the playhead” case.
  return currentTime >= MIN_SECONDS && duration <= currentTime + 45
}

/**
 * Remux pipes often fire `ended` when ffmpeg hits a download gap or when the
 * browser treats the buffered fragment length as the full title (~5 minutes in).
 * Those are not real finishes — Continue watching must keep the playhead.
 */
export function isRemuxFalseEnd(
  currentTime: number,
  duration: number,
  playbackUrl?: string,
  trustedRuntime?: number,
): boolean {
  if (!isLocalPlaybackUrl(playbackUrl)) return false
  if (!Number.isFinite(currentTime) || currentTime < MIN_SECONDS) return false
  // With a real runtime, any stop before ~92% of that length is a gap — not the end.
  if (isTrustedDuration(trustedRuntime || 0)) {
    return currentTime < (trustedRuntime as number) * 0.92
  }
  // Classic early stop: Chromium thinks the movie is only a few minutes long.
  if (!Number.isFinite(duration) || duration <= 0 || duration < 20 * 60) return true
  if (
    isLikelyPartialDuration(duration, currentTime, {
      assumeProgressive: true,
      playbackUrl,
    })
  ) {
    return true
  }
  // Trusted-looking length but still clearly mid-title.
  return currentTime / duration < 0.9
}

/**
 * True when the viewer has reached at least 95% of a known full duration.
 * Requires a trusted length so progressive remux buffer sizes don’t count as “done”.
 * Local remux/torrent URLs never complete from remux duration alone — only from
 * an authoritative runtime (YTS/ffprobe) passed as `duration` with `authoritative`.
 */
export function isEpisodeComplete(
  currentTime: number,
  duration: number,
  options?: { playbackUrl?: string; assumeProgressive?: boolean; authoritative?: boolean },
): boolean {
  if (!Number.isFinite(currentTime) || currentTime < MIN_SECONDS) return false
  if (!isTrustedDuration(duration)) return false
  if (options?.authoritative) {
    return currentTime / duration >= COMPLETE_RATIO
  }
  if (options?.assumeProgressive || isLocalPlaybackUrl(options?.playbackUrl)) {
    return false
  }
  if (isLikelyPartialDuration(duration, currentTime, options)) return false
  return currentTime / duration >= COMPLETE_RATIO
}

export function shouldTrackProgress(
  duration: number,
  currentTime: number,
  options?: { allowUnknownDuration?: boolean; playbackUrl?: string },
): boolean {
  if (!Number.isFinite(currentTime) || currentTime < MIN_SECONDS) return false
  const usableDuration = isLikelyPartialDuration(duration, currentTime, {
    assumeProgressive: options?.allowUnknownDuration,
    playbackUrl: options?.playbackUrl,
  })
    ? 0
    : duration
  if (
    isEpisodeComplete(currentTime, usableDuration, {
      playbackUrl: options?.playbackUrl,
      assumeProgressive: options?.allowUnknownDuration,
    })
  ) {
    return false
  }

  const durationUnknown =
    !Number.isFinite(usableDuration) || usableDuration === Infinity || usableDuration <= 0

  // Progressive remux often reports “duration” as only what’s buffered so far.
  // Track by playhead alone until we see a trusted full length.
  if (options?.allowUnknownDuration) {
    if (!isTrustedDuration(usableDuration)) return true
    return !isEpisodeComplete(currentTime, usableDuration, {
      playbackUrl: options?.playbackUrl,
      assumeProgressive: true,
    })
  }

  if (durationUnknown) return false
  if (usableDuration < 60) return false
  return true
}

export function upsertContinueEntry(
  entry: Omit<ContinueWatchingEntry, 'updatedAt'> & { updatedAt?: number },
  options?: { allowUnknownDuration?: boolean; playbackUrl?: string },
) {
  if (!isVodCategory(entry.category)) return

  // Read raw — avoid sanitize recursion while merging.
  const existing = readAll().find((item) => item.id === entry.id) ?? null
  const playbackUrl = options?.playbackUrl || entry.playUrl
  const progressive = Boolean(options?.allowUnknownDuration) || isLocalPlaybackUrl(playbackUrl)

  const runtimeHint =
    Number(entry.runtimeSeconds) ||
    Number(existing?.runtimeSeconds) ||
    0
  const normalized = normalizeContinuePlayhead(entry.currentTime, runtimeHint)
  if (normalized.finished) {
    mirrorWatchHistory({ ...existing, ...entry, currentTime: entry.currentTime, finished: true })
    removeContinueEntry(entry.id)
    return
  }
  const playhead = normalized.currentTime

  const scrub = (duration: number) =>
    isLikelyPartialDuration(duration, playhead, {
      assumeProgressive: progressive,
      playbackUrl,
    })
      ? 0
      : duration

  const reportedDuration = scrub(entry.duration)
  const savedDuration = scrub(existing?.duration || 0)

  // Prefer a trusted full length (saved or newly reported) for the 95% complete check.
  const durationForComplete = isTrustedDuration(reportedDuration)
    ? reportedDuration
    : isTrustedDuration(savedDuration)
      ? savedDuration
      : isTrustedDuration(runtimeHint)
        ? runtimeHint
        : 0

  // Finished (≥95%) — keep in History, drop from Continue watching.
  if (
    isEpisodeComplete(playhead, durationForComplete, {
      playbackUrl,
      assumeProgressive: progressive,
      authoritative: isTrustedDuration(runtimeHint) || isTrustedDuration(durationForComplete),
    })
  ) {
    mirrorWatchHistory({
      ...existing,
      ...entry,
      currentTime: playhead,
      duration: durationForComplete || entry.duration,
      finished: true,
    })
    removeContinueEntry(entry.id)
    return
  }

  if (
    !shouldTrackProgress(reportedDuration || entry.duration, playhead, {
      ...options,
      playbackUrl,
    })
  ) {
    return
  }

  const trusted = isTrustedDuration(reportedDuration)
  const next: ContinueWatchingEntry = {
    ...existing,
    ...entry,
    currentTime: playhead,
    runtimeSeconds: runtimeHint || entry.runtimeSeconds || existing?.runtimeSeconds,
    // Don’t persist truncated remux durations — they look “almost done” on Home.
    duration: trusted
      ? reportedDuration
      : isTrustedDuration(savedDuration)
        ? savedDuration
        : isTrustedDuration(runtimeHint)
          ? runtimeHint
          : 0,
    updatedAt: entry.updatedAt ?? Date.now(),
  }

  // Re-check after merging a previously saved trusted duration.
  if (
    isEpisodeComplete(next.currentTime, next.duration || runtimeHint, {
      playbackUrl,
      assumeProgressive: progressive,
      authoritative: isTrustedDuration(next.duration || runtimeHint),
    })
  ) {
    mirrorWatchHistory({ ...next, finished: true })
    removeContinueEntry(entry.id)
    return
  }

  mirrorWatchHistory(next)

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
