/**
 * Group football/soccer catalog items into league shelves (EPL, Bundesliga, …).
 * Streamed only exposes sport = "football"; PPV/LiveXTV often carry league labels.
 * Team / title heuristics fill the rest.
 */

import type { StreamItem } from '../types'

export interface FootballLeagueShelf {
  id: string
  label: string
  items: StreamItem[]
}

type LeagueDef = {
  id: string
  label: string
  /** Match against title / eventSport / tags */
  patterns: RegExp
  /** Optional club-name hints when the source only has "Team A vs Team B" */
  clubs?: RegExp
}

const LEAGUES: LeagueDef[] = [
  {
    id: 'ucl',
    label: 'Champions League',
    patterns: /\b(ucl|champions\s*league|uefa\s*champions)\b/i,
  },
  {
    id: 'uel',
    label: 'Europa League',
    patterns: /\b(uel|europa\s*league|uefa\s*europa)\b/i,
  },
  {
    id: 'uecl',
    label: 'Conference League',
    patterns: /\b(uecl|conference\s*league|europa\s*conference)\b/i,
  },
  {
    id: 'epl',
    label: 'EPL',
    patterns: /\b(epl|premier\s*league|english\s*premier)\b/i,
    clubs:
      /\b(arsenal|liverpool|chelsea|tottenham|spurs|manchester\s*united|man\s*united|manchester\s*city|man\s*city|newcastle|aston\s*villa|brighton|west\s*ham|crystal\s*palace|fulham|brentford|wolves|wolverhampton|everton|nottingham\s*forest|bournemouth|ips?wich|leicester|southampton|burnley|leeds|sheffield\s*united)\b/i,
  },
  {
    id: 'championship',
    label: 'Championship',
    patterns: /\b(efl\s*)?championship\b/i,
  },
  {
    id: 'bundesliga',
    label: 'Bundesliga',
    patterns: /\b(bundesliga|german\s*bundesliga)\b/i,
    clubs:
      /\b(bayern|dortmund|leverkusen|leipzig|rb\s*leipzig|frankfurt|eintracht|wolfsburg|gladbach|mönchengladbach|monchengladbach|stuttgart|freiburg|hoffenheim|augsburg|mainz|union\s*berlin|bochum|heidenheim|werder|bremen|köln|koln|cologne|hertha|schalke|hamburg)\b/i,
  },
  {
    id: 'laliga',
    label: 'La Liga',
    patterns: /\b(la\s*liga|laliga|spanish\s*liga)\b/i,
    clubs:
      /\b(real\s*madrid|barcelona|barça|barca|atletico|atlético|sevilla|villarreal|real\s*sociedad|athletic\s*(?:club|bilbao)|betis|osasuna|valencia|getafe|girona|celta|mallorca|alaves|alavés|las\s*palmas|rayo|cadiz|cádiz|espanyol|valladolid|elche)\b/i,
  },
  {
    id: 'seriea',
    label: 'Serie A',
    patterns: /\b(serie\s*a|italian\s*serie)\b/i,
    clubs:
      /\b(inter(?:nazionale)?|milan|ac\s*milan|juventus|napoli|roma|lazio|atalanta|fiorentina|bologna|torino|udinese|sassuolo|empoli|monza|lecce|cagliari|genoa|verona|salernitana|spezia|venezia|parma|como)\b/i,
  },
  {
    id: 'ligue1',
    label: 'Ligue 1',
    patterns: /\b(ligue\s*1|french\s*ligue)\b/i,
    clubs:
      /\b(psg|paris\s*saint[- ]?germain|marseille|lyon|monaco|lille|nice|rennes|lens|strasbourg|nantes|toulouse|montpellier|reims|brest|angers|auxerre|le\s*havre|metz|clermont)\b/i,
  },
  {
    id: 'eredivisie',
    label: 'Eredivisie',
    patterns: /\b(eredivisie)\b/i,
    clubs: /\b(ajax|psv|feyenoord|az\s*alkmaar|twente|utrecht)\b/i,
  },
  {
    id: 'ligaportugal',
    label: 'Liga Portugal',
    patterns: /\b(liga\s*portugal|primeira\s*liga)\b/i,
    clubs: /\b(benfica|porto|sporting\s*cp|sporting\s*lisbon|braga)\b/i,
  },
  {
    id: 'mls',
    label: 'MLS',
    patterns: /\b(mls|major\s*league\s*soccer)\b/i,
  },
  {
    id: 'ligamx',
    label: 'Liga MX',
    patterns: /\b(liga\s*mx|mexican\s*liga)\b/i,
  },
  {
    id: 'saudi',
    label: 'Saudi Pro League',
    patterns: /\b(saudi|spl|pro\s*league)\b/i,
    clubs: /\b(al[- ]?hilal|al[- ]?nassr|al[- ]?ahli|al[- ]?ittihad)\b/i,
  },
  {
    id: 'facup',
    label: 'FA Cup',
    patterns: /\b(fa\s*cup)\b/i,
  },
  {
    id: 'worldcup',
    label: 'World Cup / Internationals',
    patterns: /\b(world\s*cup|euro\s*202|nations\s*league|friendly|international)\b/i,
  },
]

const OTHER: FootballLeagueShelf = { id: 'other', label: 'Other football', items: [] }

function haystack(item: StreamItem): string {
  const tags = (item.tags || []).join(' ')
  return `${item.title || ''} ${item.eventSport || ''} ${item.description || ''} ${tags}`
}

/** True when this sports item is football/soccer (not NFL etc.). */
export function isFootballSportsItem(item: StreamItem): boolean {
  const blob = haystack(item).toLowerCase()
  if (/\bnfl\b|american\s*football|gridiron/.test(blob)) return false
  if (
    /\b(football|soccer|epl|mls|premier\s*league|bundesliga|la\s*liga|serie\s*a|ligue\s*1|eredivisie|champions\s*league|europa\s*league|conference\s*league|nations\s*league|world\s*cup|fa\s*cup|copa\s*america|liga\s*mx|fifa|uefa|euro\s*20\d{2})\b/.test(
      blob,
    )
  ) {
    return true
  }
  if (item.tags?.some((t) => /^football$/i.test(String(t || '')))) return true
  if (/^football$/i.test(String(item.eventSport || ''))) return true
  return false
}

export function footballLeagueId(item: StreamItem): string {
  const text = haystack(item)
  for (const league of LEAGUES) {
    if (league.patterns.test(text)) return league.id
  }
  for (const league of LEAGUES) {
    if (league.clubs && league.clubs.test(text)) return league.id
  }
  return OTHER.id
}

export function footballLeagueLabel(id: string): string {
  if (id === OTHER.id) return OTHER.label
  return LEAGUES.find((l) => l.id === id)?.label || OTHER.label
}

/** Preferred shelf order for football Live / Popular / Replay. */
const LEAGUE_ORDER = [
  'epl',
  'laliga',
  'bundesliga',
  'seriea',
  'ligue1',
  'ucl',
  'uel',
  'uecl',
  'championship',
  'eredivisie',
  'ligaportugal',
  'mls',
  'ligamx',
  'saudi',
  'facup',
  'worldcup',
  'other',
]

export function groupFootballByLeague(items: StreamItem[]): FootballLeagueShelf[] {
  const buckets = new Map<string, StreamItem[]>()
  for (const item of items) {
    const id = footballLeagueId(item)
    const list = buckets.get(id)
    if (list) list.push(item)
    else buckets.set(id, [item])
  }
  const shelves: FootballLeagueShelf[] = []
  for (const id of LEAGUE_ORDER) {
    const list = buckets.get(id)
    if (!list?.length) continue
    shelves.push({ id, label: footballLeagueLabel(id), items: list })
    buckets.delete(id)
  }
  for (const [id, list] of buckets) {
    if (!list.length) continue
    shelves.push({ id, label: footballLeagueLabel(id), items: list })
  }
  return shelves
}

function titleCaseSport(raw: string): string {
  return String(raw || '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Sport shelf label for mixed Live / Upcoming / Replay grids. */
export function sportsShelfLabel(item: StreamItem): string {
  const event = String(item.eventSport || '').trim()
  if (event && !/^24\/7$/i.test(event)) return event
  const tagSport = (item.tags || []).find(
    (t) =>
      t &&
      !/^(live|live-now|upcoming|streamed|streamcorner|ppv|ppv\.st|futbolx|hls|popular|replay|vod|web-embed|torrent)$/i.test(
        t,
      ),
  )
  if (tagSport) return titleCaseSport(tagSport)
  return 'Other sports'
}

function groupByLabel(
  items: StreamItem[],
  labelFor: (item: StreamItem) => string,
  idPrefix = 'sport',
): FootballLeagueShelf[] {
  const buckets = new Map<string, { label: string; items: StreamItem[] }>()
  for (const item of items) {
    const label = labelFor(item) || 'Other'
    const id = `${idPrefix}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const hit = buckets.get(id)
    if (hit) hit.items.push(item)
    else buckets.set(id, { label, items: [item] })
  }
  return [...buckets.entries()]
    .map(([id, { label, items: list }]) => ({ id, label, items: list }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * All-sports view: football → league shelves; everything else → sport shelves.
 * Used on Live / Upcoming / Replay when the sport chip is “All sports”.
 */
export function groupAllSportsShelves(items: StreamItem[]): FootballLeagueShelf[] {
  const football = items.filter(isFootballSportsItem)
  const other = items.filter((item) => !isFootballSportsItem(item))
  return [...groupFootballByLeague(football), ...groupByLabel(other, sportsShelfLabel, 'sport')]
}

/**
 * Single-sport chip (basketball, cricket, …): split by league / eventSport when
 * there are multiple subdivisions; otherwise return [] so the flat grid is used.
 */
export function groupSportBySubdivision(items: StreamItem[]): FootballLeagueShelf[] {
  if (items.length < 2) return []
  const shelves = groupByLabel(items, sportsShelfLabel, 'sub')
  return shelves.length > 1 ? shelves : []
}

/**
 * Pick the right shelf grouping for Sports Live / Upcoming / Replay.
 * - football chip → leagues
 * - all sports → leagues + other sports
 * - other chip → subdivision shelves when useful
 */
export function groupSportsSectionShelves(
  items: StreamItem[],
  sportFilter: string,
): FootballLeagueShelf[] | null {
  if (!items.length) return null
  if (sportFilter === 'football') {
    const shelves = groupFootballByLeague(items)
    return shelves.length ? shelves : null
  }
  if (sportFilter === 'all') {
    const shelves = groupAllSportsShelves(items)
    return shelves.length ? shelves : null
  }
  const shelves = groupSportBySubdivision(items)
  return shelves.length ? shelves : null
}
