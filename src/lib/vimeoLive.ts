/** Official CVM Television 24×7 live event on Vimeo (site.cvmtv.com/live). */
export const CVM_VIMEO_EVENT_URL = 'https://vimeo.com/event/4401057'
export const CVM_VIMEO_EVENT_ID = '4401057'

export type VimeoLiveResolveResult =
  | { ok: true; url: string; title?: string }
  | { ok: false; error: string }

export function parseVimeoEventId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\d{5,}$/.test(raw)) return raw
  try {
    const u = new URL(raw)
    if (!/vimeo\.com$/i.test(u.hostname) && !/\.vimeo\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/\/event\/(\d+)/i)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export function isVimeoLiveEventUrl(url: string): boolean {
  return Boolean(parseVimeoEventId(url))
}

/**
 * Resolve a Vimeo live event to a short-lived HLS URL.
 * Needs the desktop shell (Referer-sensitive player config).
 */
export async function resolveVimeoLiveHls(urlOrEventId: string): Promise<VimeoLiveResolveResult> {
  const eventId = parseVimeoEventId(urlOrEventId) || urlOrEventId.trim()
  if (!/^\d{5,}$/.test(eventId)) {
    return { ok: false, error: 'Not a Vimeo live event URL' }
  }
  if (!window.signalDesktop?.resolveVimeoLiveHls) {
    return { ok: false, error: 'Vimeo live resolve needs the Jiyu desktop app.' }
  }
  try {
    const result = await window.signalDesktop.resolveVimeoLiveHls(eventId)
    if (!result.ok || !result.url) {
      return { ok: false, error: result.error || 'Could not resolve Vimeo live HLS' }
    }
    return { ok: true, url: result.url, title: result.title }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
