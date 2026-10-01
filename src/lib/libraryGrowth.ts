import type { CategoryId } from '../types'

const STORAGE_KEY = 'jiyu.library.growth.v1'
const TRACKED = new Set<CategoryId>(['movies', 'series', 'anime', 'kids'])

type DayCounts = Record<string, number> // YYYY-MM-DD → title count
type IdDayMap = Record<string, string[]> // YYYY-MM-DD → catalog item ids

/** Current end-of-day (latest) counts, plus first count seen that calendar day. */
type GrowthStore = {
  days: Partial<Record<CategoryId, DayCounts>>
  open: Partial<Record<CategoryId, DayCounts>>
  /** Whole-catalog totals for the Home hero panel. */
  catalogDays?: DayCounts
  catalogOpen?: DayCounts
  sectionOpenIds?: Partial<Record<CategoryId, IdDayMap>>
  sectionCloseIds?: Partial<Record<CategoryId, IdDayMap>>
  sectionNewIds?: Partial<Record<CategoryId, IdDayMap>>
  catalogOpenIds?: IdDayMap
  catalogCloseIds?: IdDayMap
  catalogNewIds?: IdDayMap
}

export type NewTitlesKind = 'today' | 'sinceYesterday'

export type GrowthIdMeta = { id: string; releasedAt?: number }

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
  return {
    days: {},
    open: {},
    catalogDays: {},
    catalogOpen: {},
    sectionOpenIds: {},
    sectionCloseIds: {},
    sectionNewIds: {},
    catalogOpenIds: {},
    catalogCloseIds: {},
    catalogNewIds: {},
  }
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
      sectionOpenIds:
        store.sectionOpenIds && typeof store.sectionOpenIds === 'object'
          ? store.sectionOpenIds
          : {},
      sectionCloseIds:
        store.sectionCloseIds && typeof store.sectionCloseIds === 'object'
          ? store.sectionCloseIds
          : {},
      sectionNewIds:
        store.sectionNewIds && typeof store.sectionNewIds === 'object'
          ? store.sectionNewIds
          : {},
      catalogOpenIds:
        store.catalogOpenIds && typeof store.catalogOpenIds === 'object'
          ? store.catalogOpenIds
          : {},
      catalogCloseIds:
        store.catalogCloseIds && typeof store.catalogCloseIds === 'object'
          ? store.catalogCloseIds
          : {},
      catalogNewIds:
        store.catalogNewIds && typeof store.catalogNewIds === 'object'
          ? store.catalogNewIds
          : {},
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
function pruneIdDays(days: IdDayMap, keep = 14): IdDayMap {
  const keys = Object.keys(days).sort()
  if (keys.length <= keep) return days
  const next: IdDayMap = {}
  for (const key of keys.slice(-keep)) next[key] = days[key]
  return next
}

/** Local midnight for release-date fallback when id snapshots are missing. */
export function startOfLocalDayMs(from = new Date()): number {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function seedIdsFromCountBaseline(
  ids: string[],
  meta: GrowthIdMeta[],
  countBaseline: number,
): { openIds: string[]; newIds: string[] } {
  if (ids.length <= countBaseline || countBaseline < 0) {
    return { openIds: [...ids], newIds: [] }
  }
  const newCount = Math.min(ids.length - countBaseline, meta.length)
  if (newCount <= 0) {
    return { openIds: [...ids], newIds: [] }
  }
  const byId = new Map(meta.map((m) => [m.id, m.releasedAt ?? 0]))
  const sorted = [...ids].sort((a, b) => (byId.get(b) ?? 0) - (byId.get(a) ?? 0))
  const newIds = sorted.slice(0, newCount)
  const newSet = new Set(newIds)
  return {
    openIds: ids.filter((id) => !newSet.has(id)),
    newIds,
  }
}

function applyIdSnapshot(
  ids: string[],
  today: string,
  meta: GrowthIdMeta[] | undefined,
  countBaseline: number | undefined,
  openIdMap: IdDayMap,
  closeIdMap: IdDayMap,
  newIdMap: IdDayMap,
): void {
  if (!ids.length) return
  closeIdMap[today] = [...ids]

  const canSeed =
    Boolean(meta?.length) &&
    countBaseline != null &&
    ids.length > countBaseline

  if (!Array.isArray(openIdMap[today])) {
    if (canSeed) {
      const seeded = seedIdsFromCountBaseline(ids, meta!, countBaseline!)
      openIdMap[today] = seeded.openIds
      if (seeded.newIds.length) newIdMap[today] = seeded.newIds
    } else {
      openIdMap[today] = [...ids]
    }
  } else if (!newIdMap[today]?.length && canSeed) {
    // Repair when open ids wrongly matched the full catalog on first snapshot.
    const seeded = seedIdsFromCountBaseline(ids, meta!, countBaseline!)
    openIdMap[today] = seeded.openIds
    if (seeded.newIds.length) newIdMap[today] = seeded.newIds
  }

  const openSet = new Set(openIdMap[today] ?? ids)
  const seenNew = new Set(newIdMap[today] ?? [])
  for (const id of ids) {
    if (!openSet.has(id)) seenNew.add(id)
  }
  if (seenNew.size > 0) {
    newIdMap[today] = [...seenNew]
  }
}

function snapshotSectionIds(
  store: GrowthStore,
  category: CategoryId,
  meta: GrowthIdMeta[],
  today: string,
  countBaseline: number | undefined,
): void {
  const ids = meta.map((m) => m.id).filter(Boolean)
  if (!ids.length) return
  const openIdMap = { ...(store.sectionOpenIds?.[category] ?? {}) }
  const closeIdMap = { ...(store.sectionCloseIds?.[category] ?? {}) }
  const newIdMap = { ...(store.sectionNewIds?.[category] ?? {}) }

  applyIdSnapshot(ids, today, meta, countBaseline, openIdMap, closeIdMap, newIdMap)

  store.sectionOpenIds = {
    ...store.sectionOpenIds,
    [category]: pruneIdDays(openIdMap),
  }
  store.sectionCloseIds = {
    ...store.sectionCloseIds,
    [category]: pruneIdDays(closeIdMap),
  }
  store.sectionNewIds = {
    ...store.sectionNewIds,
    [category]: pruneIdDays(newIdMap),
  }
}

function snapshotCatalogIds(
  store: GrowthStore,
  meta: GrowthIdMeta[],
  today: string,
  countBaseline: number | undefined,
): void {
  const ids = meta.map((m) => m.id).filter(Boolean)
  if (!ids.length) return
  const openIdMap = { ...(store.catalogOpenIds ?? {}) }
  const closeIdMap = { ...(store.catalogCloseIds ?? {}) }
  const newIdMap = { ...(store.catalogNewIds ?? {}) }

  applyIdSnapshot(ids, today, meta, countBaseline, openIdMap, closeIdMap, newIdMap)

  store.catalogOpenIds = pruneIdDays(openIdMap)
  store.catalogCloseIds = pruneIdDays(closeIdMap)
  store.catalogNewIds = pruneIdDays(newIdMap)
}

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
export function recordSectionTitleCount(
  category: CategoryId,
  count: number,
  meta?: GrowthIdMeta[],
): SectionGrowth {
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

  if (meta?.length) {
    snapshotSectionIds(store, category, meta, today, open[today])
  }

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
export function recordCatalogTitleCount(count: number, meta?: GrowthIdMeta[]): SectionGrowth {
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

  if (meta?.length) {
    snapshotCatalogIds(store, meta, today, open[today])
  }

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

export function getSectionNewTitleIds(
  category: CategoryId,
  kind: NewTitlesKind,
): string[] {
  if (!TRACKED.has(category)) return []
  const store = readStore()
  const today = localDateKey()
  const yday = yesterdayKey()

  if (kind === 'today') {
    const tracked = store.sectionNewIds?.[category]?.[today]
    if (tracked?.length) return tracked
    const open = store.sectionOpenIds?.[category]?.[today] ?? []
    const close = store.sectionCloseIds?.[category]?.[today] ?? []
    if (!close.length) return []
    const openSet = new Set(open)
    return close.filter((id) => !openSet.has(id))
  }

  const yesterdayClose = store.sectionCloseIds?.[category]?.[yday] ?? []
  const todayClose = store.sectionCloseIds?.[category]?.[today] ?? []
  if (!yesterdayClose.length || !todayClose.length) return []
  const ySet = new Set(yesterdayClose)
  return todayClose.filter((id) => !ySet.has(id))
}

export function getCatalogNewTitleIds(kind: NewTitlesKind): string[] {
  const store = readStore()
  const today = localDateKey()
  const yday = yesterdayKey()

  if (kind === 'today') {
    const tracked = store.catalogNewIds?.[today]
    if (tracked?.length) return tracked
    const open = store.catalogOpenIds?.[today] ?? []
    const close = store.catalogCloseIds?.[today] ?? []
    if (!close.length) return []
    const openSet = new Set(open)
    return close.filter((id) => !openSet.has(id))
  }

  const yesterdayClose = store.catalogCloseIds?.[yday] ?? []
  const todayClose = store.catalogCloseIds?.[today] ?? []
  if (!yesterdayClose.length || !todayClose.length) return []
  const ySet = new Set(yesterdayClose)
  return todayClose.filter((id) => !ySet.has(id))
}
