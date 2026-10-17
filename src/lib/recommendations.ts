/**
 * On-device personalized recommendations (private, local only).
 *
 * TF–IDF cosine over titles + tags, exponential recency, negative signals
 * (abandon / not interested / dislike), MMR diversity, and an in-memory
 * profile cache invalidated on watch / feedback events.
 */

import type { CategoryId, StreamItem } from '../types'
import {
  dropRecommendAbandons,
  listRecommendFeedback,
  RECOMMEND_FEEDBACK_EVENT,
  recommendFeedbackSignature,
  type RecommendFeedbackEntry,
} from './recommendFeedback'
import { listWatchHistory, WATCH_HISTORY_EVENT, type WatchHistoryEntry } from './watchHistory'
import { genreLabel, normalizeGenres } from './genres'
import { CATALOG_STRUCTURE_TAGS } from './language'

export interface UserTasteProfile {
  totalWatched: number
  categoryWeights: Record<string, number>
  tagWeights: Record<string, number>
  keywordWeights: Record<string, number>
  /** Negative keyword / tag space (abandons + dislikes). */
  negativeKeywordWeights: Record<string, number>
  negativeTagWeights: Record<string, number>
  /** Finished non-episodic titles (movies) — excluded. */
  completedIds: Set<string>
  /** Series / anime watched past the first minute — one finished episode never excludes a show. */
  episodicWatchedIds: Set<string>
  /** Hard-exclude from the shelf (dislike / not interested — not abandons). */
  blockedIds: Set<string>
  topCategory: CategoryId | null
}

export interface RecommendedItem {
  item: StreamItem
  score: number
  reason: string
}

/** Tunables — keep in sync with scripts/eval-recommendations.mts. */
export const RECOMMEND_TUNABLES = {
  halfLifeDays: 21,
  mmrLambda: 0.5,
  scoreThreshold: 0.05,
  negativeCosineWeight: 0.55,
  quickAbandonSec: 60,
} as const

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'up',
  'about',
  'into',
  'over',
  'after',
  'season',
  'episode',
  'part',
  'chapter',
  'vol',
  'volume',
  'series',
  'movie',
  'full',
  'hd',
  '720p',
  '1080p',
  '4k',
  'official',
  'stream',
  'live',
  'tv',
  'watch',
  'dub',
  'sub',
])

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}

function buildIdf(items: StreamItem[]): Record<string, number> {
  const df: Record<string, number> = {}
  for (const item of items) {
    const seen = new Set(tokenizeTitle(item.title))
    for (const t of seen) df[t] = (df[t] || 0) + 1
  }
  const N = items.length
  const idf: Record<string, number> = {}
  for (const [t, d] of Object.entries(df)) {
    idf[t] = Math.log((N + 1) / (d + 1)) + 1
  }
  return idf
}

const LN2 = Math.LN2
const DAY_MS = 86_400_000

function recency(updatedAt: number, now: number, halfLifeDays: number): number {
  const days = Math.max(0, (now - updatedAt) / DAY_MS)
  return Math.exp((-LN2 * days) / halfLifeDays)
}

const tasteGenreCache = new WeakMap<StreamItem, string[]>()

/**
 * Genre slugs that describe taste: `item.genres` plus genre-like tags.
 * Structural / provider / shelf tags (movies, cinetaro, torrent,
 * popular-movies, web-embed, …) never count.
 */
export function itemTasteGenres(item: StreamItem | undefined): string[] {
  if (!item) return []
  const cached = tasteGenreCache.get(item)
  if (cached) return cached
  const tags = (item.tags ?? []).filter(
    (t) => !CATALOG_STRUCTURE_TAGS.has(String(t || '').toLowerCase().trim()),
  )
  const genres = normalizeGenres([...(item.genres ?? []), ...tags])
  tasteGenreCache.set(item, genres)
  return genres
}

/** Genres stored with the signal (history / feedback) win; else the catalog row. */
function genresFor(
  id: string,
  catalogById: Map<string, StreamItem> | undefined,
  own?: string[],
): string[] {
  const fromOwn = normalizeGenres(own)
  if (fromOwn.length) return fromOwn
  return itemTasteGenres(catalogById?.get(id))
}

function addTagWeights(
  tagWeights: Record<string, number>,
  tags: string[],
  w: number,
) {
  for (const tag of tags) tagWeights[tag] = (tagWeights[tag] || 0) + w
}

export type BuildProfileOptions = {
  idf: Record<string, number>
  catalogById?: Map<string, StreamItem>
  feedback?: RecommendFeedbackEntry[]
  halfLifeDays?: number
  quickAbandonSec?: number
}

export function buildUserTasteProfile(
  history: WatchHistoryEntry[],
  options: BuildProfileOptions,
): UserTasteProfile {
  const idf = options.idf
  const catalogById = options.catalogById
  const feedback = options.feedback ?? []
  const halfLifeDays = options.halfLifeDays ?? RECOMMEND_TUNABLES.halfLifeDays
  const quickAbandonSec = options.quickAbandonSec ?? RECOMMEND_TUNABLES.quickAbandonSec

  const categoryWeights: Record<string, number> = {}
  const tagWeights: Record<string, number> = {}
  const keywordWeights: Record<string, number> = {}
  const negativeKeywordWeights: Record<string, number> = {}
  const negativeTagWeights: Record<string, number> = {}
  const completedIds = new Set<string>()
  const episodicWatchedIds = new Set<string>()
  const blockedIds = new Set<string>()
  const now = Date.now()

  for (const entry of history) {
    if (isEpisodicEntry(entry, catalogById?.get(entry.id))) {
      if (entry.finished || entry.currentTime >= quickAbandonSec) episodicWatchedIds.add(entry.id)
    } else if (entry.finished) {
      completedIds.add(entry.id)
    }

    const tags = genresFor(entry.id, catalogById, entry.genres)
    const isQuickAbandon =
      !entry.finished && entry.currentTime > 0 && entry.currentTime < quickAbandonSec

    let watchWeight = 1.0
    if (entry.finished) watchWeight = 3.0
    else if (entry.currentTime > 600) watchWeight = 2.0
    else if (entry.currentTime < 90) watchWeight = 0.4

    const r = recency(entry.updatedAt || now, now, halfLifeDays)

    if (isQuickAbandon) {
      // Subtract — don't ignore. Stronger than a mild positive.
      const w = -1.6 * r
      for (const token of tokenizeTitle(entry.title)) {
        const iw = idf[token] ?? 1
        negativeKeywordWeights[token] = (negativeKeywordWeights[token] || 0) + Math.abs(w) * iw
      }
      addTagWeights(negativeTagWeights, tags, Math.abs(w))
      if (entry.category) {
        categoryWeights[entry.category] = (categoryWeights[entry.category] || 0) + w * 0.25
      }
      continue
    }

    const w = watchWeight * r
    if (entry.category) {
      categoryWeights[entry.category] = (categoryWeights[entry.category] || 0) + w
    }
    for (const token of tokenizeTitle(entry.title)) {
      const iw = idf[token] ?? 1
      keywordWeights[token] = (keywordWeights[token] || 0) + w * iw
    }
    addTagWeights(tagWeights, tags, w)
  }

  // Titles watched past the first minute: a stale abandon for them is noise.
  const watchedIds = new Set(
    history.filter((h) => h.finished || h.currentTime >= quickAbandonSec).map((h) => h.id),
  )

  for (const fb of feedback) {
    if (fb.kind === 'abandon') {
      // Soft penalty only; ignore it once the title was actually watched.
      if (watchedIds.has(fb.id)) continue
    } else {
      blockedIds.add(fb.id)
    }
    const strength =
      fb.kind === 'dislike' ? 3.0 : fb.kind === 'notInterested' ? 2.2 : 1.4
    const w = strength * Math.min(3, Math.max(1, fb.count)) * recency(fb.updatedAt, now, halfLifeDays)
    const title = fb.title || catalogById?.get(fb.id)?.title || ''
    const tags = genresFor(fb.id, catalogById, fb.tags)
    for (const token of tokenizeTitle(title)) {
      const iw = idf[token] ?? 1
      negativeKeywordWeights[token] = (negativeKeywordWeights[token] || 0) + w * iw
    }
    addTagWeights(negativeTagWeights, tags, w)
    if (fb.category) {
      categoryWeights[fb.category] = (categoryWeights[fb.category] || 0) - w * 0.15
    }
  }

  let topCategory: CategoryId | null = null
  let maxCatWeight = 0
  for (const [cat, weight] of Object.entries(categoryWeights)) {
    if (weight > maxCatWeight) {
      maxCatWeight = weight
      topCategory = cat as CategoryId
    }
  }

  return {
    totalWatched: history.length,
    categoryWeights,
    tagWeights,
    keywordWeights,
    negativeKeywordWeights,
    negativeTagWeights,
    completedIds,
    episodicWatchedIds,
    blockedIds,
    topCategory,
  }
}

/** Series / anime (and kids shows / multi-episode rows) track progress per episode. */
function isEpisodicEntry(entry: WatchHistoryEntry, item: StreamItem | undefined): boolean {
  if (entry.category === 'series' || entry.category === 'anime') return true
  if (entry.playlistIndex > 0) return true
  if (item?.tags?.includes('kids-shows')) return true
  return (item?.playlist?.length ?? 0) > 1
}

/** Sparse vector with its L2 norm precomputed (cosine is then one pass over the smaller side). */
type SparseVec = { w: Record<string, number>; keys: string[]; norm: number }

function sparse(w: Record<string, number>): SparseVec {
  const keys = Object.keys(w)
  let n = 0
  for (const k of keys) n += w[k]! * w[k]!
  return { w, keys, norm: Math.sqrt(n) }
}

function cosine(a: SparseVec, b: SparseVec): number {
  if (a.norm === 0 || b.norm === 0) return 0
  const [small, big] = a.keys.length <= b.keys.length ? [a, b] : [b, a]
  let dot = 0
  for (const k of small.keys) {
    const v = big.w[k]
    if (v) dot += small.w[k]! * v
  }
  return dot / (a.norm * b.norm)
}

/**
 * Item features, each counted once: title TF–IDF tokens, one category
 * feature, and genre features (no extra additive category / genre boosts).
 */
function itemVector(item: StreamItem, idf: Record<string, number>): SparseVec {
  const vec: Record<string, number> = {}
  for (const t of tokenizeTitle(item.title)) {
    vec[t] = (vec[t] || 0) + (idf[t] ?? 1)
  }
  if (item.category) vec[`cat:${item.category}`] = 2.0
  for (const genre of itemTasteGenres(item)) vec[`#${genre}`] = 3.0
  return sparse(vec)
}

function profileToVector(profile: UserTasteProfile, negative = false): SparseVec {
  const vec: Record<string, number> = {}
  const keywords = negative ? profile.negativeKeywordWeights : profile.keywordWeights
  const tags = negative ? profile.negativeTagWeights : profile.tagWeights
  for (const [t, w] of Object.entries(keywords)) {
    if (w > 0) vec[t] = (vec[t] || 0) + w
  }
  for (const [tag, w] of Object.entries(tags)) {
    if (w > 0) vec[`#${tag}`] = (vec[`#${tag}`] || 0) + w * 2.5
  }
  if (!negative) {
    for (const [cat, w] of Object.entries(profile.categoryWeights)) {
      if (w > 0) vec[`cat:${cat}`] = (vec[`cat:${cat}`] || 0) + w * 2.0
    }
  }
  return sparse(vec)
}

type ScoredCandidate = {
  item: StreamItem
  vec: SparseVec
  score: number
  reason: string
}

function mmr(candidates: ScoredCandidate[], k: number, lambda: number): ScoredCandidate[] {
  const picked: ScoredCandidate[] = []
  const pool = [...candidates]
  while (picked.length < k && pool.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0
      for (const p of picked) {
        const s = cosine(pool[i]!.vec, p.vec)
        if (s > maxSim) maxSim = s
      }
      const val = lambda * pool[i]!.score - (1 - lambda) * maxSim
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    picked.push(pool[bestIdx]!)
    pool.splice(bestIdx, 1)
  }
  return picked
}

/** Real catalog shelf tags that mean "popular / trending now", strongest first. */
const POPULAR_SHELF_TAGS = [
  'popular-movies',
  'trending-series',
  'popular-series',
  'trending-airing',
  'airing-series',
  'full-shows',
  'new-movies',
  'new-releases',
  'kids-movies',
  'kids-shows',
]
const COLD_START_CATEGORY_ORDER = ['movies', 'series', 'anime', 'kids']
const CATEGORY_LABEL: Record<string, string> = {
  movies: 'Movies',
  series: 'TV Series',
  anime: 'Anime',
  kids: 'Kids',
}

function popularShelfRank(item: StreamItem): number {
  let best = POPULAR_SHELF_TAGS.length
  for (const tag of item.tags ?? []) {
    const i = POPULAR_SHELF_TAGS.indexOf(String(tag).toLowerCase())
    if (i >= 0 && i < best) best = i
  }
  return best
}

/**
 * Popular picks for cold start and for backfilling a short personalized shelf:
 * popular / trending shelves first (catalog order within a shelf), taken
 * round-robin across Movies / TV Series / Anime so no category dominates.
 */
function popularPicks(
  items: StreamItem[],
  limit: number,
  skip: (item: StreamItem) => boolean,
  taken: StreamItem[] = [],
): StreamItem[] {
  const buckets = new Map<string, Array<{ item: StreamItem; rank: number; idx: number }>>()
  items.forEach((item, idx) => {
    if (skip(item)) return
    const list = buckets.get(item.category) ?? []
    list.push({ item, rank: popularShelfRank(item), idx })
    buckets.set(item.category, list)
  })
  const order = [
    ...COLD_START_CATEGORY_ORDER.filter((c) => buckets.has(c)),
    ...[...buckets.keys()].filter((c) => !COLD_START_CATEGORY_ORDER.includes(c)),
  ]
  const queues = order.map((c) =>
    buckets
      .get(c)!
      .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
      .map((e) => e.item),
  )
  const out: StreamItem[] = []
  const titles = createTitleDeduper(taken)
  let progressed = true
  while (out.length < limit && progressed) {
    progressed = false
    for (const q of queues) {
      while (q.length) {
        const next = q.shift()!
        if (titles.isDuplicate(next)) continue
        titles.add(next)
        out.push(next)
        progressed = true
        break
      }
      if (out.length >= limit) break
    }
  }
  return out
}

/** releasedAt below this is a popularity / by-year rank encoding, not a date. */
const MIN_REAL_RELEASED_AT = Date.UTC(1971, 0, 1)

/** "Dune (2021)" from YTS and "Dune" (2021) from Cinetaro → same title + year. */
function titleParts(item: Pick<StreamItem, 'title' | 'releasedAt'>): { title: string; year: string } {
  const raw = String(item.title || '').toLowerCase()
  const yearInTitle = raw.match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, 5)
  const releasedYear =
    item.releasedAt && item.releasedAt >= MIN_REAL_RELEASED_AT
      ? new Date(item.releasedAt).getUTCFullYear()
      : 0
  const year =
    yearInTitle || (releasedYear >= 1900 && releasedYear <= 2100 ? String(releasedYear) : '')
  const title = raw
    .replace(/\((19|20)\d{2}\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return { title, year }
}

/**
 * Cross-source duplicate filter: same normalized title, and the same year
 * when both years are known (remakes with different years stay distinct).
 */
export function createTitleDeduper(initial: Iterable<Pick<StreamItem, 'title' | 'releasedAt'>> = []) {
  const seen = new Map<string, Set<string>>()
  const add = (item: Pick<StreamItem, 'title' | 'releasedAt'>) => {
    const { title, year } = titleParts(item)
    if (!title) return
    const years = seen.get(title) ?? new Set<string>()
    years.add(year)
    seen.set(title, years)
  }
  const isDuplicate = (item: Pick<StreamItem, 'title' | 'releasedAt'>) => {
    const { title, year } = titleParts(item)
    const years = title ? seen.get(title) : undefined
    if (!years) return false
    return !year || years.has('') || years.has(year)
  }
  for (const item of initial) add(item)
  return { add, isDuplicate }
}

let cachedIdf: Record<string, number> | null = null
let cachedIdfKey = ''
let cachedProfile: UserTasteProfile | null = null
let cachedProfileKey = ''

/** FNV-1a over every id + title — any catalog change rebuilds IDF (O(n), no sampling). */
function catalogIdfKey(items: StreamItem[]): string {
  let h = 0x811c9dc5
  for (const item of items) {
    const s = `${item.id}\u0000${item.title}\u0001`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  return `${items.length}:${(h >>> 0).toString(36)}`
}

function historySignature(history: WatchHistoryEntry[]): string {
  return history.map((h) => `${h.id}:${h.finished ? 1 : 0}:${Math.floor(h.currentTime)}:${h.updatedAt}`).join('|')
}

export function invalidateRecommendProfileCache() {
  cachedProfile = null
  cachedProfileKey = ''
}

let cacheListenersBound = false
function ensureCacheInvalidation() {
  if (cacheListenersBound || typeof window === 'undefined') return
  cacheListenersBound = true
  const bump = () => invalidateRecommendProfileCache()
  window.addEventListener(WATCH_HISTORY_EVENT, bump)
  window.addEventListener(RECOMMEND_FEEDBACK_EVENT, bump)
}

export type RankRecommendationsOptions = {
  items: StreamItem[]
  history: WatchHistoryEntry[]
  feedback?: RecommendFeedbackEntry[]
  limit?: number
  mmrLambda?: number
  scoreThreshold?: number
  negativeCosineWeight?: number
  halfLifeDays?: number
  quickAbandonSec?: number
  /** Never recommend these (e.g. titles already on Continue watching). */
  excludeIds?: Iterable<string>
}

/**
 * Pure ranker — used by the shelf and the holdout eval harness.
 */
export function rankRecommendations(options: RankRecommendationsOptions): RecommendedItem[] {
  const items = options.items
  const limit = options.limit ?? 24
  if (!items.length) return []

  const idfKey = catalogIdfKey(items)
  if (idfKey !== cachedIdfKey || !cachedIdf) {
    cachedIdf = buildIdf(items)
    cachedIdfKey = idfKey
  }
  const idf = cachedIdf
  const catalogById = new Map(items.map((i) => [i.id, i]))
  const feedback = options.feedback ?? []
  const history = options.history

  const halfLifeDays = options.halfLifeDays ?? RECOMMEND_TUNABLES.halfLifeDays
  const quickAbandonSec = options.quickAbandonSec ?? RECOMMEND_TUNABLES.quickAbandonSec
  // Tunables + hour bucket: recency weights age even when nothing else changes.
  const profileKey = [
    idfKey,
    historySignature(history),
    recommendFeedbackSignature(feedback),
    halfLifeDays,
    quickAbandonSec,
    Math.floor(Date.now() / 3_600_000),
  ].join('::')
  let profile = cachedProfile
  if (!profile || profileKey !== cachedProfileKey) {
    profile = buildUserTasteProfile(history, {
      idf,
      catalogById,
      feedback,
      halfLifeDays,
      quickAbandonSec,
    })
    cachedProfile = profile
    cachedProfileKey = profileKey
  }

  const excludeIds = new Set(options.excludeIds ?? [])

  if (profile.totalWatched === 0 && feedback.length === 0) {
    return popularPicks(items, limit, (item) => excludeIds.has(item.id)).map((item) => ({
      item,
      score: 1.0,
      reason: `Popular in ${CATEGORY_LABEL[item.category] ?? 'Jiyu'}`,
    }))
  }

  const posVec = profileToVector(profile, false)
  const negVec = profileToVector(profile, true)
  const negWeight = options.negativeCosineWeight ?? RECOMMEND_TUNABLES.negativeCosineWeight
  const threshold = options.scoreThreshold ?? RECOMMEND_TUNABLES.scoreThreshold
  const lambda = options.mmrLambda ?? RECOMMEND_TUNABLES.mmrLambda

  const lastWatched = history.find((h) => !profile.blockedIds.has(h.id) && h.currentTime >= quickAbandonSec)
    || history[0]
  const lastTokens = lastWatched ? tokenizeTitle(lastWatched.title) : []

  const isExcluded = (item: StreamItem) =>
    excludeIds.has(item.id) ||
    profile.blockedIds.has(item.id) ||
    (profile.completedIds.has(item.id) && item.category !== 'sports')

  // The same title from another source is excluded too (finished movie,
  // already on Continue watching, explicitly hidden).
  const titles = createTitleDeduper([
    ...history.filter((h) => profile.completedIds.has(h.id)),
    ...items.filter((i) => excludeIds.has(i.id) || profile.blockedIds.has(i.id)),
  ])

  const candidates: ScoredCandidate[] = []

  for (const item of items) {
    if (isExcluded(item)) continue

    const vec = itemVector(item, idf)
    const pos = cosine(posVec, vec)
    const neg = cosine(negVec, vec)
    let score = pos - negWeight * neg
    // Shows you've already started: keep them reachable, but new finds first.
    if (profile.episodicWatchedIds.has(item.id)) score *= 0.5

    const catW = profile.categoryWeights[item.category] || 0
    let topGenre = ''
    let topGenreW = 0
    for (const genre of itemTasteGenres(item)) {
      const gw = profile.tagWeights[genre] || 0
      if (gw > topGenreW) {
        topGenreW = gw
        topGenre = genre
      }
    }

    // Reasons prefer the strongest shared genre, then a franchise / title match.
    let reason = 'Recommended for you'
    const overlap = tokenizeTitle(item.title).filter((t) => lastTokens.includes(t))
    if (topGenre) {
      reason = `Because you like ${genreLabel(topGenre)}`
    } else if (overlap.length > 0 && lastWatched) {
      reason = `Because you watched ${lastWatched.title}`
    } else if (catW > 0 && profile.topCategory === item.category) {
      reason = `Top pick for you in ${item.category}`
    }

    if (score > threshold) candidates.push({ item, vec, score, reason })
  }

  candidates.sort((a, b) => b.score - a.score)
  // Cross-source dedup: keep the best-scoring copy of each title.
  const unique: ScoredCandidate[] = []
  for (const c of candidates) {
    if (titles.isDuplicate(c.item)) continue
    titles.add(c.item)
    unique.push(c)
    if (unique.length >= limit * 3) break
  }
  const reranked = mmr(unique, limit, lambda)

  const out: RecommendedItem[] = reranked.map((c) => ({
    item: c.item,
    score: Number(c.score.toFixed(3)),
    reason: c.reason,
  }))

  // Short shelf (thin history, strict threshold): backfill with popular picks.
  if (out.length < limit) {
    const fill = popularPicks(
      items,
      limit - out.length,
      (item) => isExcluded(item) || titles.isDuplicate(item),
      out.map((r) => r.item),
    )
    for (const item of fill) {
      out.push({ item, score: 0, reason: `Popular in ${CATEGORY_LABEL[item.category] ?? 'Jiyu'}` })
    }
  }
  return out
}

/**
 * Hold out the newest qualifying watch; rank from the rest; report top-K hit.
 * Used by scripts/eval-recommendations.mts and manual tuning.
 */
export function evaluateHoldout(options: {
  items: StreamItem[]
  history: WatchHistoryEntry[]
  feedback?: RecommendFeedbackEntry[]
  k?: number
  minHoldoutSec?: number
} & Omit<RankRecommendationsOptions, 'items' | 'history' | 'feedback' | 'limit'>): {
  ok: boolean
  holdoutId: string | null
  holdoutTitle: string | null
  rank: number | null
  hitAtK: boolean
  k: number
  top: Array<{ id: string; title: string; score: number }>
} {
  const k = options.k ?? 16
  const minSec = options.minHoldoutSec ?? RECOMMEND_TUNABLES.quickAbandonSec
  const history = [...options.history].sort((a, b) => b.updatedAt - a.updatedAt)
  const holdout =
    history.find((h) => h.finished || h.currentTime >= minSec) || history[0] || null
  if (!holdout) {
    return {
      ok: false,
      holdoutId: null,
      holdoutTitle: null,
      rank: null,
      hitAtK: false,
      k,
      top: [],
    }
  }
  const train = history.filter((h) => h.id !== holdout.id)
  // Temporarily clear profile cache so train/holdout aren't polluted.
  const prevProfile = cachedProfile
  const prevKey = cachedProfileKey
  invalidateRecommendProfileCache()
  const ranked = rankRecommendations({
    ...options,
    items: options.items,
    history: train,
    feedback: options.feedback,
    limit: Math.max(k, 48),
  })
  cachedProfile = prevProfile
  cachedProfileKey = prevKey

  const idx = ranked.findIndex((r) => r.item.id === holdout.id)
  return {
    ok: true,
    holdoutId: holdout.id,
    holdoutTitle: holdout.title,
    rank: idx >= 0 ? idx + 1 : null,
    hitAtK: idx >= 0 && idx < k,
    k,
    top: ranked.slice(0, k).map((r) => ({
      id: r.item.id,
      title: r.item.title,
      score: r.score,
    })),
  }
}

let staleAbandonsPruned = false

/**
 * One-time cleanup per app session: builds up to 0.3.73 stored an "abandon"
 * for every title during its first minute of playback. Drop those for titles
 * that were watched past the first minute; real quick bails are kept.
 */
function pruneStaleAbandons(history: WatchHistoryEntry[]) {
  if (staleAbandonsPruned) return
  staleAbandonsPruned = true
  const watched = history
    .filter((h) => h.finished || h.currentTime >= RECOMMEND_TUNABLES.quickAbandonSec)
    .map((h) => h.id)
  // Deferred: this runs inside a render (useMemo) and the drop fires an event.
  if (watched.length) queueMicrotask(() => dropRecommendAbandons(watched))
}

export function getPersonalizedRecommendations(
  items: StreamItem[],
  limit = 24,
  options?: { excludeIds?: Iterable<string> },
): RecommendedItem[] {
  ensureCacheInvalidation()
  const history = listWatchHistory('all')
  pruneStaleAbandons(history)
  return rankRecommendations({
    items,
    history,
    feedback: listRecommendFeedback(),
    limit,
    excludeIds: options?.excludeIds,
  })
}
