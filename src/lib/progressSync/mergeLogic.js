/**
 * Pure merge helpers shared by the app and the progress-sync sandbox.
 * Keep this file dependency-free (no React / Capacitor / localStorage).
 */

/** @typedef {{ id: string, title?: string, playlistIndex?: number, currentTime: number, duration?: number, updatedAt: number, deleted?: boolean, [key: string]: unknown }} ProgressSyncRecord */

export const PROGRESS_SYNC_EPSILON_SEC = 20

/**
 * @param {ProgressSyncRecord[]} local
 * @param {ProgressSyncRecord[]} remote
 * @returns {ProgressSyncRecord[]}
 */
export function mergeProgressRecords(local, remote) {
  /** @type {Map<string, ProgressSyncRecord>} */
  const byId = new Map()

  /** @param {ProgressSyncRecord} row */
  const consider = (row) => {
    if (!row?.id || typeof row.id !== 'string') return
    const prev = byId.get(row.id)
    if (!prev) {
      byId.set(row.id, row)
      return
    }
    if (row.updatedAt > prev.updatedAt) {
      byId.set(row.id, row)
      return
    }
    if (row.updatedAt < prev.updatedAt) return
    if (!row.deleted && !prev.deleted) {
      if (row.currentTime > prev.currentTime) byId.set(row.id, row)
    }
  }

  for (const row of local) consider(row)
  for (const row of remote) consider(row)

  return [...byId.values()]
    .filter((row) => !row.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * @param {ProgressSyncRecord | null | undefined} existing
 * @param {ProgressSyncRecord} incoming
 */
export function shouldAcceptIncomingProgress(existing, incoming) {
  if (!existing) return !incoming.deleted
  if (incoming.updatedAt > existing.updatedAt) return true
  if (incoming.updatedAt < existing.updatedAt) return false
  if (incoming.deleted) return true
  if (existing.deleted) return true
  return incoming.currentTime >= existing.currentTime - PROGRESS_SYNC_EPSILON_SEC
}
