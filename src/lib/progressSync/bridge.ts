import type { CategoryId } from '../../types'
import type { ContinueWatchingEntry } from '../continueWatching'
import type { ProgressSyncRecord } from './types'

function isVodCategory(
  category: CategoryId | undefined,
): category is 'movies' | 'series' | 'anime' | 'kids' {
  return (
    category === 'movies' ||
    category === 'series' ||
    category === 'anime' ||
    category === 'kids'
  )
}

/** Convert a local Continue watching row into the cross-device wire format. */
export function continueEntryToSyncRecord(
  entry: ContinueWatchingEntry,
  options?: { deleted?: boolean },
): ProgressSyncRecord | null {
  if (!entry?.id || !isVodCategory(entry.category)) return null
  return {
    id: entry.id,
    title: entry.title,
    poster: entry.poster,
    category: entry.category,
    playlistIndex: entry.playlistIndex || 0,
    episodeTitle: entry.episodeTitle,
    currentTime: entry.currentTime,
    duration: entry.duration,
    runtimeSeconds: entry.runtimeSeconds,
    updatedAt: entry.updatedAt || Date.now(),
    torrentUri: entry.torrentUri,
    detailUrl: entry.detailUrl,
    playUrl: entry.playUrl,
    transport: entry.transport,
    sourceKind: entry.sourceKind,
    source: entry.source,
    deleted: options?.deleted ? true : undefined,
  }
}

/** Convert a sync record back into a Continue watching row (skips tombstones). */
export function syncRecordToContinueEntry(
  record: ProgressSyncRecord,
): ContinueWatchingEntry | null {
  if (!record?.id || record.deleted || !isVodCategory(record.category)) return null
  return {
    id: record.id,
    title: record.title || record.id,
    poster: record.poster,
    category: record.category,
    playlistIndex: Number(record.playlistIndex) || 0,
    episodeTitle: record.episodeTitle,
    currentTime: Number(record.currentTime) || 0,
    duration: Number(record.duration) || 0,
    runtimeSeconds: record.runtimeSeconds,
    updatedAt: Number(record.updatedAt) || Date.now(),
    torrentUri: record.torrentUri,
    detailUrl: record.detailUrl,
    playUrl: record.playUrl,
    transport: record.transport,
    sourceKind: record.sourceKind,
    source: record.source,
  }
}
