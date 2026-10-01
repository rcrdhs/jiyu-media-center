import { Capacitor } from '@capacitor/core'
import type { StreamItem } from '../types'
import {
  favoriteTeamMatches,
  itemMatchesFavorite,
  LIVE_WINDOW_MS,
  readFavoriteTeams,
  type FavoriteTeam,
} from './favoriteTeams'
import { isLivextvReplayCatalogItem } from './livextvReplays'

const SENT_KEY = 'jiyu.sports.favorite-notified'
const CHANNEL_ID = 'favorite-matches'
const SOON_MS = 10 * 60 * 1000
const LOOKAHEAD_MS = 6 * 60 * 60 * 1000
const SENT_TTL_MS = 3 * 24 * 60 * 60 * 1000

type SentMap = Record<string, number>

function readSent(): SentMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(SENT_KEY) || '{}') as SentMap
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const kept: SentMap = {}
    for (const [key, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && now - at < SENT_TTL_MS) kept[key] = at
    }
    return kept
  } catch {
    return {}
  }
}

function writeSent(sent: SentMap) {
  localStorage.setItem(SENT_KEY, JSON.stringify(sent))
}

function markSent(key: string) {
  const sent = readSent()
  sent[key] = Date.now()
  writeSent(sent)
}

function alreadySent(key: string): boolean {
  return typeof readSent()[key] === 'number'
}

/** Desktop timers die on reload, so only the shown alert is persisted. */
const armed = new Set<string>()
/** One in-flight sync at a time — catalog churn must not stack schedules. */
let syncGate: Promise<void> = Promise.resolve()

function notifyId(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const id = Math.abs(hash) % 2_000_000_000
  return id === 0 ? 1 : id
}

/** Stable key so duplicate catalog rows for the same fixture share one alert. */
function matchFingerprint(item: StreamItem, kind: 'live' | 'soon'): string {
  const title = String(item.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const start = item.eventStartsAt ? String(Math.floor(item.eventStartsAt / 60_000)) : '0'
  return `${kind}:${start}:${title}`
}

function isAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

export async function ensureFavoriteNotifyPermission(): Promise<boolean> {
  if (isAndroid()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      const current = await LocalNotifications.checkPermissions()
      if (current.display === 'granted') return true
      const next = await LocalNotifications.requestPermissions()
      return next.display === 'granted'
    } catch {
      return false
    }
  }
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

async function ensureChannel() {
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Favorite teams',
    description: 'When a favorite team is about to play or is live',
    importance: 4,
    visibility: 1,
  })
}

async function showAndroid(
  key: string,
  title: string,
  body: string,
  itemId: string,
  at: Date,
) {
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  await ensureChannel()
  const id = notifyId(key)
  // Replace any prior copy of this alert — HyperOS stacks duplicates otherwise.
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] })
  } catch {
    /* ignore */
  }
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title,
        body,
        channelId: CHANNEL_ID,
        extra: { itemId },
        schedule: {
          at,
          allowWhileIdle: true,
        },
        isExactNotification: false,
        // Must stay dismissible — never pin like the catalog sync service.
        ongoing: false,
        autoCancel: true,
        foreground: true,
      },
    ],
  })
}

async function cancelAndroid(keys: string[]) {
  if (keys.length === 0 || !isAndroid()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({
      notifications: keys.map((key) => ({ id: notifyId(key) })),
    })
  } catch {
    /* ignore */
  }
}

/** Wipe delivered + pending favorite alerts (orphans from older builds). */
export async function clearFavoriteMatchNotifications(): Promise<void> {
  if (!isAndroid()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const pending = await LocalNotifications.getPending()
    const delivered = await LocalNotifications.getDeliveredNotifications()
    const ids = new Set<number>()
    for (const n of pending.notifications || []) {
      if (n.id != null) ids.add(Number(n.id))
    }
    for (const n of delivered.notifications || []) {
      if (n.id != null) ids.add(Number(n.id))
    }
    if (ids.size === 0) return
    await LocalNotifications.cancel({
      notifications: [...ids].map((id) => ({ id })),
    })
    try {
      const toRemove = (delivered.notifications || []).filter(
        (n) => n.id != null && ids.has(Number(n.id)),
      )
      if (toRemove.length > 0) {
        await LocalNotifications.removeDeliveredNotifications({
          notifications: toRemove,
        })
      }
    } catch {
      /* older plugin */
    }
  } catch {
    /* ignore */
  }
}

function showDesktop(title: string, body: string): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  const notice = new Notification(title, { body })
  notice.onclick = () => {
    window.focus()
    notice.close()
  }
  return true
}

async function deliver(key: string, title: string, body: string, itemId: string, at: Date) {
  if (alreadySent(key) || armed.has(key)) return
  armed.add(key)
  try {
    if (isAndroid()) {
      await showAndroid(key, title, body, itemId, at)
      markSent(key)
      return
    }
    const delay = at.getTime() - Date.now()
    if (delay > 1500) {
      window.setTimeout(() => {
        if (showDesktop(title, body)) markSent(key)
        else armed.delete(key)
      }, delay)
      return
    }
    if (showDesktop(title, body)) markSent(key)
    else armed.delete(key)
  } catch (err) {
    armed.delete(key)
    console.warn('[favorites] notify failed', err)
  }
}

function matchedTeam(item: StreamItem, teams: FavoriteTeam[]): FavoriteTeam | undefined {
  return teams.find((team) => itemMatchesFavorite(item, team))
}

function isReplayItem(item: StreamItem): boolean {
  return isLivextvReplayCatalogItem(item) || Boolean(item.tags?.includes('replay'))
}

/** Notify once before kickoff and once when a favorite match is live (not for replays). */
export async function syncFavoriteMatchNotifications(items: StreamItem[]) {
  const run = async () => {
    const teams = readFavoriteTeams()
    if (teams.length === 0) return
    const matches = favoriteTeamMatches(items, teams)
    const now = Date.now()

    // Drop stale "is live" / soon alerts once the 4h window has passed.
    const staleKeys: string[] = []
    for (const item of items) {
      if (!teams.some((team) => itemMatchesFavorite(item, team))) continue
      const liveKey = matchFingerprint(item, 'live')
      const soonKey = matchFingerprint(item, 'soon')
      if (isReplayItem(item)) {
        staleKeys.push(liveKey, soonKey, `${item.id}:live`, `${item.id}:soon`)
        continue
      }
      const start = item.eventStartsAt || 0
      if (start > 0 && now - start > LIVE_WINDOW_MS) {
        staleKeys.push(liveKey, soonKey, `${item.id}:live`, `${item.id}:soon`)
      }
    }
    if (staleKeys.length > 0) {
      await cancelAndroid(staleKeys)
      const sent = readSent()
      for (const key of staleKeys) delete sent[key]
      writeSent(sent)
    }

    for (const item of matches) {
      if (isReplayItem(item)) continue
      const team = matchedTeam(item, teams)
      const who = team?.name || 'A favorite team'
      const start = item.eventStartsAt || 0
      const body = item.title
      if (start > now && start - now <= LOOKAHEAD_MS) {
        const at = new Date(Math.max(now + 1000, start - SOON_MS))
        await deliver(matchFingerprint(item, 'soon'), `${who} plays soon`, body, item.id, at)
      }
      const live = start > 0 && start <= now && now - start <= LIVE_WINDOW_MS
      if (live) {
        // Fire once immediately — do not keep re-scheduling on every catalog tick.
        await deliver(
          matchFingerprint(item, 'live'),
          `${who} is live`,
          body,
          item.id,
          new Date(now + 500),
        )
      }
    }
  }

  const next = syncGate.then(run, run)
  syncGate = next.then(
    () => undefined,
    () => undefined,
  )
  await next
}
