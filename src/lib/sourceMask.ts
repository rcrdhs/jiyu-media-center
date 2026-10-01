import type { StreamItem, StreamSourceKind } from '../types'

const TORRENT_HOST_RE =
  /torlock|yts\.|yify|eztv|subsplease|torrentfunk|m2box|netmirror|freemovies\.lol|ymovies\.vip|cinetaro\.to|cinextream\.cc|1337x|rarbg|nyaa|torrentgalaxy|tgx\.|limetorrent|zooqle|piratebay|thepiratebay|magnet:?/i

/** True if a label/URL looks like a torrent index site. */
export function looksLikeCatalogWebsite(text?: string | null): boolean {
  if (!text) return false
  return TORRENT_HOST_RE.test(text)
}

/**
 * Shelf-facing source label — never expose origin hostnames (Torlock, YTS, …).
 * Real URLs stay in Library → Websites for management only.
 */
export function publicSourceLabel(
  source?: string | null,
  sourceKind?: StreamSourceKind | null,
): string {
  if (sourceKind === 'torrent' || looksLikeCatalogWebsite(source)) return 'Web catalog'
  if (sourceKind === 'iptv') return 'Playlist'
  if (sourceKind === 'builtin') return source?.trim() || 'Built-in'
  if (source?.trim()) {
    // Strip host-looking tokens from free-form labels
    if (looksLikeCatalogWebsite(source) || /\.[a-z]{2,}(\/|$)/i.test(source)) {
      return 'Web catalog'
    }
    return source.trim()
  }
  return 'Catalog'
}

export function publicItemSource(item: Pick<StreamItem, 'source' | 'sourceKind'>): string {
  return publicSourceLabel(item.source, item.sourceKind)
}

function savedWebsiteLabels(): string[] {
  const labels = [
    'YTS',
    'Cinetaro',
    'YMovies',
    'NetMirror',
    'M2Box',
    'subsplease',
    'torrentfunk',
    'Torlock',
    'EZTV',
    'Nyaa',
  ]
  try {
    const raw = localStorage.getItem('jiyu.torrent.sources')
    const parsed = raw ? (JSON.parse(raw) as { label?: string; url?: string }[]) : []
    if (Array.isArray(parsed)) {
      for (const source of parsed) {
        const label = source?.label?.trim()
        if (label && label.length >= 3) labels.push(label)
        try {
          if (source?.url) labels.push(new URL(source.url).hostname.replace(/^www\./, ''))
        } catch {
          /* ignore bad url */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return labels
}

/** Mask hostnames and saved website names in status strings. */
export function maskActivityMessage(raw: string): string {
  let text = raw
  text = text.replace(/https?:\/\/[^\s]+/gi, '[link]')
  text = text.replace(
    /\b(?:www\.)?(?:torlock|yts|yify|eztv|subsplease|torrentfunk|m2box|netmirror|ymovies|cinetaro|cinextream)[a-z0-9.-]*/gi,
    'website',
  )
  const labels = savedWebsiteLabels().sort((a, b) => b.length - a.length)
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(escaped, 'gi'), 'catalog')
  }
  text = text.replace(/\bfrom\s+website\b/gi, 'to the catalog')
  text = text.replace(/Added ([\d,]+) titles from website/gi, 'Added $1 titles to the catalog')
  text = text.replace(/Synced ([\d,]+) titles from website/gi, 'Synced $1 titles to the catalog')
  text = text.replace(/Syncing website\b/gi, 'Updating catalog')
  text = text.replace(/Updating website\b/gi, 'Updating catalog')
  text = text.replace(/\bwebsite\s*·\s*[^:.\n]+/gi, 'catalog')
  return text.replace(/\s{2,}/g, ' ').trim()
}
