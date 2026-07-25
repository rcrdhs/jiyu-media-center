import type { CategoryId } from '../types'

const STORAGE_KEY = 'jiyu.library.growth.v1'
const TRACKED = new Set<CategoryId>(['movies', 'series', 'anime'])

type DayCounts = Record<string, number> // YYYY-MM-DD → title count

type GrowthStore = Partial<Record<CategoryId, DayCounts>>

export type SectionGrowth = {
  yesterday: number | null
  today: number
  delta: number | null
}

function localDateKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function yesterdayKey(from = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() - 1)
  return localDateKey(d)
}

function readStore(): GrowthStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as GrowthStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: GrowthStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* ignore quota */
  }
}

/** Keep a short rolling window so the key doesn't grow forever. */
function pruneDays(days: DayCounts, keep = 14): DayCounts {
  const keys = Object.keys(days).sort()
  if (keys.length <= keep) return days
  const next: DayCounts = {}
  for (const key of keys.slice(-keep)) next[key] = days[key]
  return next
}

export function isGrowthTrackedSection(id: CategoryId): boolean {
  return TRACKED.has(id)
}

/**
 * Snapshot today's shelf title count for a section. Call when the catalog
 * has a stable count (after show-collapse, before search filter).
 */
export function recordSectionTitleCount(category: CategoryId, count: number): SectionGrowth {
  if (!TRACKED.has(category) || !Number.isFinite(count) || count < 0) {
    return { yesterday: null, today: Math.max(0, count || 0), delta: null }
  }

  const today = localDateKey()
  const yday = yesterdayKey()
  const store = readStore()
  const days = { ...(store[category] ?? {}) }
  days[today] = Math.max(0, Math.round(count))
  store[category] = pruneDays(days)
  writeStore(store)

  const yesterday = typeof days[yday] === 'number' ? days[yday] : null
  const todayCount = days[today]
  return {
    yesterday,
    today: todayCount,
    delta: yesterday == null ? null : todayCount - yesterday,
  }
}

export function getSectionGrowth(category: CategoryId, fallbackToday = 0): SectionGrowth {
  if (!TRACKED.has(category)) {
    return { yesterday: null, today: fallbackToday, delta: null }
  }
  const days = readStore()[category] ?? {}
  const todayKey = localDateKey()
  const yday = yesterdayKey()
  const today = typeof days[todayKey] === 'number' ? days[todayKey] : fallbackToday
  const yesterday = typeof days[yday] === 'number' ? days[yday] : null
  return {
    yesterday,
    today,
    delta: yesterday == null ? null : today - yesterday,
  }
}

export function formatSectionGrowth(growth: SectionGrowth): string | null {
  const t = growth.today.toLocaleString()
  if (growth.yesterday == null) {
    // First snapshot for this section — comparison appears the next calendar day.
    return `Today ${t} titles`
  }
  const y = growth.yesterday.toLocaleString()
  return `Yesterday ${y} titles · Today ${t} titles`
}
