/** Local activity history for Library (not shown on section shelves). */

const STORAGE_KEY = 'jiyu.activity.log.v1'
const MAX_ENTRIES = 200

export type ActivityKind =
  | 'sync'
  | 'playlist'
  | 'epg'
  | 'playback'
  | 'system'
  | 'error'

export interface ActivityEntry {
  id: string
  at: number
  kind: ActivityKind
  /** Safe for UI — no hostnames / site brands */
  message: string
}

function readEntries(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ActivityEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeEntries(entries: ActivityEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    /* ignore quota */
  }
}

export function listActivityLog(): ActivityEntry[] {
  return readEntries()
}

export function clearActivityLog() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function appendActivity(
  kind: ActivityKind,
  message: string,
): ActivityEntry {
  const entry: ActivityEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    kind,
    message: message.trim().slice(0, 280),
  }
  const next = [entry, ...readEntries()].slice(0, MAX_ENTRIES)
  writeEntries(next)
  return entry
}

export function formatActivityTime(at: number): string {
  try {
    return new Date(at).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}
