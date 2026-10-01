import type { CategoryId, StreamItem } from '../types'
import {
  getCatalogNewTitleIds,
  getSectionNewTitleIds,
  type NewTitlesKind,
} from './libraryGrowth'

function newestInPool(pool: StreamItem[], category?: CategoryId, limit?: number): StreamItem[] {
  const scoped = category ? pool.filter((item) => item.category === category) : [...pool]
  scoped.sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0))
  if (limit != null && limit > 0) {
    return scoped.slice(0, limit)
  }
  return scoped
}

/** Resolve tracked new-title ids to catalog rows. */
export function resolveNewTitleItems(
  pool: StreamItem[],
  ids: string[],
  _kind: NewTitlesKind,
  category?: CategoryId,
  limit?: number,
): StreamItem[] {
  const idSet = new Set(ids)
  let matched = pool.filter((item) => idSet.has(item.id))
  if (matched.length > 0) {
    matched.sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0))
    if (limit != null && limit > 0 && matched.length > limit) {
      return matched.slice(0, limit)
    }
    return matched
  }

  // No id snapshot yet — approximate with the newest titles, capped to the growth count.
  if (limit != null && limit > 0) {
    return newestInPool(pool, category, limit)
  }
  return []
}

export function sectionNewTitleItems(
  category: CategoryId,
  pool: StreamItem[],
  kind: NewTitlesKind,
  limit?: number,
): StreamItem[] {
  return resolveNewTitleItems(
    pool,
    getSectionNewTitleIds(category, kind),
    kind,
    category,
    limit,
  )
}

export function catalogNewTitleItems(
  pool: StreamItem[],
  kind: NewTitlesKind,
  limit?: number,
): StreamItem[] {
  return resolveNewTitleItems(pool, getCatalogNewTitleIds(kind), kind, undefined, limit)
}
