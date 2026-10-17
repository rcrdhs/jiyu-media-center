/**
 * Holdout eval for on-device recommendations.
 *
 * Holds out the newest qualifying watch, ranks from the rest, reports Hit@K.
 * Use this to tune HALF_LIFE / λ / thresholds in RECOMMEND_TUNABLES.
 *
 *   npx tsx scripts/eval-recommendations.mts
 *   npx tsx scripts/eval-recommendations.mts --fixture path/to/fixture.json
 *   npx tsx scripts/eval-recommendations.mts --k 16 --lambda 0.6
 *
 * Fixture shape:
 * {
 *   "items": StreamItem[],
 *   "history": WatchHistoryEntry[],
 *   "feedback"?: RecommendFeedbackEntry[]
 * }
 */
import { readFileSync } from 'fs'
import {
  evaluateHoldout,
  RECOMMEND_TUNABLES,
  rankRecommendations,
} from '../src/lib/recommendations.ts'
import type { StreamItem } from '../src/types.ts'
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

/** Synthetic catalog + history so the harness runs without a fixture. */
function syntheticFixture(): {
  items: StreamItem[]
  history: WatchHistoryEntry[]
  feedback: RecommendFeedbackEntry[]
} {
  const mk = (
    id: string,
    title: string,
    category: StreamItem['category'],
    tags: string[],
  ): StreamItem => ({
    id,
    title,
    category,
    url: `https://example.test/${id}`,
    tags,
    source: 'eval',
    sourceKind: 'builtin',
    transport: 'direct',
  })

  const items: StreamItem[] = [
    mk('interstellar', 'Interstellar', 'movies', ['sci-fi', 'thriller', 'popular']),
    mk('arrival', 'Arrival', 'movies', ['sci-fi', 'drama']),
    mk('inception', 'Inception', 'movies', ['sci-fi', 'thriller', 'popular']),
    mk('dunkirk', 'Dunkirk', 'movies', ['war', 'thriller']),
    mk('pride', 'Pride and Prejudice', 'movies', ['romance', 'drama']),
    mk('notebook', 'The Notebook', 'movies', ['romance', 'drama']),
    mk('blade', 'Blade Runner 2049', 'movies', ['sci-fi', 'thriller']),
    mk('martian', 'The Martian', 'movies', ['sci-fi', 'adventure']),
    mk('titanic', 'Titanic', 'movies', ['romance', 'drama', 'popular']),
    mk('tenet', 'Tenet', 'movies', ['sci-fi', 'thriller']),
    mk('oppenheimer', 'Oppenheimer', 'movies', ['drama', 'history']),
    mk('barbie', 'Barbie', 'movies', ['comedy', 'fantasy']),
  ]

  const now = Date.now()
  const day = 86_400_000
  const history: WatchHistoryEntry[] = [
    {
      id: 'interstellar',
      title: 'Interstellar',
      category: 'movies',
      playlistIndex: 0,
      currentTime: 7200,
      duration: 10140,
      finished: true,
      updatedAt: now - 2 * day,
    },
    {
      id: 'inception',
      title: 'Inception',
      category: 'movies',
      playlistIndex: 0,
      currentTime: 8000,
      duration: 8880,
      finished: true,
      updatedAt: now - 5 * day,
    },
    {
      id: 'pride',
      title: 'Pride and Prejudice',
      category: 'movies',
      playlistIndex: 0,
      currentTime: 40,
      duration: 7200,
      finished: false,
      updatedAt: now - 1 * day,
    },
    {
      id: 'blade',
      title: 'Blade Runner 2049',
      category: 'movies',
      playlistIndex: 0,
      currentTime: 5000,
      duration: 9840,
      finished: false,
      updatedAt: now - day / 2,
    },
  ]

  const feedback: RecommendFeedbackEntry[] = [
    {
      id: 'barbie',
      kind: 'notInterested',
      title: 'Barbie',
      category: 'movies',
      tags: ['comedy', 'fantasy'],
      count: 1,
      updatedAt: now - 3 * day,
    },
  ]

  return { items, history, feedback }
}

const fixturePath = arg('--fixture')
const k = Number(arg('--k', '16')) || 16
const lambda = Number(arg('--lambda', String(RECOMMEND_TUNABLES.mmrLambda)))
const halfLife = Number(arg('--half-life', String(RECOMMEND_TUNABLES.halfLifeDays)))
const threshold = Number(arg('--threshold', String(RECOMMEND_TUNABLES.scoreThreshold)))
const negW = Number(arg('--neg', String(RECOMMEND_TUNABLES.negativeCosineWeight)))

let items: StreamItem[]
let history: WatchHistoryEntry[]
let feedback: RecommendFeedbackEntry[]

if (fixturePath) {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    items: StreamItem[]
    history: WatchHistoryEntry[]
    feedback?: RecommendFeedbackEntry[]
  }
  items = raw.items || []
  history = raw.history || []
  feedback = raw.feedback || []
  console.log(`fixture ${fixturePath}: items=${items.length} history=${history.length} feedback=${feedback.length}`)
} else {
  const syn = syntheticFixture()
  items = syn.items
  history = syn.history
  feedback = syn.feedback
  console.log('synthetic fixture (pass --fixture to use real export)')
}

const tunables = {
  mmrLambda: lambda,
  halfLifeDays: halfLife,
  scoreThreshold: threshold,
  negativeCosineWeight: negW,
}

const result = evaluateHoldout({
  items,
  history,
  feedback,
  k,
  ...tunables,
})

console.log('\n--- Holdout ---')
console.log(
  JSON.stringify(
    {
      holdoutId: result.holdoutId,
      holdoutTitle: result.holdoutTitle,
      rank: result.rank,
      hitAtK: result.hitAtK,
      k: result.k,
      tunables,
    },
    null,
    2,
  ),
)

console.log('\n--- Top-K ---')
for (const [i, row] of result.top.entries()) {
  const mark = row.id === result.holdoutId ? ' ← holdout' : ''
  console.log(`${String(i + 1).padStart(2)}. ${row.score.toFixed(3)}  ${row.title}${mark}`)
}

if (hasFlag('--full')) {
  const ranked = rankRecommendations({
    items,
    history,
    feedback,
    limit: k,
    ...tunables,
  })
  console.log('\n--- Full rank (no holdout) ---')
  for (const [i, row] of ranked.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${row.score.toFixed(3)}  ${row.item.title}  (${row.reason})`)
  }
}

process.exit(result.ok && result.hitAtK ? 0 : 2)
