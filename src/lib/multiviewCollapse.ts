/**
 * Multi-view collapse: closing tiles until one stream is left hands that live
 * embed to the single-player browser (Electron view / Android Gecko session).
 * WebBrowserContext checks this so the adopted page is not covered or nudged.
 */

const PROMOTE_WINDOW_MS = 20_000

let promoted: { urls: string[]; at: number } | null = null

function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname}${u.search}`
  } catch {
    return String(url || '').split('#')[0]
  }
}

export function notePromotedEmbed(urls: string[]): void {
  const list = urls.filter(Boolean)
  promoted = list.length ? { urls: list, at: Date.now() } : null
}

/** True once for a fresh promote of the same page (consumes the marker). */
export function takePromotedEmbed(url: string): boolean {
  const entry = promoted
  if (!entry) return false
  if (Date.now() - entry.at > PROMOTE_WINDOW_MS) {
    promoted = null
    return false
  }
  const key = pageKey(url)
  if (!entry.urls.some((u) => pageKey(u) === key)) return false
  promoted = null
  return true
}
