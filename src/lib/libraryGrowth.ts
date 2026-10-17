import type { CategoryId } from '../types'

/** Bumped to v2 — v1 mixed release-date heuristics into "Added today". */
const STORAGE_KEY = 'jiyu.library.growth.v2'
const KNOWN_KEY = 'jiyu.library.known.v2'
const TRACKED = new Set<CategoryId>(['movies', 'series', 'anime', 'kids'])
/** Cap persisted new-id lists — full open/close snapshots blow Android localStorage. */
const MAX_NEW_IDS = 400
const MAX_KNOWN_IDS = 40_000

type DayCounts = Record<string, number> // YYYY-MM-DD → title count
type IdDayMap = Record<string, string[]> // YYYY-MM-DD → catalog item ids

/**
 * Shelf growth store.
 * "Added today" = titles whose id was first seen on this local calendar day
 * (first appearance on a shelf), not content release date / popularity rank.
 */
type GrowthStore = {
  days: Partial<Record<CategoryId, DayCounts>>
  open: Partial<Record<CategoryId, DayCounts>>
  catalogDays?: DayCounts
  catalogOpen?: DayCounts
  /** Ids first observed on each calendar day (authoritative for Added today). */
  sectionNewIds?: Partial<Record<CategoryId, IdDayMap>>
  catalogNewIds?: IdDayMap
  /**
   * After a cold install / v2 migrate we seed every current id as already-known
   * so the whole library isn't dumped into Added today.
   */
  knownSeeded?: boolean
}

export type NewTitlesKind = 'today' | 'sinceYesterday'

export type GrowthIdMeta = { id: string; releasedAt?: number }

export type SectionGrowth = {
  yesterday: number | null
  today: number
  /** today − yesterday, when yesterday was recorded */
  delta: number | null
  /** Titles first added to a shelf on this local calendar day */
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
    sectionNewIds: {},
    catalogNewIds: {},
    knownSeeded: false,
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

function capIdDays(days: IdDayMap | undefined, max = MAX_NEW_IDS): IdDayMap {
  const next: IdDayMap = {}
  for (const [day, ids] of Object.entries(days ?? {})) {
    if (!Array.isArray(ids) || ids.length === 0) continue
    next[day] = ids.length > max ? ids.slice(0, max) : ids
  }
  return pruneIdDays(next)
}

function pruneDays(days: DayCounts, keep = 14): DayCounts {
  const keys = Object.keys(days).sort()
  if (keys.length <= keep) return days
  const next: DayCounts = {}
  for (const key of keys.slice(-keep)) next[key] = days[key]
  return next
}

function slimStore(store: GrowthStore): GrowthStore {
  const sectionNewIds: Partial<Record<CategoryId, IdDayMap>> = {}
  for (const [key, map] of Object.entries(store.sectionNewIds ?? {})) {
    sectionNewIds[key as CategoryId] = capIdDays(map)
  }
  return {
    days: store.days ?? {},
    open: store.open ?? {},
    catalogDays: store.catalogDays ?? {},
    catalogOpen: store.catalogOpen ?? {},
    sectionNewIds,
    catalogNewIds: capIdDays(store.catalogNewIds),
    knownSeeded: Boolean(store.knownSeeded),
  }
}

function readStore(): GrowthStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    if (raw.length > 1_500_000) {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }
      return emptyStore()
    }
    const parsed = JSON.parse(raw) as GrowthStore
    if (!parsed || typeof parsed !== 'object') return emptyStore()
    return slimStore({
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      open: parsed.open && typeof parsed.open === 'object' ? parsed.open : {},
      catalogDays:
        parsed.catalogDays && typeof parsed.catalogDays === 'object' ? parsed.catalogDays : {},
      catalogOpen:
        parsed.catalogOpen && typeof parsed.catalogOpen === 'object' ? parsed.catalogOpen : {},
      sectionNewIds:
        parsed.sectionNewIds && typeof parsed.sectionNewIds === 'object'
          ? parsed.sectionNewIds
          : {},
      catalogNewIds:
        parsed.catalogNewIds && typeof parsed.catalogNewIds === 'object'
          ? parsed.catalogNewIds
          : {},
      knownSeeded: Boolean(parsed.knownSeeded),
    })
  } catch {
    return emptyStore()
  }
}

function writeStore(store: GrowthStore) {
  const slim = slimStore(store)
  try {
    // Drop the v1 blob (release-date heuristics) so Android quota stays free.
    localStorage.removeItem('jiyu.library.growth.v1')
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
    return
  } catch {
    /* quota — keep counts + today's new ids only */
  }
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        days: slim.days,
        open: slim.open,
        catalogDays: slim.catalogDays,
        catalogOpen: slim.catalogOpen,
        catalogNewIds: slim.catalogNewIds,
        sectionNewIds: slim.sectionNewIds,
        knownSeeded: slim.knownSeeded,
      }),
    )
  } catch {
    /* ignore */
  }
}

/** Ids we have already seen on a shelf (any day). */
function readKnownIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KNOWN_KEY)
    if (!raw) return new Set()
    if (raw.length > 2_500_000) {
      try {
        localStorage.removeItem(KNOWN_KEY)
      } catch {
        /* ignore */
      }
      return new Set()
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch {
    return new Set()
  }
}

function writeKnownIds(known: Set<string>) {
  let ids = [...known]
  if (ids.length > MAX_KNOWN_IDS) {
    // Drop oldest-looking entries (stable sort keeps recent appends if we ever switch).
    ids = ids.slice(ids.length - MAX_KNOWN_IDS)
  }
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(ids))
  } catch {
    /* quota — keep going with in-memory known for this session via callers */
  }
}

/** Local midnight for date helpers. */
export function startOfLocalDayMs(from = new Date()): number {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Diff current shelf ids against the known set.
 * Catalog does the one-time seed (whole library = already known).
 * Sections wait for that seed so a Movies visit can't mark Series as "new".
 */
function observeNewIds(
  store: GrowthStore,
  meta: GrowthIdMeta[],
  priorToday: string[] | undefined,
  mode: 'section' | 'catalog',
): { store: GrowthStore; newIds: string[] } {
  const ids = meta.map((m) => m.id).filter(Boolean)
  if (!ids.length) return { store, newIds: priorToday ?? [] }

  const known = readKnownIds()
  // Repair: anything we already logged as new on a prior day counts as known.
  for (const dayIds of Object.values(store.catalogNewIds ?? {})) {
    for (const id of dayIds ?? []) known.add(id)
  }
  for (const map of Object.values(store.sectionNewIds ?? {})) {
    for (const dayIds of Object.values(map ?? {})) {
      for (const id of dayIds ?? []) known.add(id)
    }
  }

  if (!store.knownSeeded) {
    if (mode === 'catalog') {
      for (const id of ids) known.add(id)
      writeKnownIds(known)
      return {
        store: { ...store, knownSeeded: true },
        // Do not dump the whole library into Added today on first seed.
        newIds: [],
      }
    }
    // Section before Home has seeded — don't invent "new" titles yet.
    return { store, newIds: [] }
  }

  const seenToday = new Set(priorToday ?? [])
  const newly: string[] = []
  for (const id of ids) {
    if (known.has(id)) continue
    known.add(id)
    if (!seenToday.has(id)) {
      seenToday.add(id)
      newly.push(id)
    }
  }
  if (newly.length) writeKnownIds(known)

  const merged = [...(priorToday ?? []), ...newly]
  const dedup: string[] = []
  const have = new Set<string>()
  for (const id of merged) {
    if (have.has(id)) continue
    have.add(id)
    dedup.push(id)
  }
  return { store: { ...store, knownSeeded: true }, newIds: dedup.slice(0, MAX_NEW_IDS) }
}

function growthFrom(
  days: DayCounts,
  fallbackToday: number,
  newToday: number,
): SectionGrowth {
  const todayKey = localDateKey()
  const yday = yesterdayKey()
  const today = typeof days[todayKey] === 'number' ? days[todayKey] : fallbackToday
  const yesterday = typeof days[yday] === 'number' ? days[yday] : null
  return {
    yesterday,
    today,
    delta: yesterday == null ? null : today - yesterday,
    newToday: Math.max(0, newToday),
  }
}

export function isGrowthTrackedSection(id: CategoryId): boolean {
  return TRACKED.has(id)
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
  let store = readStore()
  const days = { ...(store.days[category] ?? {}) }
  const open = { ...(store.open[category] ?? {}) }
  const n = Math.max(0, Math.round(count))

  if (typeof open[today] !== 'number') {
    open[today] = n
  }
  days[today] = n

  if (meta?.length) {
    const prior = store.sectionNewIds?.[category]?.[today]
    const observed = observeNewIds(store, meta, prior, 'section')
    store = observed.store
    const newIdMap = { ...(store.sectionNewIds?.[category] ?? {}) }
    newIdMap[today] = observed.newIds
    store.sectionNewIds = {
      ...store.sectionNewIds,
      [category]: pruneIdDays(newIdMap),
    }
  }

  store.days[category] = pruneDays(days)
  store.open[category] = pruneDays(open)
  writeStore(store)

  const newToday = store.sectionNewIds?.[category]?.[today]?.length ?? 0
  return growthFrom(days, n, newToday)
}

export function getSectionGrowth(category: CategoryId, fallbackToday = 0): SectionGrowth {
  if (!TRACKED.has(category)) {
    return { yesterday: null, today: fallbackToday, delta: null, newToday: 0 }
  }
  const store = readStore()
  const today = localDateKey()
  const newToday = store.sectionNewIds?.[category]?.[today]?.length ?? 0
  return growthFrom(store.days[category] ?? {}, fallbackToday, newToday)
}

/** Snapshot the full catalog size for Home (“titles today” / “Added today”). */
export function recordCatalogTitleCount(count: number, meta?: GrowthIdMeta[]): SectionGrowth {
  if (!Number.isFinite(count) || count < 0) {
    return { yesterday: null, today: 0, delta: null, newToday: 0 }
  }
  const today = localDateKey()
  let store = readStore()
  const days = { ...(store.catalogDays ?? {}) }
  const open = { ...(store.catalogOpen ?? {}) }
  const n = Math.max(0, Math.round(count))
  const yday = yesterdayKey()
  const yesterdayCount = typeof days[yday] === 'number' ? days[yday] : null

  if (typeof open[today] !== 'number') {
    open[today] = yesterdayCount != null ? yesterdayCount : n
  } else if (yesterdayCount != null && open[today] < yesterdayCount) {
    open[today] = yesterdayCount
  } else if (yesterdayCount == null && open[today] < n * 0.5) {
    open[today] = n
  }
  days[today] = n

  if (meta?.length) {
    const prior = store.catalogNewIds?.[today]
    const observed = observeNewIds(store, meta, prior, 'catalog')
    store = observed.store
    const newIdMap = { ...(store.catalogNewIds ?? {}) }
    newIdMap[today] = observed.newIds
    store.catalogNewIds = pruneIdDays(newIdMap)
  }

  store.catalogDays = pruneDays(days)
  store.catalogOpen = pruneDays(open)
  writeStore(store)

  const newToday = store.catalogNewIds?.[today]?.length ?? 0
  return growthFrom(days, n, newToday)
}

export function getCatalogGrowth(fallbackToday = 0): SectionGrowth {
  const store = readStore()
  const today = localDateKey()
  const newToday = store.catalogNewIds?.[today]?.length ?? 0
  return growthFrom(store.catalogDays ?? {}, fallbackToday, newToday)
}

export function formatSectionGrowth(growth: SectionGrowth): string | null {
  const t = growth.today.toLocaleString()
  if (growth.yesterday == null) {
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
    return store.sectionNewIds?.[category]?.[today] ?? []
  }

  const todayNew = store.sectionNewIds?.[category]?.[today] ?? []
  const ydayNew = store.sectionNewIds?.[category]?.[yday] ?? []
  if (!todayNew.length && !ydayNew.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...todayNew, ...ydayNew]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function getCatalogNewTitleIds(kind: NewTitlesKind): string[] {
  const store = readStore()
  const today = localDateKey()
  const yday = yesterdayKey()

  if (kind === 'today') {
    return store.catalogNewIds?.[today] ?? []
  }

  const todayNew = store.catalogNewIds?.[today] ?? []
  const ydayNew = store.catalogNewIds?.[yday] ?? []
  if (!todayNew.length && !ydayNew.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...todayNew, ...ydayNew]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
