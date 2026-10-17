import type { ProgressSyncRecord } from './types'

export {
  mergeProgressRecords,
  shouldAcceptIncomingProgress,
  PROGRESS_SYNC_EPSILON_SEC,
} from './mergeLogic.js'

export function progressRecordsEqual(
  a: ProgressSyncRecord,
  b: ProgressSyncRecord,
): boolean {
  return (
    a.id === b.id &&
    a.playlistIndex === b.playlistIndex &&
    Math.abs(a.currentTime - b.currentTime) < 0.5 &&
    a.updatedAt === b.updatedAt &&
    Boolean(a.deleted) === Boolean(b.deleted)
  )
}
