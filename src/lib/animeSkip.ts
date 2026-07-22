/**
 * Anime intro/outro skip windows via AniSkip (crowdsourced).
 *
 * Cold opens: when AniSkip marks an OP that starts after a short teaser
 * (startTime >= COLD_OPEN_MIN_SECONDS), the player auto-skips the OP once
 * the playhead reaches it — the teaser always plays.
 *
 * When AniSkip has no data, a cold-open-aware default (≈1:25→2:55) is used
 * for manual Skip Intro only — never from 0, so the teaser is not wiped.
 */

import { cleanPosterSearchTitle } from './posterFallback'
import { normalizeShowKey, parseEpisodeKey } from './torrents'

/** Minimum OP start time to treat the prologue as a cold open (auto-skip OP). */
export const COLD_OPEN_MIN_SECONDS = 10

/**
 * Manual fallback when AniSkip has no timestamps.
 * Starts after a typical cold open so Skip Intro does not appear at t=0
 * and jumping lands past the OP rather than into it.
 */
export const DEFAULT_OP_START = 85
export const DEFAULT_OP_END = 175

/** Progressive remux often reports ~buffer length; only trust full episode lengths. */
const TRUSTED_EPISODE_LENGTH = 5 * 60

const MAL_CACHE_KEY = 'jiyu.anime.mal.v1'
const SKIP_CACHE_KEY = 'jiyu.anime.skip.v1'

export interface AnimeSkipInterval {
  startTime: number
  endTime: number
  skipType: 'op' | 'ed' | 'recap' | string
  source: 'aniskip' | 'default'
}

function loadJsonMap(key: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function saveJsonMap(key: string, value: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore quota */
  }
}

/** Best-effort episode number from a release / playlist title. */
export function episodeNumberFromTitle(title: string): number {
  const key = parseEpisodeKey(title)
  if (!key) return NaN
  const match = /E(\d+(?:\.\d+)?)/i.exec(key)
  if (!match) return NaN
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : NaN
}

/** Show name suitable for AniList / MAL lookup. */
export function animeSearchTitle(title: string, fallbackTitle?: string): string {
  const scrub = (value: string) =>
    cleanPosterSearchTitle(value, 'anime')
      .replace(/\b(?:Episode|Ep\.?)\s*#?\s*\d+(?:\.\d+)?\b/gi, ' ')
      .replace(/\s*[·•]\s*/g, ' ')
      .replace(/\s*[|/\-]+\s*$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  const cleaned = scrub(title)
  if (cleaned.length >= 2) return cleaned
  if (fallbackTitle) {
    const alt = scrub(fallbackTitle)
    if (alt.length >= 2) return alt
  }
  return normalizeShowKey(title) || title
}

async function resolveMalId(search: string): Promise<number | null> {
  const cacheKey = search.trim().toLowerCase()
  if (!cacheKey) return null
  const cache = loadJsonMap(MAL_CACHE_KEY)
  const cached = cache[cacheKey]
  if (typeof cached === 'number' && cached > 0) return cached
  // Do not honor cached null forever — AniList blips / bad queries recover on retry.
  if (cached === null) delete cache[cacheKey]

  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query ($search: String) { Media(search: $search, type: ANIME) { idMal title { romaji english } } }',
        variables: { search },
      }),
    })
    if (!response.ok) {
      return null
    }
    const json = (await response.json()) as {
      data?: { Media?: { idMal?: number | null } }
    }
    const malId = json.data?.Media?.idMal
    const resolved = typeof malId === 'number' && malId > 0 ? malId : null
    if (resolved) {
      cache[cacheKey] = resolved
      saveJsonMap(MAL_CACHE_KEY, cache)
    }
    return resolved
  } catch {
    return null
  }
}

async function fetchAniSkipIntervals(
  malId: number,
  episode: number,
  episodeLength: number,
): Promise<AnimeSkipInterval[]> {
  const cacheKey = `${malId}:${episode}:${Math.round(episodeLength || 0)}`
  const cache = loadJsonMap(SKIP_CACHE_KEY)
  const cached = cache[cacheKey]
  // Only reuse positive hits — empty misses were often from bad length filters.
  if (Array.isArray(cached) && cached.length > 0) {
    return cached as AnimeSkipInterval[]
  }

  const params = new URLSearchParams()
  params.append('types', 'op')
  params.append('types', 'ed')
  params.append('types', 'recap')
  params.set('episodeLength', String(Math.max(0, Math.round(episodeLength || 0))))

  try {
    const response = await fetch(
      `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params}`,
    )
    if (!response.ok) return []
    const json = (await response.json()) as {
      found?: boolean
      results?: Array<{
        skipType?: string
        interval?: { startTime?: number; endTime?: number }
      }>
    }
    if (!json.found || !Array.isArray(json.results)) return []
    const intervals = json.results
      .map((row) => {
        const start = Number(row.interval?.startTime)
        const end = Number(row.interval?.endTime)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 3) return null
        return {
          startTime: start,
          endTime: end,
          skipType: row.skipType || 'op',
          source: 'aniskip' as const,
        }
      })
      .filter((row): row is AnimeSkipInterval => Boolean(row))
      .sort((a, b) => a.startTime - b.startTime)

    if (intervals.length > 0) {
      cache[cacheKey] = intervals
      saveJsonMap(SKIP_CACHE_KEY, cache)
    }
    return intervals
  } catch {
    return []
  }
}

function defaultOpeningInterval(): AnimeSkipInterval {
  return {
    startTime: DEFAULT_OP_START,
    endTime: DEFAULT_OP_END,
    skipType: 'op',
    source: 'default',
  }
}

/**
 * Resolve skip windows for an anime episode.
 * Prefers AniSkip; falls back to a post-cold-open default for manual Skip Intro.
 */
export async function resolveAnimeSkipIntervals(options: {
  title: string
  showTitle?: string
  episodeTitle?: string
  episodeLength?: number
  /** 1-based playlist episode index when the title has no parseable number. */
  episodeHint?: number
}): Promise<AnimeSkipInterval[]> {
  const episodeTitle = options.episodeTitle || options.title
  const search = animeSearchTitle(options.showTitle || options.title, episodeTitle)
  const fromTitle = episodeNumberFromTitle(episodeTitle)
  const fromShow = episodeNumberFromTitle(options.showTitle || options.title)
  const hint =
    options.episodeHint && options.episodeHint > 0 ? options.episodeHint : NaN

  const episodeCandidates = [
    ...new Set(
      [fromTitle, fromShow, hint, 1].filter(
        (n) => Number.isFinite(n) && n > 0,
      ) as number[],
    ),
  ]

  // episodeLength filters AniSkip results — never pass progressive remux buffer sizes.
  const rawLength = options.episodeLength && options.episodeLength > 0 ? options.episodeLength : 0
  const length = rawLength >= TRUSTED_EPISODE_LENGTH ? rawLength : 0

  const malId = await resolveMalId(search)
  if (malId) {
    for (const episode of episodeCandidates) {
      const found = await fetchAniSkipIntervals(malId, episode, length)
      if (found.length > 0) return found
      if (!Number.isInteger(episode)) {
        const again = await fetchAniSkipIntervals(malId, Math.floor(episode), length)
        if (again.length > 0) return again
      }
    }
  }

  return [defaultOpeningInterval()]
}

/** Active skip target for the current playhead (prefers openings / recaps). */
export function activeSkipInterval(
  intervals: AnimeSkipInterval[],
  playhead: number,
  leadIn = 1.5,
  leadOut = 1.25,
): AnimeSkipInterval | null {
  const preferred = intervals.filter((row) => row.skipType === 'op' || row.skipType === 'recap')
  const pool = preferred.length > 0 ? preferred : intervals.filter((row) => row.skipType === 'ed')
  for (const row of pool) {
    if (playhead >= row.startTime - leadIn && playhead < row.endTime - leadOut) {
      return row
    }
  }
  return null
}

export function skipButtonLabel(interval: AnimeSkipInterval): string {
  if (interval.skipType === 'ed') return 'Skip Ending'
  if (interval.skipType === 'recap') return 'Skip Recap'
  return 'Skip Intro'
}

/**
 * True when this OP follows a cold open and should be jumped automatically
 * once the playhead enters the opening window. Never true for the default
 * fallback (manual Skip Intro only).
 */
export function shouldAutoSkipOpening(interval: AnimeSkipInterval): boolean {
  return (
    interval.skipType === 'op' &&
    interval.source === 'aniskip' &&
    interval.startTime >= COLD_OPEN_MIN_SECONDS &&
    interval.endTime > interval.startTime + 3
  )
}
