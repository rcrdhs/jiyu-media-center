/**
 * Offline eval for on-device recommendations.
 *
 * Leave-one-out over each persona's last N qualifying watches: rank from the
 * watches (and feedback) that came before the holdout, then score where the
 * holdout landed. Reports Hit@5 / Hit@10, MRR, NDCG@10, catalog coverage,
 * intra-list genre diversity, duplicate-title rate and a cold-start check.
 *
 *   npm run test:recommendations
 *   npx tsx scripts/eval-recommendations.mts --last 4 --lambda 0.6 --full
 *   npx tsx scripts/eval-recommendations.mts --fixture path/to/fixture.json
 *
 * Fixture shape (single user):
 * {
 *   "items": StreamItem[],
 *   "history"?: WatchHistoryEntry[],
 *   "feedback"?: RecommendFeedbackEntry[],
 *   // or a raw localStorage export (values are the stored JSON strings):
 *   "localStorage"?: { "jiyu.watch-history.v1": "...", "jiyu.recommend-feedback.v1": "..." }
 * }
 *
 * Exit code 2 when a regression gate fails (stored per-watch abandons tank
 * the ranking, or the cold-start shelf is empty / single-category).
 */
import { readFileSync } from 'fs'
import {
  invalidateRecommendProfileCache,
  rankRecommendations,
  RECOMMEND_TUNABLES,
} from '../src/lib/recommendations.ts'
import type { CategoryId, StreamItem } from '../src/types.ts'
import type { WatchHistoryEntry } from '../src/lib/watchHistory.ts'
import type { RecommendFeedbackEntry } from '../src/lib/recommendFeedback.ts'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

type Persona = {
  name: string
  history: WatchHistoryEntry[]
  feedback: RecommendFeedbackEntry[]
}

const NOW = Date.now()
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Synthetic catalog: structural / provider tags like the real builders emit,
// plus TMDB-style genres. Includes cross-source duplicates.
// ---------------------------------------------------------------------------

function syntheticCatalog(): StreamItem[] {
  const movie = (id: string, title: string, year: number, genres: string[], shelf = 'popular-movies') =>
    ({
      id,
      title,
      description: '',
      category: 'movies' as CategoryId,
      url: `https://example.test/${id}`,
      tags: ['movies', 'cinetaro', 'web-embed', shelf],
      genres,
      releasedAt: Date.UTC(year, 5, 1),
      source: 'cinetaro',
      sourceKind: 'builtin',
      transport: 'direct',
    }) as StreamItem
  const series = (id: string, title: string, year: number, genres: string[], shelf = 'popular-series') =>
    ({
      id,
      title,
      description: '',
      category: 'series' as CategoryId,
      url: `https://example.test/${id}`,
      tags: ['series', 'cinetaro', 'web-embed', shelf],
      genres,
      releasedAt: Date.UTC(year, 5, 1),
      source: 'cinetaro',
      sourceKind: 'builtin',
      transport: 'direct',
    }) as StreamItem
  const anime = (id: string, title: string, year: number, genres: string[]) =>
    ({
      id,
      title,
      description: '',
      category: 'anime' as CategoryId,
      url: `https://example.test/${id}`,
      tags: ['anime', 'full-shows', 'nyaa', 'torrent'],
      genres,
      releasedAt: Date.UTC(year, 5, 1),
      source: 'nyaa',
      sourceKind: 'builtin',
      transport: 'torrent',
    }) as StreamItem

  const SF = 'Science Fiction'
  const TVSF = 'Sci-Fi & Fantasy'
  const AA = 'Action & Adventure'
  return [
    movie('interstellar', 'Interstellar', 2014, [SF, 'Adventure', 'Drama']),
    movie('inception', 'Inception', 2010, ['Action', SF, 'Thriller']),
    movie('arrival', 'Arrival', 2016, [SF, 'Drama', 'Mystery'], 'new-movies'),
    movie('blade', 'Blade Runner 2049', 2017, [SF, 'Drama']),
    movie('tenet', 'Tenet', 2020, ['Action', SF, 'Thriller']),
    movie('martian', 'The Martian', 2015, [SF, 'Adventure', 'Drama']),
    movie('dune', 'Dune', 2021, [SF, 'Adventure'], 'new-movies'),
    movie('exmachina', 'Ex Machina', 2015, [SF, 'Drama', 'Thriller']),
    movie('gravity', 'Gravity', 2013, [SF, 'Thriller']),
    movie('pride', 'Pride and Prejudice', 2005, ['Romance', 'Drama']),
    movie('notebook', 'The Notebook', 2004, ['Romance', 'Drama']),
    movie('titanic', 'Titanic', 1997, ['Romance', 'Drama']),
    movie('lalaland', 'La La Land', 2016, ['Romance', 'Music', 'Comedy']),
    movie('dunkirk', 'Dunkirk', 2017, ['War', 'Action', 'History']),
    movie('oppenheimer', 'Oppenheimer', 2023, ['Drama', 'History'], 'new-movies'),
    movie('barbie', 'Barbie', 2023, ['Comedy', 'Fantasy'], 'new-movies'),
    movie('johnwick', 'John Wick', 2014, ['Action', 'Thriller', 'Crime']),
    movie('darkknight', 'The Dark Knight', 2008, ['Action', 'Crime', 'Drama']),
    movie('getout', 'Get Out', 2017, ['Horror', 'Mystery', 'Thriller']),
    movie('hereditary', 'Hereditary', 2018, ['Horror', 'Drama']),
    movie('superbad', 'Superbad', 2007, ['Comedy']),
    // Cross-source duplicates (different id / provider, same title + year).
    {
      ...movie('yts-dune', 'Dune (2021)', 2021, [SF, 'Adventure']),
      tags: ['movies', 'yts', 'torrent', 'popular-movies'],
      source: 'yts',
      transport: 'torrent',
    } as StreamItem,
    {
      ...movie('yts-tenet', 'Tenet', 2020, ['Action', SF, 'Thriller']),
      tags: ['movies', 'yts', 'torrent', 'new-movies'],
      source: 'yts',
      transport: 'torrent',
    } as StreamItem,
    series('breakingbad', 'Breaking Bad', 2008, ['Crime', 'Drama']),
    series('saul', 'Better Call Saul', 2015, ['Crime', 'Drama']),
    series('ozark', 'Ozark', 2017, ['Crime', 'Drama']),
    series('narcos', 'Narcos', 2015, ['Crime', 'Drama'], 'trending-series'),
    series('expanse', 'The Expanse', 2015, [TVSF, 'Drama']),
    series('dark', 'Dark', 2017, [TVSF, 'Mystery', 'Crime']),
    series('severance', 'Severance', 2022, [TVSF, 'Mystery', 'Drama'], 'airing-series'),
    series('silo', 'Silo', 2023, [TVSF, 'Drama'], 'airing-series'),
    series('office', 'The Office', 2005, ['Comedy']),
    series('parks', 'Parks and Recreation', 2009, ['Comedy']),
    series('bridgerton', 'Bridgerton', 2020, ['Drama', 'Romance'], 'trending-series'),
    series('crown', 'The Crown', 2016, ['Drama', 'History']),
    series('truedetective', 'True Detective', 2014, ['Crime', 'Mystery', 'Drama']),
    series('mindhunter', 'Mindhunter', 2017, ['Crime', 'Drama', 'Mystery']),
    anime('aot', 'Attack on Titan', 2013, ['Animation', AA, TVSF]),
    anime('jjk', 'Jujutsu Kaisen', 2020, ['Animation', AA]),
    anime('demonslayer', 'Demon Slayer', 2019, ['Animation', AA, TVSF]),
    anime('chainsaw', 'Chainsaw Man', 2022, ['Animation', AA]),
    anime('spyfamily', 'Spy x Family', 2022, ['Animation', 'Comedy', AA]),
    anime('yourlie', 'Your Lie in April', 2014, ['Animation', 'Drama', 'Romance']),
    anime('violet', 'Violet Evergarden', 2018, ['Animation', 'Drama']),
    anime('mob', 'Mob Psycho 100', 2016, ['Animation', AA, 'Comedy']),
    anime('steins', 'Steins;Gate', 2011, ['Animation', TVSF, 'Drama']),
    anime('kaguya', 'Kaguya-sama: Love Is War', 2019, ['Animation', 'Comedy', 'Romance']),
  ]
}

/** [id, playhead seconds, finished] oldest → newest, one watch every 3 days. */
type Watch = [string, number, boolean]

function personaFromWatches(
  name: string,
  catalog: Map<string, StreamItem>,
  watches: Watch[],
  extraFeedback: RecommendFeedbackEntry[] = [],
): Persona {
  const history: WatchHistoryEntry[] = watches.map(([id, t, finished], i) => {
    const item = catalog.get(id)!
    return {
      id,
      title: item.title,
      category: item.category,
      playlistIndex: 0,
      currentTime: t,
      duration: 6000,
      finished,
      updatedAt: NOW - (watches.length - i) * 3 * DAY + DAY / 2,
    }
  })
  // Designed behaviour: a quick bail (< 60s) also leaves one abandon entry.
  const feedback: RecommendFeedbackEntry[] = [...extraFeedback]
  for (const h of history) {
    if (!h.finished && h.currentTime < RECOMMEND_TUNABLES.quickAbandonSec) {
      feedback.push({
        id: h.id,
        kind: 'abandon',
        title: h.title,
        category: h.category,
        count: 1,
        updatedAt: h.updatedAt,
      })
    }
  }
  return { name, history: history.sort((a, b) => b.updatedAt - a.updatedAt), feedback }
}

function syntheticPersonas(catalog: Map<string, StreamItem>): Persona[] {
  return [
    personaFromWatches(
      'sci-fi movies',
      catalog,
      [
        ['interstellar', 9000, true],
        ['inception', 8000, true],
        ['pride', 40, false],
        ['arrival', 6500, true],
        ['expanse', 1500, false],
        ['exmachina', 6000, true],
        ['dark', 2000, false],
        ['blade', 5000, false],
        ['tenet', 7000, true],
      ],
      [
        {
          id: 'barbie',
          kind: 'notInterested',
          title: 'Barbie',
          category: 'movies',
          count: 1,
          updatedAt: NOW - 20 * DAY,
        },
      ],
    ),
    personaFromWatches('crime series', catalog, [
      ['breakingbad', 3000, true],
      ['narcos', 1800, false],
      ['office', 45, false],
      ['ozark', 3000, true],
      ['mindhunter', 2200, false],
      ['darkknight', 8000, true],
      ['truedetective', 3200, true],
      ['saul', 2400, false],
    ]),
    personaFromWatches('anime action', catalog, [
      ['aot', 1400, true],
      ['demonslayer', 1400, true],
      ['yourlie', 50, false],
      ['jjk', 900, false],
      ['johnwick', 6000, true],
      ['chainsaw', 1400, true],
      ['spyfamily', 1200, false],
      ['mob', 1300, false],
    ]),
  ]
}

/**
 * What 0.3.73 actually stores: every title that crosses 5–60s while playing
 * leaves an abandon entry (reinforced every progress tick).
 */
function withStoredAbandons(p: Persona): Persona {
  const extra: RecommendFeedbackEntry[] = p.history
    .filter((h) => !p.feedback.some((f) => f.id === h.id))
    .map((h) => ({
      id: h.id,
      kind: 'abandon' as const,
      title: h.title,
      category: h.category,
      count: 50,
      // Same instant as the watch row, so a holdout's own entry isn't "known" before it.
      updatedAt: h.updatedAt,
    }))
  return { name: `${p.name} +stored abandons`, history: p.history, feedback: [...p.feedback, ...extra] }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function genreSet(item: StreamItem): Set<string> {
  const raw = (item as StreamItem & { genres?: string[] }).genres ?? []
  const out = new Set<string>()
  for (const g of raw) {
    for (const part of String(g).toLowerCase().split(/\s*&\s*|\s*,\s*/)) {
      const clean = part.replace('science fiction', 'sci-fi').trim()
      if (clean) out.add(clean)
    }
  }
  return out
}

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return 1 - inter / (a.size + b.size - inter)
}

function normTitle(item: StreamItem): string {
  const year = item.releasedAt ? new Date(item.releasedAt).getUTCFullYear() : ''
  return `${item.title.toLowerCase().replace(/\(\d{4}\)/, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${year}`
}

type Metrics = {
  cases: number
  hit5: number
  hit10: number
  mrr: number
  ndcg10: number
  coverage: number
  diversity: number
  dupRate: number
}

type Tunables = {
  mmrLambda: number
  halfLifeDays: number
  scoreThreshold: number
  negativeCosineWeight: number
}

function evaluate(
  items: StreamItem[],
  personas: Persona[],
  lastN: number,
  tunables: Tunables,
  verbose: boolean,
): Metrics {
  const K = 10
  let cases = 0
  let hit5 = 0
  let hit10 = 0
  let rr = 0
  let ndcg = 0
  let diversitySum = 0
  let dupLists = 0
  const shown = new Set<string>()
  const byId = new Map(items.map((i) => [i.id, i]))

  for (const p of personas) {
    const qualifying = p.history.filter(
      (h) => h.finished || h.currentTime >= RECOMMEND_TUNABLES.quickAbandonSec,
    )
    for (const holdout of qualifying.slice(0, lastN)) {
      // Only what happened before the holdout was watched.
      const train = p.history.filter((h) => h.updatedAt < holdout.updatedAt)
      if (train.length === 0) continue
      const feedback = p.feedback.filter((f) => f.updatedAt < holdout.updatedAt)
      // Mirror the shelf: titles on Continue watching (in progress, newest 8 per category) are excluded.
      const perCat = new Map<string, number>()
      const continueIds = train
        .filter((h) => !h.finished && h.currentTime >= RECOMMEND_TUNABLES.quickAbandonSec)
        .filter((h) => {
          const n = perCat.get(h.category) ?? 0
          perCat.set(h.category, n + 1)
          return n < 8
        })
        .map((h) => h.id)
      invalidateRecommendProfileCache()
      const ranked = rankRecommendations({
        items,
        history: train,
        feedback,
        limit: 48,
        excludeIds: continueIds,
        ...tunables,
      })
      const idx = ranked.findIndex((r) => r.item.id === holdout.id)
      cases++
      if (idx >= 0 && idx < 5) hit5++
      if (idx >= 0 && idx < K) {
        hit10++
        ndcg += 1 / Math.log2(idx + 2)
      }
      if (idx >= 0) rr += 1 / (idx + 1)

      const top = ranked.slice(0, K).map((r) => r.item)
      for (const it of top) shown.add(it.id)
      let pairs = 0
      let dist = 0
      for (let i = 0; i < top.length; i++) {
        for (let j = i + 1; j < top.length; j++) {
          pairs++
          dist += jaccardDistance(genreSet(top[i]!), genreSet(byId.get(top[j]!.id)!))
        }
      }
      diversitySum += pairs ? dist / pairs : 0
      if (new Set(top.map(normTitle)).size < top.length) dupLists++

      if (verbose) {
        console.log(
          `  [${p.name}] holdout ${holdout.title}: rank ${idx >= 0 ? idx + 1 : '-'} | top5 ${top
            .slice(0, 5)
            .map((t) => t.title)
            .join(', ')}`,
        )
      }
    }
  }
  const d = cases || 1
  return {
    cases,
    hit5: hit5 / d,
    hit10: hit10 / d,
    mrr: rr / d,
    ndcg10: ndcg / d,
    coverage: shown.size / Math.max(1, items.length),
    diversity: diversitySum / d,
    dupRate: dupLists / d,
  }
}

function fmt(m: Metrics): string {
  const f = (n: number) => n.toFixed(3)
  return `cases=${m.cases} Hit@5=${f(m.hit5)} Hit@10=${f(m.hit10)} MRR=${f(m.mrr)} NDCG@10=${f(m.ndcg10)} coverage=${f(m.coverage)} diversity=${f(m.diversity)} dupRate=${f(m.dupRate)}`
}

// ---------------------------------------------------------------------------

const lastN = Number(arg('--last', '4')) || 4
const tunables: Tunables = {
  mmrLambda: Number(arg('--lambda', String(RECOMMEND_TUNABLES.mmrLambda))),
  halfLifeDays: Number(arg('--half-life', String(RECOMMEND_TUNABLES.halfLifeDays))),
  scoreThreshold: Number(arg('--threshold', String(RECOMMEND_TUNABLES.scoreThreshold))),
  negativeCosineWeight: Number(arg('--neg', String(RECOMMEND_TUNABLES.negativeCosineWeight))),
}
const verbose = hasFlag('--full')
const fixturePath = arg('--fixture')

let items: StreamItem[]
let personas: Persona[]

if (fixturePath) {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    items: StreamItem[]
    history?: WatchHistoryEntry[]
    feedback?: RecommendFeedbackEntry[]
    localStorage?: Record<string, string>
  }
  items = raw.items || []
  const ls = raw.localStorage || {}
  const parse = <T,>(key: string): T[] => {
    try {
      const v = ls[key] ? JSON.parse(ls[key]!) : []
      return Array.isArray(v) ? v : Object.values(v || {})
    } catch {
      return []
    }
  }
  const history = raw.history || parse<WatchHistoryEntry>('jiyu.watch-history.v1')
  const feedback = raw.feedback || parse<RecommendFeedbackEntry>('jiyu.recommend-feedback.v1')
  personas = [
    { name: 'fixture', history: [...history].sort((a, b) => b.updatedAt - a.updatedAt), feedback },
  ]
  console.log(`fixture ${fixturePath}: items=${items.length} history=${history.length} feedback=${feedback.length}`)
} else {
  items = syntheticCatalog()
  personas = syntheticPersonas(new Map(items.map((i) => [i.id, i])))
  console.log(`synthetic fixture: items=${items.length} personas=${personas.length} (pass --fixture for a real export)`)
}
console.log(`leave-one-out over last ${lastN} watches, tunables ${JSON.stringify(tunables)}\n`)

console.log('--- Clean (designed signals) ---')
const clean = evaluate(items, personas, lastN, tunables, verbose)
console.log(fmt(clean))

console.log('\n--- Regression: abandon stored for every watch (0.3.73 behaviour) ---')
const stored = evaluate(items, personas.map(withStoredAbandons), lastN, tunables, verbose)
console.log(fmt(stored))

console.log('\n--- Cold start (no history, no feedback) ---')
invalidateRecommendProfileCache()
const cold = rankRecommendations({ items, history: [], feedback: [], limit: 16, ...tunables })
const coldCats = new Set(cold.map((r) => r.item.category))
console.log(
  `size=${cold.length} categories=${[...coldCats].join('/') || '-'} first6=${cold
    .slice(0, 6)
    .map((r) => `${r.item.title} [${r.item.category}]`)
    .join(', ')}`,
)

const gates: string[] = []
if (clean.cases > 0 && stored.mrr < clean.mrr * 0.8) {
  gates.push(`stored-abandon MRR ${stored.mrr.toFixed(3)} < 80% of clean ${clean.mrr.toFixed(3)}`)
}
if (!fixturePath && (cold.length < 8 || coldCats.size < 2)) {
  gates.push(`cold start returned ${cold.length} items across ${coldCats.size} categories`)
}
if (gates.length) {
  console.log(`\nFAIL:\n- ${gates.join('\n- ')}`)
  process.exit(2)
}
console.log('\nPASS')
