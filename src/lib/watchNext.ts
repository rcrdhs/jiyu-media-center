import { isKidsModeEnabled } from './kidsMode'
import { isShowBrowseItem } from './torrents'
import type { CategoryId, StreamItem } from '../types'

const KEY = 'jiyu.watchNext.v1'
export const WATCH_NEXT_EVENT = 'jiyu:watch-next'

export interface WatchNextEntry {
  id: string
  title: string
  poster?: string
  category: CategoryId
  /** Route to open when this title should play. */
  href: string
  queuedAt: number
}

function canQueueCategory(category: CategoryId): boolean {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
}

export function canQueueWatchNext(item: Pick<StreamItem, 'category'>): boolean {
  if (!canQueueCategory(item.category)) return false
  if (isKidsModeEnabled() && item.category !== 'kids') return false
  return true
}

function readRaw(): WatchNextEntry | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WatchNextEntry
    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.href) return null
    return parsed
  } catch {
    return null
  }
}

function writeRaw(entry: WatchNextEntry | null) {
  try {
    if (!entry) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(entry))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(WATCH_NEXT_EVENT, { detail: entry }))
}

export function getWatchNext(): WatchNextEntry | null {
  const entry = readRaw()
  if (!entry) return null
  if (isKidsModeEnabled() && entry.category !== 'kids') {
    writeRaw(null)
    return null
  }
  return entry
}

/** Replace the single queue slot. Returns false if the item can't be queued. */
export function setWatchNext(item: StreamItem): boolean {
  if (!canQueueWatchNext(item)) return false
  const entry: WatchNextEntry = {
    id: item.id,
    title: item.title,
    poster: item.poster,
    category: item.category,
    href: isShowBrowseItem(item) ? `/show/${item.id}` : `/watch/${item.id}`,
    queuedAt: Date.now(),
  }
  writeRaw(entry)
  return true
}

export function clearWatchNext() {
  writeRaw(null)
}

/** Read and clear the slot (for end-of-title handoff). */
export function takeWatchNext(): WatchNextEntry | null {
  const entry = getWatchNext()
  if (entry) writeRaw(null)
  return entry
}

export function isWatchNext(id: string): boolean {
  return getWatchNext()?.id === id
}

export function subscribeWatchNext(callback: (entry: WatchNextEntry | null) => void): () => void {
  const onCustom = () => callback(getWatchNext())
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) callback(getWatchNext())
  }
  window.addEventListener(WATCH_NEXT_EVENT, onCustom)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(WATCH_NEXT_EVENT, onCustom)
    window.removeEventListener('storage', onStorage)
  }
}
