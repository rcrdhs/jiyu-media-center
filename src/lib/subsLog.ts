/**
 * Subtitle-step diagnostics: provider attempts (Wyzie / OpenSubtitles, worker vs direct),
 * the Nyaa query, chosen release and why a step stopped.
 *
 * Desktop: Electron main appends to <userData>/logs/subtitles.log (rolled at ~1 MB).
 * Android: logcat lines tagged JiyuSubs via the TorrentStreamer plugin.
 * Always mirrored to console.info. Never logs keys or tokens — URLs are reduced to their origin.
 */

import { nativeSubtitleLog } from './torrentBridge'

const SECRET_KEY_RE = /^(?:key|api[_-]?key|apikey|token|tok|secret|authorization|password)$/i

function scrubString(value: string): string {
  let out = value
  // Magnet → info-hash only (no trackers / names).
  out = out.replace(/magnet:\?[^\s"']*/gi, (m) => {
    const hash = /xt=urn:btih:([a-z0-9]{32,40})/i.exec(m)?.[1]
    return hash ? `magnet:${hash.toLowerCase()}` : 'magnet:…'
  })
  // URLs → origin only (paths / query strings can carry keys or signed download tokens).
  out = out.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (u) => {
    try {
      return `${new URL(u).origin}/…`
    } catch {
      return 'url:…'
    }
  })
  out = out.replace(/([?&](?:key|api_key|apikey|token|tok)=)[^&\s"']+/gi, '$1…')
  return out.length > 600 ? `${out.slice(0, 600)}…` : out
}

function scrub(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 3) return '…'
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => scrub(v, depth + 1))
  if (value instanceof Error) return scrubString(value.message)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue
      out[k] = scrub(v, depth + 1)
    }
    return out
  }
  return String(value)
}

/** Log one subtitle step, e.g. subsLog('wyzie', { via: 'worker', ok: false, error }). */
export function subsLog(event: string, data?: Record<string, unknown>): void {
  let line = event
  if (data) {
    try {
      line = `${event} ${JSON.stringify(scrub(data))}`
    } catch {
      /* keep the bare event */
    }
  }
  try {
    console.info('[subs]', line)
  } catch {
    /* ignore */
  }
  try {
    const desktop = typeof window !== 'undefined' ? window.signalDesktop : undefined
    if (desktop?.logSubtitleEvent) {
      desktop.logSubtitleEvent(line)
      return
    }
  } catch {
    /* ignore */
  }
  nativeSubtitleLog(line)
}

/** Short info-hash for log lines. */
export function shortHash(hash: string | null | undefined): string {
  return String(hash || '').slice(0, 8)
}
