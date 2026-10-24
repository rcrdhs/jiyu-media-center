/**
 * Bilibili / iQIYI donghua lookup diagnostics (search hits, match scores, episode
 * mapping, playurl, DASH→HLS build, CDN checks, why a step stopped).
 *
 * Desktop: Electron main appends to <userData>/logs/bilibili.log (new IPC — needs a
 *          dev restart); until then lines go to subtitles.log with a `bili.` prefix.
 * Android: logcat tag JiyuBili (TorrentStreamer.log with tag; older APKs → JiyuSubs).
 * Always mirrored to console.info('[JiyuBili]'). URLs are reduced to their origin and
 * signing / cookie values are never logged.
 */

import { nativeSubtitleLog } from './torrentBridge'

const SECRET_KEY_RE =
  /^(?:key|api[_-]?key|apikey|token|tok|secret|authorization|password|cookie|buvid\d?|w_rid|sign|sessdata|bili_jct|dedeuserid(?:__ckmd5)?|sid|access_key|csrf)$/i

function scrubString(value: string): string {
  let out = value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (u) => {
    try {
      return `${new URL(u).origin}/…`
    } catch {
      return 'url:…'
    }
  })
  out = out.replace(/\bblob:[^\s"'<>]+/gi, 'blob:…')
  out = out.replace(/([?&](?:key|api_key|apikey|token|tok|w_rid|wts)=)[^&\s"']+/gi, '$1…')
  // Account cookies (SESSDATA etc.) never reach bilibili.log / logcat.
  out = out.replace(/\b(SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|access_key|csrf)(\s*[=:]\s*"?)[^;\s"',&}]+/gi, '$1$2…')
  return out.length > 400 ? `${out.slice(0, 400)}…` : out
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

/** Log one donghua step, e.g. biliLog('cn.search', { keyword, hits: 3 }). */
export function biliLog(event: string, data?: Record<string, unknown>): void {
  let line = `bili.${event}`
  if (data) {
    try {
      line = `${line} ${JSON.stringify(scrub(data))}`
    } catch {
      /* keep the bare event */
    }
  }
  try {
    console.info('[JiyuBili]', line)
  } catch {
    /* ignore */
  }
  try {
    const desktop = typeof window !== 'undefined' ? window.signalDesktop : undefined
    if (desktop?.logBilibiliEvent) {
      desktop.logBilibiliEvent(line)
      return
    }
    if (desktop?.logSubtitleEvent) {
      // Main process not restarted yet (no bili:log IPC) → subtitles.log.
      desktop.logSubtitleEvent(line)
      return
    }
  } catch {
    /* ignore */
  }
  try {
    nativeSubtitleLog(line, 'JiyuBili')
  } catch {
    /* ignore */
  }
}
