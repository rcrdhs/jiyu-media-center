import type { StreamItem } from '../types'

const DB_NAME = 'jiyu-torrent-catalog'
const DB_VERSION = 1
const STORE = 'items'
const META_KEY = 'jiyu.torrent.catalog.meta'

export interface TorrentCatalogMeta {
  lastSyncAt: number
  /** Version of the scraping adapters used for the last sync */
  scraperVersion?: number
  bySource: Record<string, { syncedAt: number; count: number }>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('torrentSourceId', 'torrentSourceId', { unique: false })
        store.createIndex('category', 'category', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Torrent catalog DB open failed'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Torrent catalog transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Torrent catalog transaction aborted'))
  })
}

export async function listTorrentCatalog(): Promise<StreamItem[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve((req.result as StreamItem[]) ?? [])
    req.onerror = () => reject(req.error ?? new Error('Failed to list torrent catalog'))
  })
}

export async function upsertTorrentItems(items: StreamItem[]): Promise<number> {
  if (items.length === 0) return 0
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const item of items) store.put(item)
  await txDone(tx)
  return items.length
}

export async function deleteTorrentItemsForSource(sourceId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const index = store.index('torrentSourceId')
  const req = index.getAllKeys(sourceId)
  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key)
      resolve()
    }
    req.onerror = () => reject(req.error ?? new Error('Failed to delete source items'))
  })
  await txDone(tx)
}

export async function clearTorrentCatalog(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await txDone(tx)
  try {
    localStorage.removeItem(META_KEY)
  } catch {
    /* ignore */
  }
}

export function loadTorrentCatalogMeta(): TorrentCatalogMeta {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return { lastSyncAt: 0, bySource: {} }
    const parsed = JSON.parse(raw) as TorrentCatalogMeta
    return {
      lastSyncAt: parsed.lastSyncAt ?? 0,
      scraperVersion: parsed.scraperVersion,
      bySource: parsed.bySource ?? {},
    }
  } catch {
    return { lastSyncAt: 0, bySource: {} }
  }
}

export function saveTorrentCatalogMeta(meta: TorrentCatalogMeta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta))
}

export function stableTorrentItemId(detailUrl: string): string {
  let h = 0
  for (let i = 0; i < detailUrl.length; i++) h = (h * 31 + detailUrl.charCodeAt(i)) | 0
  return `torrent-${Math.abs(h).toString(36)}`
}
