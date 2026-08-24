import type { CategoryId, StreamItem } from '../types'

const CATEGORY_HINTS: Array<{ id: CategoryId; pattern: RegExp }> = [
  {
    id: 'sports',
    pattern:
      /sport|espn|nba|nfl|mlb|football|soccer|uefa|f1|tennis|ufc|boxing|golf|hockey|cricket|racing|olympics|ppv|fight/i,
  },
  {
    id: 'kids',
    pattern:
      /\bkids?\b|children|childrens|junior|preschool|pbs\s*kids|nick(?:elodeon|jr)?|disney\s*junior|cartoon\s*network|boomerang|cbeebies|treehouse|baby\s*tv|family\s*jr|\bcartoon\b/i,
  },
  { id: 'anime', pattern: /anime|otaku|crunchy|manga|toonami|动画|アニ/i },
  {
    id: 'movies',
    pattern: /movie|cinema|film|vod|cinema|cine|\bvods?\b|hollywood|hollywood|box\s*office/i,
  },
  {
    id: 'series',
    pattern: /series|episode|tv\s?show|drama|sitcom|season|soap|\bshows?\b|\btv\b/i,
  },
  {
    id: 'news',
    pattern: /news|cnn|bbc|al\s?jazeera|reuters|weather|fox\s?news|msnbc|dw\b|france\s?24|cna|nhk|documentary/i,
  },
]

export function guessCategory(name: string, group: string, url = ''): CategoryId {
  if (/\/kids?\//i.test(url) || /categories\/kids\.m3u/i.test(url)) return 'kids'
  if (/\/movie\//i.test(url)) return 'movies'
  if (/\/series\//i.test(url)) return 'series'
  const haystack = `${name} ${group}`
  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(haystack)) return hint.id
  }
  if (/\/live\//i.test(url)) return 'news'
  return 'series'
}

function attr(meta: string, key: string): string | undefined {
  const quoted = meta.match(new RegExp(`${key}="([^"]*)"`, 'i'))
  if (quoted) return quoted[1]
  const bare = meta.match(new RegExp(`${key}=([^,\\s]+)`, 'i'))
  return bare?.[1]
}

export interface ParseM3UOptions {
  fallbackCategory?: CategoryId
  sourceId?: string
  sourceLabel?: string
}

/**
 * Parses Extended M3U / IPTV (M3U+) playlists with no channel count cap.
 * Supports group-title, #EXTGRP, tvg-* attrs, Xtream live/movie/series URLs.
 */
export function parseM3U(content: string, options: ParseM3UOptions = {}): StreamItem[] {
  const fallbackCategory = options.fallbackCategory ?? 'series'
  const sourceId = options.sourceId ?? 'import'
  const sourceLabel = options.sourceLabel ?? 'IPTV import'
  const lines = content.split(/\r?\n/)
  const items: StreamItem[] = []
  let pending: {
    title: string
    group: string
    logo?: string
    chno?: string
    language?: string
    tvgId?: string
    httpUserAgent?: string
    httpReferrer?: string
  } | null = null
  let extGroup = ''
  let pendingVlcUserAgent = ''
  let pendingVlcReferrer = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#EXTM3U')) continue

    if (line.startsWith('#EXTGRP:')) {
      extGroup = line.slice('#EXTGRP:'.length).trim()
      if (pending && !pending.group) pending.group = extGroup
      continue
    }

    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim()
      const eq = opt.indexOf('=')
      if (eq > 0) {
        const key = opt.slice(0, eq).trim().toLowerCase()
        const value = opt.slice(eq + 1).trim()
        if (key === 'http-user-agent' && value) {
          if (pending) pending.httpUserAgent = value
          else pendingVlcUserAgent = value
        }
        if ((key === 'http-referrer' || key === 'http-referer') && value) {
          if (pending) pending.httpReferrer = value
          else pendingVlcReferrer = value
        }
      }
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      const comma = line.lastIndexOf(',')
      const meta = comma >= 0 ? line.slice(0, comma) : line
      const afterComma = comma >= 0 ? line.slice(comma + 1).trim() : ''
      const tvgName = attr(meta, 'tvg-name')
      const title = afterComma || tvgName || 'Untitled'
      pending = {
        title,
        group: attr(meta, 'group-title') ?? extGroup ?? '',
        logo: attr(meta, 'tvg-logo'),
        chno: attr(meta, 'tvg-chno') ?? attr(meta, 'channel-number'),
        language: attr(meta, 'tvg-language') ?? attr(meta, 'language'),
        tvgId: attr(meta, 'tvg-id'),
        httpUserAgent: attr(meta, 'http-user-agent') || pendingVlcUserAgent || undefined,
        httpReferrer:
          attr(meta, 'http-referrer') ||
          attr(meta, 'http-referer') ||
          pendingVlcReferrer ||
          undefined,
      }
      pendingVlcUserAgent = ''
      pendingVlcReferrer = ''
      continue
    }

    if (line.startsWith('#')) continue

    const title = pending?.title ?? deriveTitleFromUrl(line)
    const group = pending?.group || extGroup || ''
    const logo = pending?.logo
    const language = pending?.language
    const category =
      options.fallbackCategory === 'kids'
        ? 'kids'
        : guessCategory(title, group, line) || fallbackCategory
    const tags = ['iptv', 'imported']
    if (category === 'kids') tags.push('kids-live')
    if (group) tags.push(group)
    if (pending?.chno) tags.push(`#${pending.chno}`)
    if (language) tags.push(language)
    if (options.sourceId) tags.push(options.sourceId)

    items.push({
      id: `${sourceId}-${items.length}-${hash(title + line)}`,
      title,
      description: group ? `${sourceLabel} · ${group}` : sourceLabel,
      category,
      url: line,
      poster: logo || undefined,
      tags,
      source: sourceLabel,
      sourceKind: 'iptv',
      transport: 'direct',
      language: language || undefined,
      tvgId: pending?.tvgId || undefined,
      httpUserAgent: pending?.httpUserAgent,
      httpReferrer: pending?.httpReferrer,
    })
    pending = null
  }

  return items
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return decodeURIComponent(last || u.hostname) || 'Untitled'
  } catch {
    return 'Untitled'
  }
}

export function hash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

export function countM3UEntries(content: string): number {
  return parseM3U(content).length
}
