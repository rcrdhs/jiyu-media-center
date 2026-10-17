import { isKidsModeEnabled } from './kidsMode'
import { isShowBrowseItem } from './torrents'
import type { CategoryId, StreamItem } from '../types'

const KEY = 'jiyu.watchlist.v1'
export const WATCHLIST_EVENT = 'jiyu:watchlist'
const MAX_SAVED = 200

export interface WatchlistEntry {
  id: string
  title: string
  poster?: string
  category: CategoryId
  /** Route to open when browsing the Saved list. */
  href: string
  savedAt: number
}

function canSaveCategory(category: CategoryId): boolean {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
}

export function canSaveToWatchlist(item: Pick<StreamItem, 'category'>): boolean {
  if (!canSaveCategory(item.category)) return false
  if (isKidsModeEnabled() && item.category !== 'kids') return false
  return true
}

function readRaw(): WatchlistEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: WatchlistEntry[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const id = String((row as WatchlistEntry).id || '').trim()
      const title = String((row as WatchlistEntry).title || '').trim()
      const href = String((row as WatchlistEntry).href || '').trim()
      const category = (row as WatchlistEntry).category
      if (!id || !title || !href || !canSaveCategory(category)) continue
      out.push({
        id,
        title,
        poster: (row as WatchlistEntry).poster || undefined,
        category,
        href,
        savedAt: Number((row as WatchlistEntry).savedAt) || Date.now(),
      })
    }
    return out.slice(0, MAX_SAVED)
  } catch {
    return []
  }
}

function writeRaw(entries: WatchlistEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_SAVED)))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT))
}

function kidsFilter(entries: WatchlistEntry[]): WatchlistEntry[] {
  if (!isKidsModeEnabled()) return entries
  return entries.filter((entry) => entry.category === 'kids')
}

/** Newest saves first. */
export function getWatchlist(): WatchlistEntry[] {
  return kidsFilter(readRaw()).sort((a, b) => b.savedAt - a.savedAt)
}

export function isOnWatchlist(id: string): boolean {
  return readRaw().some((entry) => entry.id === id)
}

export function addToWatchlist(item: StreamItem): boolean {
  if (!canSaveToWatchlist(item)) return false
  const prev = readRaw().filter((entry) => entry.id !== item.id)
  const entry: WatchlistEntry = {
    id: item.id,
    title: item.title,
    poster: item.poster,
    category: item.category,
    href: isShowBrowseItem(item) ? `/show/${item.id}` : `/watch/${item.id}`,
    savedAt: Date.now(),
  }
  writeRaw([entry, ...prev])
  return true
}

export function removeFromWatchlist(id: string): boolean {
  const prev = readRaw()
  const next = prev.filter((entry) => entry.id !== id)
  if (next.length === prev.length) return false
  writeRaw(next)
  return true
}

export function toggleWatchlist(item: StreamItem): boolean {
  if (isOnWatchlist(item.id)) {
    removeFromWatchlist(item.id)
    return false
  }
  return addToWatchlist(item)
}

/**
 * Resolve saved entries against the live catalog (prefer full StreamItem).
 * Falls back to a minimal browse item so the dialog still opens.
 */
export function resolveWatchlistItems(catalog: readonly StreamItem[]): StreamItem[] {
  const byId = new Map(catalog.map((item) => [item.id, item]))
  const out: StreamItem[] = []
  for (const entry of getWatchlist()) {
    const live = byId.get(entry.id)
    if (live) {
      out.push(live)
      continue
    }
    out.push({
      id: entry.id,
      title: entry.title,
      description: '',
      category: entry.category,
      url: entry.href,
      detailUrl: entry.href,
      poster: entry.poster,
      transport: 'direct',
      sourceKind: 'builtin',
      source: 'Saved',
    })
  }
  return out
}

export function subscribeWatchlist(callback: () => void): () => void {
  const onCustom = () => callback()
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) callback()
  }
  window.addEventListener(WATCHLIST_EVENT, onCustom)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(WATCHLIST_EVENT, onCustom)
    window.removeEventListener('storage', onStorage)
  }
}
