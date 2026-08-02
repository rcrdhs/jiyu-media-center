import type { CategoryId } from '../types'

const STORAGE_KEY = 'jiyu.library.growth.v1'
const TRACKED = new Set<CategoryId>(['movies', 'series', 'anime'])

type DayCounts = Record<string, number> // YYYY-MM-DD → title count

/** Current end-of-day (latest) counts, plus first count seen that calendar day. */
type GrowthStore = {
  days: Partial<Record<CategoryId, DayCounts>>
  open: Partial<Record<CategoryId, DayCounts>>
  /** Whole-catalog totals for the Home hero panel. */
  catalogDays?: DayCounts
  catalogOpen?: DayCounts
}

export type SectionGrowth = {
  yesterday: number | null
  today: number
  /** today − yesterday, when yesterday was recorded */
  delta: number | null
  /** today − first count recorded today (new titles since morning baseline) */
  newToday: number
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

function emptyStore(): GrowthStore {
  return { days: {}, open: {}, catalogDays: {}, catalogOpen: {} }
}

function readStore(): GrowthStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as GrowthStore | Partial<Record<CategoryId, DayCounts>>
    if (!parsed || typeof parsed !== 'object') return emptyStore()
    // Migrate v1 flat map { movies: { "2026-…" : n } } → { days, open }
    if (!('days' in parsed) && !('open' in parsed)) {
      const days = parsed as Partial<Record<CategoryId, DayCounts>>
      return { days, open: {} }
    }
    const store = parsed as GrowthStore
    return {
      days: store.days && typeof store.days === 'object' ? store.days : {},
      open: store.open && typeof store.open === 'object' ? store.open : {},
      catalogDays:
        store.catalogDays && typeof store.catalogDays === 'object' ? store.catalogDays : {},
      catalogOpen:
        store.catalogOpen && typeof store.catalogOpen === 'object' ? store.catalogOpen : {},
    }
  } catch {
    return emptyStore()
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

function growthFrom(
  days: DayCounts,
  open: DayCounts,
  fallbackToday: number,
): SectionGrowth {
  const todayKey = localDateKey()
  const yday = yesterdayKey()
  const today = typeof days[todayKey] === 'number' ? days[todayKey] : fallbackToday
  const yesterday = typeof days[yday] === 'number' ? days[yday] : null
  const openToday = typeof open[todayKey] === 'number' ? open[todayKey] : today
  return {
    yesterday,
    today,
    delta: yesterday == null ? null : today - yesterday,
    newToday: today - openToday,
  }
}

/**
 * Snapshot today's shelf title count for a section. Call when the catalog
 * has a stable count (after show-collapse, before search filter).
 */
export function recordSectionTitleCount(category: CategoryId, count: number): SectionGrowth {
  if (!TRACKED.has(category) || !Number.isFinite(count) || count < 0) {
    return {
      yesterday: null,
      today: Math.max(0, count || 0),
      delta: null,
      newToday: 0,
    }
  }

  const today = localDateKey()
  const store = readStore()
  const days = { ...(store.days[category] ?? {}) }
  const open = { ...(store.open[category] ?? {}) }
  const n = Math.max(0, Math.round(count))

  // First visit of the calendar day becomes the baseline for "new today".
  if (typeof open[today] !== 'number') {
    open[today] = n
  }
  days[today] = n

  store.days[category] = pruneDays(days)
  store.open[category] = pruneDays(open)
  writeStore(store)

  return growthFrom(days, open, n)
}

export function getSectionGrowth(category: CategoryId, fallbackToday = 0): SectionGrowth {
  if (!TRACKED.has(category)) {
    return { yesterday: null, today: fallbackToday, delta: null, newToday: 0 }
  }
  const store = readStore()
  return growthFrom(store.days[category] ?? {}, store.open[category] ?? {}, fallbackToday)
}

/**
 * Home hero growth: "new today" is titles above yesterday's closing library size.
 * A daily sync that reloads the same catalog must not count as thousands of new titles.
 */
function catalogGrowthFrom(
  days: DayCounts,
  open: DayCounts,
  fallbackToday: number,
): SectionGrowth {
  const todayKey = localDateKey()
  const yday = yesterdayKey()
  const today = typeof days[todayKey] === 'number' ? days[todayKey] : fallbackToday
  const yesterday = typeof days[yday] === 'number' ? days[yday] : null
  const openToday = typeof open[todayKey] === 'number' ? open[todayKey] : today
  // Prefer yesterday's close. Fall back to today's settled baseline only when
  // we have no prior day (first run).
  const baseline = yesterday != null ? yesterday : openToday
  return {
    yesterday,
    today,
    delta: yesterday == null ? null : today - yesterday,
    newToday: Math.max(0, today - baseline),
  }
}

/** Snapshot the full catalog size for Home (“titles today” / “new today”). */
export function recordCatalogTitleCount(count: number): SectionGrowth {
  if (!Number.isFinite(count) || count < 0) {
    return { yesterday: null, today: 0, delta: null, newToday: 0 }
  }
  const today = localDateKey()
  const yday = yesterdayKey()
  const store = readStore()
  const days = { ...(store.catalogDays ?? {}) }
  const open = { ...(store.catalogOpen ?? {}) }
  const n = Math.max(0, Math.round(count))
  const yesterdayCount = typeof days[yday] === 'number' ? days[yday] : null

  if (typeof open[today] !== 'number') {
    // Seed baseline from yesterday when possible — not from a pre-sync partial load.
    open[today] = yesterdayCount != null ? yesterdayCount : n
  } else if (yesterdayCount != null && open[today] < yesterdayCount) {
    // Repair a cold-start baseline that was recorded before the catalog loaded.
    open[today] = yesterdayCount
  } else if (yesterdayCount == null && open[today] < n * 0.5) {
    // First tracked day: partial load became baseline; treat the filled catalog
    // as the real start so the initial sync isn't "new".
    open[today] = n
  }
  days[today] = n

  store.catalogDays = pruneDays(days)
  store.catalogOpen = pruneDays(open)
  writeStore(store)

  return catalogGrowthFrom(days, open, n)
}

export function getCatalogGrowth(fallbackToday = 0): SectionGrowth {
  const store = readStore()
  return catalogGrowthFrom(store.catalogDays ?? {}, store.catalogOpen ?? {}, fallbackToday)
}

export function formatSectionGrowth(growth: SectionGrowth): string | null {
  const t = growth.today.toLocaleString()
  if (growth.yesterday == null) {
    // First snapshot for this section — day-over-day appears next calendar day.
    return `Today ${t} titles`
  }
  const y = growth.yesterday.toLocaleString()
  return `Yesterday ${y} titles · Today ${t} titles`
}
