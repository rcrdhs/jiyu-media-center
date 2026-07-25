/** Cap for the curated IPTV-Org News shelf. */
export const POPULAR_NEWS_LIMIT = 100

const NEWS_PLAYLIST_RE = /iptv-org\.github\.io\/iptv\/categories\/news\.m3u/i

/** Well-known global / English-leaning news brands. */
const NEWS_BRAND_RE =
  /\b(?:cnn|bbc|al\s?jazeera|reuters|sky\s?news|fox\s?news|msnbc|cnbc|bloomberg|france\s?24|euronews|\bdw\b|nhk|cna|abc\s?news|cbs\s?news|nbc\s?news|pbs\s?news|cbc\s?news|ctv\s?news|global\s?news|itv\s?news|channel\s?4\s?news|ndtv|times\s?now|india\s?today|wion|trt\s?world|cgtn|arirang|africanews|tele\s?sur|voice\s?of\s?america|\bvoa\b|rfi\b|tv5\s?monde|bnn\s?bloomberg|cp24|citynews|newsmax|oan|one\s?america|the\s?hill|gb\s?news|talk\s?tv|i24|rt\b|sputnik|press\s?tv|al\s?arabiya|al\s?hadath|sky\s?tg24|rai\s?news|tagesschau|nationwide|cvm\s?news|tvj\s?news)\b/i

interface NewsEntry {
  header: string
  url: string
  title: string
  tvgId: string
  score: number
}

function attr(meta: string, key: string): string {
  const m = meta.match(new RegExp(`${key}="([^"]*)"`, 'i'))
  return m?.[1] ?? ''
}

function qualityBonus(title: string): number {
  if (/2160p|4k/i.test(title)) return 4
  if (/1080p/i.test(title)) return 3
  if (/720p/i.test(title)) return 2
  return 0
}

function countryBonus(tvgId: string): number {
  const cc = /\.([a-z]{2})$/i.exec(tvgId)?.[1]?.toLowerCase()
  if (!cc) return 0
  if (cc === 'us' || cc === 'uk' || cc === 'gb') return 14
  if (cc === 'ca' || cc === 'au' || cc === 'ie' || cc === 'nz' || cc === 'jm') return 10
  if (['de', 'fr', 'in', 'jp', 'sg', 'ae', 'qa', 'nl', 'se', 'no', 'dk'].includes(cc)) return 6
  return 0
}

function scoreNewsEntry(title: string, tvgId: string): number {
  let n = 0
  if (NEWS_BRAND_RE.test(title)) n += 45
  if (/\benglish\b|\binternational\b|\bworld\b|\busa\b|\buk\b/i.test(title)) n += 18
  if (
    /\b(?:persian|arabic|mubasher|urdu|hindi|bangla|bengali|tamil|telugu|malayalam|kannada|marathi|gujarati|punjabi|mandarin|cantonese|korean|japanese|turkish|russian|spanish|portuguese|french|german|italian|dutch|swedish|norwegian|danish|finnish|polish|romanian|hungarian|greek|hebrew|thai|vietnamese|indonesian|tagalog)\b/i.test(
      title,
    ) &&
    !/\benglish\b|\binternational\b/i.test(title)
  ) {
    n -= 28
  }
  if (/geo-?blocked/i.test(title)) n -= 4
  n += countryBonus(tvgId)
  n += qualityBonus(title)
  return n
}

/** Collapse quality / feed suffixes so one channel keeps a single best feed. */
function brandKey(title: string, tvgId: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(
      /\b(?:hdtv|hd|sd|hevc|h\.?265|h\.?264|fhd|uhd|4k|2160p|1080p|720p|480p|geo-?blocked|not\s*24\/?7)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  // Known brands: dedupe by cleaned title so 1080p/720p twins don't both take slots
  if (NEWS_BRAND_RE.test(title) && normalized) return `brand:${normalized}`
  if (tvgId) return tvgId.toLowerCase()
  return normalized
}

/**
 * Keep the highest-scoring ~N news channels from a full IPTV-Org news.m3u.
 * Pure title/tvg heuristics — no extra network calls.
 */
export function trimNewsPlaylistToPopular(
  content: string,
  limit = POPULAR_NEWS_LIMIT,
): string {
  const lines = content.split(/\r?\n/)
  const headerLines: string[] = []
  const entries: NewsEntry[] = []
  let pendingHeader: string | null = null

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('#EXTM3U')) {
      headerLines.push(trimmed)
      continue
    }

    if (trimmed.startsWith('#EXTINF:')) {
      pendingHeader = trimmed
      continue
    }

    if (trimmed.startsWith('#')) {
      if (entries.length === 0 && !pendingHeader) headerLines.push(trimmed)
      continue
    }

    if (!pendingHeader) continue

    const comma = pendingHeader.lastIndexOf(',')
    const meta = comma >= 0 ? pendingHeader.slice(0, comma) : pendingHeader
    const title = (comma >= 0 ? pendingHeader.slice(comma + 1) : 'Untitled').trim()
    const tvgId = attr(meta, 'tvg-id')
    entries.push({
      header: pendingHeader,
      url: trimmed,
      title,
      tvgId,
      score: scoreNewsEntry(title, tvgId),
    })
    pendingHeader = null
  }

  const bestByKey = new Map<string, NewsEntry>()
  for (const entry of entries) {
    const key = brandKey(entry.title, entry.tvgId)
    const prev = bestByKey.get(key)
    if (!prev || entry.score > prev.score) bestByKey.set(key, entry)
  }

  const top = [...bestByKey.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, limit))

  const out = headerLines.length > 0 ? [...headerLines] : ['#EXTM3U']
  for (const entry of top) {
    out.push(entry.header)
    out.push(entry.url)
  }
  return `${out.join('\n')}\n`
}

export function isIptvOrgNewsPlaylistUrl(url: string | undefined): boolean {
  return Boolean(url && NEWS_PLAYLIST_RE.test(url))
}

/** Apply news popularity trim when the URL is the IPTV-Org news category list. */
export function preparePlaylistContent(url: string | undefined, content: string): string {
  if (!isIptvOrgNewsPlaylistUrl(url)) return content
  return trimNewsPlaylistToPopular(content, POPULAR_NEWS_LIMIT)
}
