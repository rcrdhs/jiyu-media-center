/**
 * On-Device Habit-Based Intro & Recap Skip Learning Engine.
 *
 * Observes user seek forward jumps during the prologue/intro phase of episodes
 * (first 5 minutes) across sessions. When repeated seek patterns are detected
 * for the same show (e.g. jumping from ~15s to ~105s across 2+ episodes),
 * it establishes a learned skip interval with high confidence.
 */

import type { AnimeSkipInterval } from './animeSkip'

const STORAGE_KEY = 'jiyu.learned.skips.v1'
const RAW_EVENTS_KEY = 'jiyu.learned.skips.events.v1'

const MIN_INTRO_SEEK_DELTA = 35 // Seconds (minimum meaningful intro jump)
const MAX_INTRO_SEEK_DELTA = 140 // Seconds (maximum intro jump)
const MAX_INTRO_START_TIME = 260 // Seconds into episode where intro can start
const MAX_INTRO_END_TIME = 360 // Seconds into episode where intro can end
const CLUSTER_TOLERANCE_SEC = 15 // Seconds tolerance to cluster jumps

export interface LearnedSkipWindow {
  showKey: string
  startTime: number
  endTime: number
  confidence: number // 0.0 to 1.0
  sampleCount: number
  updatedAt: number
}

interface StoredSeekEvent {
  fromTime: number
  toTime: number
  timestamp: number
}

function loadLearnedMap(): Record<string, LearnedSkipWindow> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, LearnedSkipWindow>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveLearnedMap(map: Record<string, LearnedSkipWindow>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore storage quota */
  }
}

function loadRawEventsMap(): Record<string, StoredSeekEvent[]> {
  try {
    const raw = localStorage.getItem(RAW_EVENTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, StoredSeekEvent[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveRawEventsMap(map: Record<string, StoredSeekEvent[]>) {
  try {
    localStorage.setItem(RAW_EVENTS_KEY, JSON.stringify(map))
  } catch {
    /* ignore storage quota */
  }
}

/**
 * Record a user forward seek jump. If it fits an intro-skipping pattern,
 * logs it and triggers 1D clustering to potentially establish a learned skip.
 */
export function recordUserSeekJump(
  showKey: string,
  fromTime: number,
  toTime: number,
): LearnedSkipWindow | null {
  const cleanKey = String(showKey || '').trim().toLowerCase()
  if (!cleanKey) return null

  const delta = toTime - fromTime
  // Must be a forward jump within the prologue / intro window of an episode
  if (
    delta < MIN_INTRO_SEEK_DELTA ||
    delta > MAX_INTRO_SEEK_DELTA ||
    fromTime < 0 ||
    fromTime > MAX_INTRO_START_TIME ||
    toTime > MAX_INTRO_END_TIME
  ) {
    return null
  }

  const eventsMap = loadRawEventsMap()
  const history = eventsMap[cleanKey] || []
  const newEvent: StoredSeekEvent = {
    fromTime: Math.round(fromTime),
    toTime: Math.round(toTime),
    timestamp: Date.now(),
  }

  // Keep last 15 raw events per show
  const updatedHistory = [...history.slice(-14), newEvent]
  eventsMap[cleanKey] = updatedHistory
  saveRawEventsMap(eventsMap)

  // Run 1D clustering on the seek events
  return clusterSeeks(cleanKey, updatedHistory)
}

/**
 * Find clusters of similar seeks within CLUSTER_TOLERANCE_SEC.
 * If 2 or more jumps match, a consensus skip window is saved.
 */
function clusterSeeks(showKey: string, events: StoredSeekEvent[]): LearnedSkipWindow | null {
  if (events.length < 2) return null

  // Find candidate clusters
  let bestCluster: StoredSeekEvent[] = []

  for (let i = 0; i < events.length; i += 1) {
    const anchor = events[i]
    const cluster = events.filter(
      (e) =>
        Math.abs(e.fromTime - anchor.fromTime) <= CLUSTER_TOLERANCE_SEC &&
        Math.abs(e.toTime - anchor.toTime) <= CLUSTER_TOLERANCE_SEC,
    )
    if (cluster.length > bestCluster.length) {
      bestCluster = cluster
    }
  }

  if (bestCluster.length >= 2) {
    const avgFrom = Math.round(
      bestCluster.reduce((sum, e) => sum + e.fromTime, 0) / bestCluster.length,
    )
    const avgTo = Math.round(
      bestCluster.reduce((sum, e) => sum + e.toTime, 0) / bestCluster.length,
    )

    if (avgTo > avgFrom + 20) {
      const learnedMap = loadLearnedMap()
      const sampleCount = bestCluster.length
      const confidence = Number(
        Math.min(0.99, 0.65 + (sampleCount - 2) * 0.1).toFixed(2),
      )

      const window: LearnedSkipWindow = {
        showKey,
        startTime: avgFrom,
        endTime: avgTo,
        confidence,
        sampleCount,
        updatedAt: Date.now(),
      }

      learnedMap[showKey] = window
      saveLearnedMap(learnedMap)
      return window
    }
  }

  return null
}

/**
 * Retrieve a learned skip interval for a given show, if one has been established.
 */
export function getLearnedSkipInterval(showKey: string): AnimeSkipInterval | null {
  const cleanKey = String(showKey || '').trim().toLowerCase()
  if (!cleanKey) return null

  const learnedMap = loadLearnedMap()
  const match = learnedMap[cleanKey]
  if (!match || match.confidence < 0.6) return null

  return {
    startTime: match.startTime,
    endTime: match.endTime,
    skipType: 'op',
    source: 'learned',
  }
}

/**
 * Remove learned skip for a show (e.g. if user resets or prefers manual playback).
 */
export function removeLearnedSkip(showKey: string) {
  const cleanKey = String(showKey || '').trim().toLowerCase()
  if (!cleanKey) return
  const learnedMap = loadLearnedMap()
  if (learnedMap[cleanKey]) {
    delete learnedMap[cleanKey]
    saveLearnedMap(learnedMap)
  }
}
