import type { StreamItem, StreamSourceKind } from '../types'

const TORRENT_HOST_RE =
  /torlock|yts\.|yify|eztv|subsplease|torrentfunk|m2box|netmirror|freemovies\.lol|ymovies\.vip|cinetaro\.to|cinextream\.cc|1337x|rarbg|nyaa|torrentgalaxy|tgx\.|limetorrent|zooqle|piratebay|thepiratebay|magnet:?|movy\.|zenox\.|rivestream|atlantic\.|wecollege|paleoak|zenoak|torrentio|streamed\.pk|hls\.lol|streamo|shegu|bilibili\.tv|biliintl/i

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
    'YIFY',
    'Cinetaro',
    'Cinextream',
    'YMovies',
    'NetMirror',
    'M2Box',
    'subsplease',
    'SubsPlease',
    'torrentfunk',
    'TorrentFunk',
    'Torlock',
    'EZTV',
    'Nyaa',
    'Movy',
    'Zenox',
    'Rivestream',
    'Rive',
    'Atlantic',
    'Torrentio',
    'Real-Debrid',
    'Real Debrid',
    'Debrid',
    '1337x',
    'RARBG',
    'TorrentGalaxy',
    'LimeTorrent',
    'Zooqle',
    'The Pirate Bay',
    'Pirate Bay',
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

/** Mask hostnames and saved website names in sync / activity strings. */
export function maskActivityMessage(raw: string): string {
  return maskUserFacingMessage(raw)
}

/**
 * User-facing errors, status, and flashes — never say "torrent", magnet, swarm,
 * or catalog/CDN hostnames. Prefer neutral "source(s)" wording.
 */
export function maskUserFacingMessage(raw: string): string {
  if (!raw) return raw
  let text = String(raw)

  text = text.replace(/https?:\/\/[^\s]+/gi, 'source')
  text = text.replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi, 'source')
  text = text.replace(
    /\b(?:[a-z0-9-]+\.)*(?:torlock|yts|yify|eztv|subsplease|torrentfunk|m2box|netmirror|ymovies|cinetaro|cinextream|nyaa|movy|zenox|rivestream|atlantic|wecollege|paleoak|zenoak|torrentio|torrentgalaxy|limetorrent|zooqle|thepiratebay|piratebay|1337x|rarbg|streamed|streamo|shegu|hls\.lol|bilibili|biliintl|bstarstatic)[a-z0-9.-]*/gi,
    'source',
  )

  const labels = savedWebsiteLabels().sort((a, b) => b.length - a.length)
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), 'source')
  }

  // Sync / catalog phrasing
  text = text.replace(/\bfrom\s+website\b/gi, 'to the catalog')
  text = text.replace(/Added ([\d,]+) titles from website/gi, 'Added $1 titles to the catalog')
  text = text.replace(/Synced ([\d,]+) titles from website/gi, 'Synced $1 titles to the catalog')
  text = text.replace(/Syncing website\b/gi, 'Updating catalog')
  text = text.replace(/Updating website\b/gi, 'Updating catalog')
  text = text.replace(/\bwebsite\s*·\s*[^:.\n]+/gi, 'catalog')

  // Playback vocabulary → sources
  text = text.replace(/\bTorrent playback needs\b/gi, 'Playback needs')
  text = text.replace(/\bTorrent playback\b/gi, 'Playback')
  text = text.replace(/\bAndroid torrent engine\b/gi, 'Android source engine')
  text = text.replace(/\btorrent engine\b/gi, 'source engine')
  text = text.replace(/\btorrent data\b/gi, 'source data')
  text = text.replace(/\btorrent buffer\b/gi, 'source buffer')
  text = text.replace(/\btorrent gap\b/gi, 'source gap')
  text = text.replace(/\btorrent stream\b/gi, 'stream')
  text = text.replace(/\btorrent link\b/gi, 'source link')
  text = text.replace(/\bmagnet or torrent link\b/gi, 'source link')
  text = text.replace(/\bmagnet link\b/gi, 'source link')
  text = text.replace(/\bmagnets?\b/gi, 'source links')
  text = text.replace(/\bStarting torrent\b/gi, 'Opening source')
  text = text.replace(/\bLoading torrent\b/gi, 'Loading source')
  text = text.replace(/\bCould not start torrent\b/gi, 'Could not start source')
  text = text.replace(/\bCould not choose a torrent\b/gi, 'Could not choose a source')
  text = text.replace(/\bNo torrent\b/gi, 'No source')
  text = text.replace(/\btwo torrents\b/gi, 'two sources')
  text = text.replace(/\btorrents\b/gi, 'sources')
  text = text.replace(/\btorrent\b/gi, 'source')

  text = text.replace(/\bChecking debrid streams\b/gi, 'Checking ready sources')
  text = text.replace(/\bStarting debrid stream\b/gi, 'Opening ready source')
  text = text.replace(/\bdebrid streams?\b/gi, 'ready sources')
  text = text.replace(/\bdebrid\b/gi, 'ready source')

  text = text.replace(/\bThis swarm looks dead or empty\b/gi, 'This source looks empty')
  text = text.replace(/\bswarm may be dead\b/gi, 'source unavailable')
  text = text.replace(/\bdead swarm\b/gi, 'empty source')
  text = text.replace(/\bswarm\b/gi, 'source')
  text = text.replace(/\bno reachable seeds?\b/gi, 'no working sources')
  text = text.replace(/\bno seeds? found\b/gi, 'no sources found')
  text = text.replace(/\bNo peers found for any release\b/gi, 'No working sources for any release')
  text = text.replace(/\bNo peers found\b/gi, 'No working sources')
  text = text.replace(/\bwait for more peers\b/gi, 'wait for more source data')
  text = text.replace(/\bmore peers\b/gi, 'more source data')
  text = text.replace(/\bPeers may be slow\b/gi, 'Sources may be slow')
  text = text.replace(/\bpeers may be slow\b/gi, 'sources may be slow')
  text = text.replace(/\bpeers\b/gi, 'sources')
  text = text.replace(/\bseeders?\b/gi, 'sources')

  // Provider / open status lines
  text = text.replace(/\bOpening Movy\b/gi, 'Opening stream')
  text = text.replace(/\bTrying Movy\b/gi, 'Trying sources')
  text = text.replace(/\bMovy lookup timed out\b/gi, 'Source lookup timed out')
  text = text.replace(/\bNo Movy stream\b/gi, 'No stream')
  text = text.replace(/\bNo Movy or Atlantic streams\b/gi, 'No streams')
  text = text.replace(/\bOpening alternate stream\b/gi, 'Opening another source')
  text = text.replace(/\bTrying alternate HLS\b/gi, 'Trying another source')
  text = text.replace(/\bFinding subtitles from source\b/gi, 'Finding subtitles')
  text = text.replace(/\bPlaying · (?:source|atlantic|movy)\b/gi, 'Playing')

  text = text.replace(/\bCould not resolve M2Box stream\b/gi, 'Could not resolve stream')
  text = text.replace(/\bCould not load M2Box episode\b/gi, 'Could not load episode')
  text = text.replace(/\bCould not resolve NetMirror player\b/gi, 'Could not open this source')
  text = text.replace(/\bCould not resolve YMovies player\b/gi, 'Could not open this source')
  text = text.replace(/\bCould not resolve Cinetaro player\b/gi, 'Could not open this source')
  text = text.replace(/\bNo Cinetaro stream\b/gi, 'No stream')
  text = text.replace(/\bVIP-locked on source\b/gi, 'VIP-locked on this source')

  // Collapse awkward repeats from layered replacements
  text = text.replace(/\bsource source\b/gi, 'source')
  text = text.replace(/\bsources sources\b/gi, 'sources')
  text = text.replace(/\bfrom source\b/gi, '')
  text = text.replace(/\s{2,}/g, ' ')
  text = text.replace(/\s+([.,!?])/g, '$1')
  return text.trim()
}
