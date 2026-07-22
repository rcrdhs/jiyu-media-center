export type PlaylistKind = 'file' | 'paste' | 'url' | 'iptv'

export interface PlaylistSource {
  id: string
  kind: PlaylistKind
  label: string
  /** Remote playlist URL when kind === 'url' */
  url?: string
  content: string
  addedAt: number
  itemCount: number
}

const DB_NAME = 'signal-catalog'
const DB_VERSION = 1
const STORE = 'playlists'
const LEGACY_KEY = 'signal.imported.m3u'

function hasDesktopCatalog() {
  return Boolean(window.signalDesktop?.catalogList)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

async function listFromIdb(): Promise<PlaylistSource[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result as PlaylistSource[]) ?? []
      rows.sort((a, b) => a.addedAt - b.addedAt)
      resolve(rows)
    }
    req.onerror = () => reject(req.error ?? new Error('Failed to list playlists'))
  })
}

async function putInIdb(source: PlaylistSource): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put(source)
  await txDone(tx)
}

async function deleteInIdb(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  await txDone(tx)
}

async function clearIdb(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await txDone(tx)
}

/**
 * Prefer Electron userData file storage (survives host/origin changes).
 * Fall back to IndexedDB in the browser.
 */
export async function listPlaylistSources(): Promise<PlaylistSource[]> {
  if (hasDesktopCatalog()) {
    const rows = (await window.signalDesktop!.catalogList!()) as PlaylistSource[]
    rows.sort((a, b) => a.addedAt - b.addedAt)
    return rows
  }
  return listFromIdb()
}

export async function putPlaylistSource(source: PlaylistSource): Promise<void> {
  if (hasDesktopCatalog()) {
    await window.signalDesktop!.catalogPut!(source)
    return
  }
  await putInIdb(source)
}

export async function deletePlaylistSource(id: string): Promise<void> {
  if (hasDesktopCatalog()) {
    await window.signalDesktop!.catalogDelete!(id)
    return
  }
  await deleteInIdb(id)
}

export async function clearPlaylistSources(): Promise<void> {
  if (hasDesktopCatalog()) {
    await window.signalDesktop!.catalogClear!()
  } else {
    await clearIdb()
  }
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* ignore */
  }
}

async function replaceAllSources(sources: PlaylistSource[]): Promise<void> {
  if (hasDesktopCatalog()) {
    await window.signalDesktop!.catalogReplaceAll!(sources)
    return
  }
  await clearIdb()
  for (const source of sources) await putInIdb(source)
}

/**
 * Recover playlists lost when switching localhost ↔ 127.0.0.1,
 * and migrate browser IndexedDB into durable Electron storage.
 */
export async function migrateLegacyPlaylist(
  parseCount: (content: string) => number,
): Promise<boolean> {
  let migrated = false

  // 1) Electron disk empty? Pull from IndexedDB on this origin (e.g. localhost recovery)
  if (hasDesktopCatalog()) {
    const disk = await listPlaylistSources()
    if (disk.length === 0) {
      try {
        const idbRows = await listFromIdb()
        if (idbRows.length > 0) {
          await replaceAllSources(idbRows)
          migrated = true
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Very old localStorage single-playlist format
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    raw = null
  }
  if (raw) {
    const existing = await listPlaylistSources()
    if (existing.length === 0) {
      const source: PlaylistSource = {
        id: `legacy-${Date.now().toString(36)}`,
        kind: 'paste',
        label: 'Legacy import',
        content: raw,
        addedAt: Date.now(),
        itemCount: parseCount(raw),
      }
      await putPlaylistSource(source)
      migrated = true
    }
    try {
      localStorage.removeItem(LEGACY_KEY)
    } catch {
      /* ignore */
    }
  }

  return migrated
}

export function newSourceId(): string {
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
