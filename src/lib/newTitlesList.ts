import type { CategoryId, StreamItem } from '../types'
import {
  getCatalogNewTitleIds,
  getSectionNewTitleIds,
  type NewTitlesKind,
} from './libraryGrowth'

/**
 * Resolve tracked new-title ids to catalog rows.
 * "Added today" is shelf-first-seen only — never pad with release-date / popularity.
 */
export function resolveNewTitleItems(
  pool: StreamItem[],
  ids: string[],
  _kind: NewTitlesKind,
  category?: CategoryId,
  limit?: number,
): StreamItem[] {
  if (!ids.length) return []
  const want = limit != null && limit > 0 ? limit : ids.length
  const idSet = new Set(ids)
  const byId = new Map<string, StreamItem>()
  for (const item of pool) {
    if (!idSet.has(item.id)) continue
    if (category && item.category !== category) continue
    byId.set(item.id, item)
  }
  // Preserve first-seen order from the growth store.
  const matched: StreamItem[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) continue
    matched.push(item)
    if (matched.length >= want) break
  }
  return matched
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
