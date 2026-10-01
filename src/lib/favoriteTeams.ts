import type { StreamItem } from '../types'
import { isFootballSportsItem } from './sportsLeagues'
import {
  isLivextvReplayCatalogItem,
  LIVEXTV_REPLAY_MAX_AGE_MS,
} from './livextvReplays'

export type FavoriteSport = 'football' | 'basketball' | 'cricket' | 'american-football'

export interface FavoriteTeam {
  id: string
  name: string
  sport: FavoriteSport
}

const STORAGE_KEY = 'jiyu.sports.favorite-teams'
const CHANGE_EVENT = 'jiyu-favorite-teams'
/** Same key the Sports chips write. Home uses it so Your teams follows the selected sport. */
export const SPORTS_SPORT_PREF_KEY = 'jiyu.sports.streamed-sport'

const MAX_TEAMS = 24

const FAVORITE_SPORTS: readonly FavoriteSport[] = [
  'football',
  'basketball',
  'cricket',
  'american-football',
]

export const FAVORITE_SPORT_LABELS: Record<FavoriteSport, string> = {
  football: 'Football',
  basketball: 'Basketball',
  cricket: 'Cricket',
  'american-football': 'American football',
}

function isFavoriteSport(value: unknown): value is FavoriteSport {
  return FAVORITE_SPORTS.includes(value as FavoriteSport)
}

function readRaw(): FavoriteTeam[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const out: FavoriteTeam[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const name = String((row as FavoriteTeam).name || '').trim()
      const sport = (row as FavoriteTeam).sport
      const id = String((row as FavoriteTeam).id || '')
      if (name.length < 2 || !isFavoriteSport(sport)) continue
      out.push({ id: id || teamId(name, sport), name, sport })
    }
    return out.slice(0, MAX_TEAMS)
  } catch {
    return []
  }
}

function writeRaw(teams: FavoriteTeam[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(teams.slice(0, MAX_TEAMS)))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function readFavoriteTeams(): FavoriteTeam[] {
  return readRaw()
}

export function readSelectedSportsFilter(): string {
  try {
    return localStorage.getItem(SPORTS_SPORT_PREF_KEY) || 'all'
  } catch {
    return 'all'
  }
}

export function writeSelectedSportsFilter(sportId: string) {
  try {
    localStorage.setItem(SPORTS_SPORT_PREF_KEY, sportId || 'all')
  } catch {
    /* ignore */
  }
}

export function subscribeFavoriteTeams(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(CHANGE_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

function teamId(name: string, sport: FavoriteSport): string {
  return `${sport}:${name.trim().toLowerCase()}`
}

export function addFavoriteTeam(name: string, sport: FavoriteSport): FavoriteTeam | null {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 2) return null
  const teams = readRaw()
  const id = teamId(trimmed, sport)
  if (teams.some((team) => team.id === id)) return teams.find((team) => team.id === id) || null
  const next: FavoriteTeam = { id, name: trimmed, sport }
  writeRaw([...teams, next])
  return next
}

export function removeFavoriteTeam(id: string) {
  writeRaw(readRaw().filter((team) => team.id !== id))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function teamNamePattern(name: string): RegExp {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
  return new RegExp(`(?:^|[^a-z0-9])${parts.join('\\s+')}(?:[^a-z0-9]|$)`, 'i')
}

function itemText(item: StreamItem): string {
  const tags = (item.tags || []).join(' ')
  return `${item.title || ''} ${item.description || ''} ${item.eventSport || ''} ${tags}`
}

export function isBasketballSportsItem(item: StreamItem): boolean {
  const blob = itemText(item)
  if (/\b(nba|wnba|euroleague|basketball|fiba|ncaa)\b/i.test(blob)) return true
  if (/^basketball$/i.test(String(item.eventSport || ''))) return true
  return Boolean(item.tags?.some((tag) => /^basketball$/i.test(String(tag || ''))))
}

export function isCricketSportsItem(item: StreamItem): boolean {
  const blob = itemText(item)
  if (/\b(cricket|ipl|t20|test\s*match|odi|bbl|big\s*bash|psl|the\s*hundred)\b/i.test(blob)) {
    return true
  }
  if (/^cricket$/i.test(String(item.eventSport || ''))) return true
  return Boolean(item.tags?.some((tag) => /^cricket$/i.test(String(tag || ''))))
}

export function isAmericanFootballSportsItem(item: StreamItem): boolean {
  const blob = itemText(item)
  if (/\b(nfl|ncaaf|college\s*football|american\s*football|gridiron|super\s*bowl)\b/i.test(blob)) {
    return true
  }
  if (/^(american[\s-]?football|am[\s-]?football|nfl)$/i.test(String(item.eventSport || ''))) {
    return true
  }
  return Boolean(
    item.tags?.some((tag) =>
      /^(american-?football|am-?football|nfl)$/i.test(String(tag || '')),
    ),
  )
}

/** Sports that are not one of the favorite-team categories. */
function isOtherSport(item: StreamItem): boolean {
  const blob = itemText(item)
  return /\b(nhl|ice\s*hockey|hockey|mlb|baseball|ufc|mma|boxing|tennis|formula\s*1|nascar|golf|afl|australian\s*football|canadian\s*football|cfl|snooker|billiards|pool|darts|rugby|wrestling|volleyball|handball|table\s*tennis|badminton|motorsport|motor\s*sport|cycling|skiing|swimming)\b/i.test(
    blob,
  )
}

function detectedSport(item: StreamItem): FavoriteSport | 'other' | null {
  // More specific sports first so NFL isn't swallowed by soccer "football".
  if (isAmericanFootballSportsItem(item)) return 'american-football'
  if (isCricketSportsItem(item)) return 'cricket'
  if (isBasketballSportsItem(item)) return 'basketball'
  if (isFootballSportsItem(item)) return 'football'
  if (isOtherSport(item)) return 'other'
  return null
}

export function itemMatchesFavorite(item: StreamItem, team: FavoriteTeam): boolean {
  if (item.category !== 'sports') return false
  if (detectedSport(item) !== team.sport) return false
  if (!teamNamePattern(team.name).test(itemText(item))) return false
  return true
}

function teamsForFilter(teams: FavoriteTeam[], sportFilter: string): FavoriteTeam[] {
  if (!sportFilter || sportFilter === 'all') return teams
  if (isFavoriteSport(sportFilter)) {
    return teams.filter((team) => team.sport === sportFilter)
  }
  // Streamed chip ids sometimes use alternate spellings.
  if (/^(american[\s_-]?football|am[\s_-]?football|nfl)$/i.test(sportFilter)) {
    return teams.filter((team) => team.sport === 'american-football')
  }
  return []
}

/** Live matches stay on Your teams this long after kickoff (same Home window). */
export const LIVE_WINDOW_MS = 4 * 60 * 60 * 1000
const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Replays on Your teams use the same window as the Sports → Replay shelf. */
export const REPLAY_WINDOW_MS = LIVEXTV_REPLAY_MAX_AGE_MS

function replayAgeMs(item: StreamItem, now: number): number {
  const stamp = item.releasedAt || item.eventStartsAt || 0
  if (!(stamp > 0)) return Number.POSITIVE_INFINITY
  return now - stamp
}

function isFavoriteReplay(item: StreamItem): boolean {
  return isLivextvReplayCatalogItem(item) || Boolean(item.tags?.includes('replay'))
}

/** Live, upcoming, and recent replays for saved teams — live first, then upcoming, then replay. */
export function favoriteTeamMatches(
  items: StreamItem[],
  teams: FavoriteTeam[],
  sportFilter = readSelectedSportsFilter(),
): StreamItem[] {
  const active = teamsForFilter(teams, sportFilter)
  if (active.length === 0) return []
  const now = Date.now()
  const seen = new Set<string>()
  const hits: StreamItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    if (!active.some((team) => itemMatchesFavorite(item, team))) continue

    if (isFavoriteReplay(item)) {
      // Same expiry as Sports → Replay shelf (~3 days). Older VODs leave Your teams.
      if (replayAgeMs(item, now) > REPLAY_WINDOW_MS) continue
      seen.add(item.id)
      hits.push(item)
      continue
    }

    const start = item.eventStartsAt || 0
    // 24/7 channels have no kickoff. A country in the title is not a match.
    if (!(start > 0)) continue
    const live = start <= now && now - start <= LIVE_WINDOW_MS
    const upcoming = start > now && start - now <= UPCOMING_WINDOW_MS
    if (!live && !upcoming) continue
    seen.add(item.id)
    hits.push(item)
  }
  hits.sort((a, b) => {
    const rank = (item: StreamItem) => {
      if (isFavoriteReplay(item)) return 2
      const start = item.eventStartsAt || 0
      if (start > 0 && start <= now) return 0
      if (start > now) return 1
      return 3
    }
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    if (isFavoriteReplay(a) || isFavoriteReplay(b)) {
      return replayAgeMs(a, now) - replayAgeMs(b, now)
    }
    return (a.eventStartsAt || 0) - (b.eventStartsAt || 0)
  })
  return hits.slice(0, 24)
}
