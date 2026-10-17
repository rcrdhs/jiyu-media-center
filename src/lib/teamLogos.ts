/**
 * Resolve crest / flag URLs for sports VS cards.
 * Priority: catalog badges (Streamed) → national flags → Wikipedia thumbnail.
 */

const memoryCache = new Map<string, string | null>()
const STORAGE_KEY = 'jiyu.team-logo.v1'
const MAX_STORED = 200

/** Common national-team name → flagcdn ISO (or regional) code. */
const NATIONAL_FLAGS: Record<string, string> = {
  algeria: 'dz',
  argentina: 'ar',
  australia: 'au',
  austria: 'at',
  belgium: 'be',
  brazil: 'br',
  cameroon: 'cm',
  canada: 'ca',
  chile: 'cl',
  china: 'cn',
  colombia: 'co',
  croatia: 'hr',
  czechia: 'cz',
  'czech republic': 'cz',
  denmark: 'dk',
  ecuador: 'ec',
  egypt: 'eg',
  england: 'gb-eng',
  finland: 'fi',
  france: 'fr',
  germany: 'de',
  ghana: 'gh',
  greece: 'gr',
  hungary: 'hu',
  iceland: 'is',
  india: 'in',
  iran: 'ir',
  iraq: 'iq',
  ireland: 'ie',
  'republic of ireland': 'ie',
  italy: 'it',
  'ivory coast': 'ci',
  "cote d'ivoire": 'ci',
  jamaica: 'jm',
  japan: 'jp',
  mexico: 'mx',
  morocco: 'ma',
  netherlands: 'nl',
  'new zealand': 'nz',
  nigeria: 'ng',
  'northern ireland': 'gb-nir',
  norway: 'no',
  paraguay: 'py',
  peru: 'pe',
  poland: 'pl',
  portugal: 'pt',
  qatar: 'qa',
  romania: 'ro',
  russia: 'ru',
  'saudi arabia': 'sa',
  scotland: 'gb-sct',
  senegal: 'sn',
  serbia: 'rs',
  slovakia: 'sk',
  slovenia: 'si',
  'south africa': 'za',
  'south korea': 'kr',
  korea: 'kr',
  spain: 'es',
  sweden: 'se',
  switzerland: 'ch',
  tunisia: 'tn',
  turkey: 'tr',
  ukraine: 'ua',
  uruguay: 'uy',
  usa: 'us',
  'united states': 'us',
  wales: 'gb-wls',
}

function normalizeTeamKey(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function readDiskCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDiskCache(map: Record<string, string>) {
  try {
    const entries = Object.entries(map)
    const trimmed =
      entries.length > MAX_STORED
        ? Object.fromEntries(entries.slice(entries.length - MAX_STORED))
        : map
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

function flagUrl(code: string): string {
  return `https://flagcdn.com/w160/${code}.png`
}

async function wikipediaThumb(teamName: string): Promise<string | null> {
  const candidates = [
    teamName,
    `${teamName} F.C.`,
    `${teamName} FC`,
    `${teamName} national football team`,
  ]
  for (const title of candidates) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        title.replace(/\s+/g, '_'),
      )}`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) continue
      const data = (await res.json()) as {
        thumbnail?: { source?: string }
        originalimage?: { source?: string }
        type?: string
      }
      if (data.type === 'disambiguation') continue
      const src = data.thumbnail?.source || data.originalimage?.source
      if (src && /^https?:\/\//i.test(src)) return src
    } catch {
      /* try next */
    }
  }
  return null
}

/** Resolve a single team crest/flag URL (cached). */
export async function resolveTeamLogoUrl(
  teamName: string,
  preferred?: string,
): Promise<string | null> {
  const preferredUrl = String(preferred || '').trim()
  if (/^https?:\/\//i.test(preferredUrl)) return preferredUrl

  const key = normalizeTeamKey(teamName)
  if (!key) return null
  if (memoryCache.has(key)) return memoryCache.get(key) ?? null

  const disk = readDiskCache()
  if (disk[key]) {
    memoryCache.set(key, disk[key]!)
    return disk[key]!
  }

  const flag = NATIONAL_FLAGS[key]
  if (flag) {
    const url = flagUrl(flag)
    memoryCache.set(key, url)
    disk[key] = url
    writeDiskCache(disk)
    return url
  }

  const wiki = await wikipediaThumb(teamName)
  memoryCache.set(key, wiki)
  if (wiki) {
    disk[key] = wiki
    writeDiskCache(disk)
  }
  return wiki
}

export async function resolveMatchTeamLogos(input: {
  home: string
  away: string
  homeBadgeUrl?: string
  awayBadgeUrl?: string
}): Promise<{ homeLogo: string | null; awayLogo: string | null }> {
  const [homeLogo, awayLogo] = await Promise.all([
    resolveTeamLogoUrl(input.home, input.homeBadgeUrl),
    resolveTeamLogoUrl(input.away, input.awayBadgeUrl),
  ])
  return { homeLogo, awayLogo }
}
