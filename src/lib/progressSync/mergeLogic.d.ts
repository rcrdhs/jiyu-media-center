import type { ProgressSyncRecord } from './types'

export const PROGRESS_SYNC_EPSILON_SEC: number

export function mergeProgressRecords(
  local: ProgressSyncRecord[],
  remote: ProgressSyncRecord[],
): ProgressSyncRecord[]

export function shouldAcceptIncomingProgress(
  existing: ProgressSyncRecord | null | undefined,
  incoming: ProgressSyncRecord,
): boolean
