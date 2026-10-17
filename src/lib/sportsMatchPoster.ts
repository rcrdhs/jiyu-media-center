/**
 * Shared sports card art — same VS split poster on Home “Your teams”,
 * Sports shelves, LiveXTV, and FullMatchShows.
 */

import { resolveMatchTeamLogos } from './teamLogos'

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeSvgUrl(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Strip replay/date noise so “Germany vs Serbia Full Match Replay…” parses cleanly. */
export function cleanSportsSideName(raw: string): string {
  return String(raw || '')
    .replace(/\bFull\s*Match(?:es)?\s*Replay\b[\s\S]*$/i, '')
    .replace(/\b(?:Match\s*)?Replay\b[\s\S]*$/i, '')
    .replace(/\bHighlights?\b[\s\S]*$/i, '')
    .replace(/\bExtended\b[\s\S]*$/i, '')
    .replace(/\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}\b[\s\S]*$/i, '')
    .replace(/\b(?:19|20)\d{2}\b[\s\S]*$/i, '')
    .replace(/\s*[|–—-]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseSportsMatchSides(
  title: string,
): { home: string; away: string } | null {
  const parts = String(title || '')
    .split(/\s+vs\.?\s+/i)
    .map((p) => cleanSportsSideName(p))
    .filter(Boolean)
  if (parts.length < 2) return null
  const home = parts[0]!.slice(0, 28)
  const away = parts[1]!.slice(0, 28)
  if (!home || !away) return null
  return { home, away }
}

type MatchPosterOptions = {
  subtitle?: string
  homeLogo?: string | null
  awayLogo?: string | null
}

function logoImage(url: string | null | undefined, cx: number): string {
  const src = String(url || '').trim()
  if (!/^https?:\/\//i.test(src) && !src.startsWith('data:')) return ''
  const href = escapeSvgUrl(src)
  // White disc behind crest so dark / transparent logos stay readable.
  return `<circle cx="${cx}" cy="118" r="44" fill="#f3f6fb" opacity="0.92"/>
  <image href="${href}" xlink:href="${href}" x="${cx - 36}" y="82" width="72" height="72" preserveAspectRatio="xMidYMid meet"/>`
}

/** Split-field VS poster used for every match-style sports card. */
export function sportsMatchPoster(title: string, options: MatchPosterOptions | string = ''): string {
  const opts: MatchPosterOptions =
    typeof options === 'string' ? { subtitle: options } : options || {}
  const sides = parseSportsMatchSides(title)
  const home = escapeSvgText(sides?.home || cleanSportsSideName(title).slice(0, 28) || 'Match')
  const away = escapeSvgText(sides?.away || 'Replay')
  const sub = escapeSvgText(String(opts.subtitle || 'Sports').slice(0, 28))
  const homeLogo = logoImage(opts.homeLogo, 160)
  const awayLogo = logoImage(opts.awayLogo, 480)
  // When logos are present, nudge team names down under the crests.
  const nameY = homeLogo || awayLogo ? 230 : 175
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2332"/>
      <stop offset="50%" stop-color="#121820"/>
      <stop offset="100%" stop-color="#0d3b2e"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <rect x="0" y="0" width="320" height="360" fill="#1e3a5f" opacity="0.55"/>
  <rect x="320" y="0" width="320" height="360" fill="#1a4d3a" opacity="0.55"/>
  ${homeLogo}
  ${awayLogo}
  <text x="160" y="${nameY}" text-anchor="middle" fill="#f3f6fb" font-family="Segoe UI,Arial,sans-serif" font-size="26" font-weight="700">${home}</text>
  <text x="480" y="${nameY}" text-anchor="middle" fill="#f3f6fb" font-family="Segoe UI,Arial,sans-serif" font-size="26" font-weight="700">${away}</text>
  <circle cx="320" cy="180" r="28" fill="#0b1220" stroke="#e8eef8" stroke-width="2"/>
  <text x="320" y="186" text-anchor="middle" fill="#e8eef8" font-family="Segoe UI,Arial,sans-serif" font-size="14" font-weight="700">VS</text>
  <text x="320" y="330" text-anchor="middle" fill="#9aa8bc" font-family="Segoe UI,Arial,sans-serif" font-size="16">${sub}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * Prefer the shared VS art for match titles so LiveXTV / FullMatchShows / Streamed
 * cards look the same in Your teams and every Sports shelf.
 */
export function sportsCardPoster(item: {
  title?: string
  poster?: string
  eventSport?: string
  category?: string
  homeBadgeUrl?: string
  awayBadgeUrl?: string
}): string {
  const title = String(item.title || '').trim()
  const sport = String(item.eventSport || 'Sports').trim()
  if (parseSportsMatchSides(title)) {
    return sportsMatchPoster(title, {
      subtitle: sport,
      homeLogo: item.homeBadgeUrl,
      awayLogo: item.awayBadgeUrl,
    })
  }
  const raw = String(item.poster || '').trim()
  if (raw.startsWith('data:image/')) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  if (title) return sportsMatchPoster(title, sport)
  return ''
}

/** Async VS poster with crest/flag lookup for both sides (when missing on the item). */
export async function resolveSportsCardPoster(item: {
  title?: string
  poster?: string
  eventSport?: string
  homeBadgeUrl?: string
  awayBadgeUrl?: string
}): Promise<string> {
  const title = String(item.title || '').trim()
  const sport = String(item.eventSport || 'Sports').trim()
  const sides = parseSportsMatchSides(title)
  if (!sides) return sportsCardPoster(item)

  const hasBoth =
    /^https?:\/\//i.test(String(item.homeBadgeUrl || '')) &&
    /^https?:\/\//i.test(String(item.awayBadgeUrl || ''))
  if (hasBoth) {
    return sportsMatchPoster(title, {
      subtitle: sport,
      homeLogo: item.homeBadgeUrl,
      awayLogo: item.awayBadgeUrl,
    })
  }

  const logos = await resolveMatchTeamLogos({
    home: sides.home,
    away: sides.away,
    homeBadgeUrl: item.homeBadgeUrl,
    awayBadgeUrl: item.awayBadgeUrl,
  })
  return sportsMatchPoster(title, {
    subtitle: sport,
    homeLogo: logos.homeLogo,
    awayLogo: logos.awayLogo,
  })
}
