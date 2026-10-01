/** Live / countdown labels for sports event cards (PPV.st / Streamed starts_at). */

/** PPV.st-style remaining time: `1 day, 22:28:45` or `22:28:45`. */
export function formatEventCountdown(startsAtMs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, startsAtMs - nowMs)
  if (diff <= 0) return 'Live'
  const totalSec = Math.floor(diff / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const hms = [
    String(hours).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':')
  if (days === 1) return `1 day, ${hms}`
  if (days > 1) return `${days} days, ${hms}`
  return hms
}

/** Kickoff clock for upcoming games (local time). */
export function formatEventKickoff(startsAtMs: number): string {
  return new Date(startsAtMs).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function liveViewerLabel(viewers: number | undefined): string | null {
  if (viewers == null || !Number.isFinite(viewers) || viewers < 0) return null
  return String(Math.floor(viewers))
}

/**
 * Sports badge:
 * - upcoming / soon → PPV.st countdown (`1 day, 22:28:45`)
 * - live → viewer count when known (PPV.st); omit plain "Live" when unknown
 *   (Streamed catalog has no viewers — don't invent a Live chip)
 */
export function eventBadgeForItem(
  item: {
    eventStartsAt?: number
    eventEndsAt?: number
    eventViewers?: number
    tags?: string[]
    category?: string
  },
  nowMs = Date.now(),
): { kind: 'live' | 'soon' | 'upcoming' | 'ended'; label: string; viewers?: boolean } | null {
  if (item.category !== 'sports') return null
  if (item.tags?.includes('replay')) {
    return { kind: 'ended', label: 'Replay' }
  }
  const start = Number(item.eventStartsAt) || 0
  const end = Number(item.eventEndsAt) || 0
  const always = item.tags?.includes('always-live')
  const viewersLabel = liveViewerLabel(item.eventViewers)

  if (always) {
    if (viewersLabel != null) return { kind: 'live', label: viewersLabel, viewers: true }
    return { kind: 'live', label: '24/7' }
  }

  if (end > 0 && end < nowMs && !(start > nowMs)) {
    return { kind: 'ended', label: 'Ended' }
  }

  if (start > nowMs) {
    const diff = start - nowMs
    const kind = diff <= 60 * 60 * 1000 ? 'soon' : 'upcoming'
    return { kind, label: formatEventCountdown(start, nowMs) }
  }

  if (
    item.tags?.includes('live-now') ||
    item.tags?.includes('live') ||
    (start > 0 && start <= nowMs && (!end || end >= nowMs))
  ) {
    // Only PPV-style viewer counts — never a bare "Live" word.
    if (viewersLabel != null) return { kind: 'live', label: viewersLabel, viewers: true }
    return null
  }

  return null
}
