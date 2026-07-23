import type { StreamItem } from '../types'

const PREF_KEY = 'jiyu.pref.hideDuplicates'

/** Normalize titles for duplicate detection: strip quality / status suffixes */
export function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*[\[(][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\b(720p|1080p|2160p|4k|hd|sd|fhd|uhd|hevc|h\.?265|h\.?264|not\s*24\/?7)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function isTorrentItem(item: StreamItem): boolean {
  return item.transport === 'torrent' || item.sourceKind === 'torrent'
}

function normalizeUrlKey(url: string): string {
  // Magnet links have no hostname/pathname — key them by infohash so
  // thousands of torrent entries don't collapse into one "duplicate".
  const btih = /urn:btih:([a-z0-9]{32,40})/i.exec(url)
  if (btih) return `magnet:${btih[1].toLowerCase()}`
  try {
    const u = new URL(url)
    if (!/^https?:$/i.test(u.protocol)) return url.trim().toLowerCase()
    const path = `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
    // Keep query keys that distinguish API rows (YTS movie_details?movie_id=…).
    // Dropping search made every YTS title share one URL and vanish in dedupe.
    if (!u.search) return path
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !/^(with_images|with_cast|limit)$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
    if (params.length === 0) return path
    const qs = params
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
    return `${path}?${qs}`
  } catch {
    return url.trim().toLowerCase()
  }
}

function scoreItem(item: StreamItem): number {
  let n = 0
  if (item.source && !/local channel|mux|bitmovin|sample|demo/i.test(item.source)) n += 4
  if (item.tags?.some((t) => /imported|iptv/i.test(t))) n += 3
  if (/720|1080|hd|fhd/i.test(item.title)) n += 2
  if (item.poster) n += 1
  if (item.tvgId) n += 1
  if (isTorrentItem(item) && item.poster) n += 2
  if (/streamlock\.net/i.test(item.url)) n -= 6
  if (/youtube\.com|youtu\.be/i.test(item.url)) n += 1
  return n
}

/**
 * Keep one stream per URL, then one per normalized title.
 * Prefers imported / higher-res / better-tagged copies.
 * Torrents are never title-merged with IPTV/builtin rows — otherwise
 * "Hide IPTV" + "Hide duplicates" wipes entire YTS shelves.
 */
export function dedupeStreams(items: StreamItem[]): StreamItem[] {
  const byUrl = new Map<string, StreamItem>()
  for (const item of items) {
    // Torrent catalog ids are already unique per listing; don't URL-collapse them.
    const uk = isTorrentItem(item) ? `id:${item.id}` : normalizeUrlKey(item.url)
    const prev = byUrl.get(uk)
    if (!prev || scoreItem(item) > scoreItem(prev)) byUrl.set(uk, item)
  }

  const byTitle = new Map<string, StreamItem>()
  for (const item of byUrl.values()) {
    const titleKey = normalizeTitleKey(item.title) || normalizeUrlKey(item.url)
    const tk = isTorrentItem(item) ? `torrent:${titleKey}` : `stream:${titleKey}`
    const prev = byTitle.get(tk)
    if (!prev || scoreItem(item) > scoreItem(prev)) byTitle.set(tk, item)
  }

  const kept = new Set([...byTitle.values()].map((i) => i.id))
  return items.filter((item) => kept.has(item.id))
}

export function getHideDuplicatesPref(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw === null) return true
    return raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

export function setHideDuplicatesPref(value: boolean) {
  try {
    localStorage.setItem(PREF_KEY, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}
