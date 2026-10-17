/**
 * On-device personalized recommendations (private, local only).
 *
 * TF–IDF cosine over titles + tags, exponential recency, negative signals
 * (abandon / not interested / dislike), MMR diversity, and an in-memory
 * profile cache invalidated on watch / feedback events.
 */

import type { CategoryId, StreamItem } from '../types'
import {
  listRecommendFeedback,
  RECOMMEND_FEEDBACK_EVENT,
  recommendFeedbackSignature,
  type RecommendFeedbackEntry,
} from './recommendFeedback'
import { listWatchHistory, WATCH_HISTORY_EVENT, type WatchHistoryEntry } from './watchHistory'

export interface UserTasteProfile {
  totalWatched: number
  categoryWeights: Record<string, number>
  tagWeights: Record<string, number>
  keywordWeights: Record<string, number>
  /** Negative keyword / tag space (abandons + dislikes). */
  negativeKeywordWeights: Record<string, number>
  negativeTagWeights: Record<string, number>
  completedIds: Set<string>
  /** Hard-exclude from the shelf. */
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
  mmrLambda: 0.7,
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

function catalogTags(
  id: string,
  catalogById: Map<string, StreamItem> | undefined,
  fallback?: string[],
): string[] {
  const fromCatalog = catalogById?.get(id)?.tags
  if (Array.isArray(fromCatalog) && fromCatalog.length) return fromCatalog
  return Array.isArray(fallback) ? fallback : []
}

function addTagWeights(
  tagWeights: Record<string, number>,
  tags: string[],
  w: number,
) {
  for (const tag of tags) {
    const clean = String(tag || '')
      .toLowerCase()
      .trim()
    if (!clean || clean === 'popular' || clean === 'web-embed') continue
    tagWeights[clean] = (tagWeights[clean] || 0) + w
  }
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
  const blockedIds = new Set<string>()
  const now = Date.now()

  for (const entry of history) {
    if (entry.finished) completedIds.add(entry.id)

    const tags = catalogTags(entry.id, catalogById)
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

  for (const fb of feedback) {
    blockedIds.add(fb.id)
    const strength =
      fb.kind === 'dislike' ? 3.0 : fb.kind === 'notInterested' ? 2.2 : 1.4
    const w = strength * Math.min(3, Math.max(1, fb.count)) * recency(fb.updatedAt, now, halfLifeDays)
    const title = fb.title || catalogById?.get(fb.id)?.title || ''
    const tags = catalogTags(fb.id, catalogById, fb.tags)
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
    blockedIds,
    topCategory,
  }
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const k in a) {
    na += a[k]! * a[k]!
    if (b[k]) dot += a[k]! * b[k]!
  }
  for (const k in b) nb += b[k]! * b[k]!
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function itemVector(item: StreamItem, idf: Record<string, number>): Record<string, number> {
  const vec: Record<string, number> = {}
  for (const t of tokenizeTitle(item.title)) {
    vec[t] = (vec[t] || 0) + (idf[t] ?? 1)
  }
  if (item.category) {
    vec[`#${item.category}`] = (vec[`#${item.category}`] || 0) + 2.0
  }
  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      const clean = String(tag || '')
        .toLowerCase()
        .trim()
      if (!clean) continue
      const k = `#${clean}`
      vec[k] = (vec[k] || 0) + 3.0
    }
  }
  return vec
}

function profileToVector(profile: UserTasteProfile, negative = false): Record<string, number> {
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
      if (w > 0) vec[`#${cat}`] = (vec[`#${cat}`] || 0) + w * 2.0
    }
  }
  return vec
}

type ScoredCandidate = {
  item: StreamItem
  vec: Record<string, number>
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

let cachedIdf: Record<string, number> | null = null
let cachedIdfKey = ''
let cachedProfile: UserTasteProfile | null = null
let cachedProfileKey = ''

function catalogIdfKey(items: StreamItem[]): string {
  const n = items.length
  if (n === 0) return '0'
  const a = items[0]?.id || ''
  const b = items[Math.floor(n / 2)]?.id || ''
  const c = items[n - 1]?.id || ''
  return `${n}:${a}:${b}:${c}`
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

  const profileKey = `${idfKey}::${historySignature(history)}::${recommendFeedbackSignature(feedback)}`
  let profile = cachedProfile
  if (!profile || profileKey !== cachedProfileKey) {
    profile = buildUserTasteProfile(history, {
      idf,
      catalogById,
      feedback,
      halfLifeDays: options.halfLifeDays,
      quickAbandonSec: options.quickAbandonSec,
    })
    cachedProfile = profile
    cachedProfileKey = profileKey
  }

  if (profile.totalWatched === 0 && feedback.length === 0) {
    const trending = items.filter((i) => i.tags?.includes('popular'))
    const cold = trending.length > 0 ? trending : items.filter((i) => i.category === 'movies')
    return cold.slice(0, limit).map((item) => ({
      item,
      score: 1.0,
      reason: 'Trending in Jiyu',
    }))
  }

  const posVec = profileToVector(profile, false)
  const negVec = profileToVector(profile, true)
  const negWeight = options.negativeCosineWeight ?? RECOMMEND_TUNABLES.negativeCosineWeight
  const threshold = options.scoreThreshold ?? RECOMMEND_TUNABLES.scoreThreshold
  const lambda = options.mmrLambda ?? RECOMMEND_TUNABLES.mmrLambda

  const lastWatched = history.find((h) => !profile.blockedIds.has(h.id) && h.currentTime >= (options.quickAbandonSec ?? RECOMMEND_TUNABLES.quickAbandonSec))
    || history[0]
  const lastTokens = lastWatched ? tokenizeTitle(lastWatched.title) : []

  const candidates: ScoredCandidate[] = []

  for (const item of items) {
    if (profile.blockedIds.has(item.id)) continue
    if (profile.completedIds.has(item.id) && item.category !== 'sports') continue

    const vec = itemVector(item, idf)
    const pos = cosine(posVec, vec)
    const neg = cosine(negVec, vec)
    let score = pos - negWeight * neg

    const catW = profile.categoryWeights[item.category] || 0
    if (catW > 0) score += Math.min(catW * 0.02, 0.15)

    // Shared genre tags with the positive profile.
    if (Array.isArray(item.tags)) {
      let tagHit = 0
      for (const tag of item.tags) {
        const clean = String(tag || '')
          .toLowerCase()
          .trim()
        if (clean && profile.tagWeights[clean]) tagHit += profile.tagWeights[clean]!
      }
      if (tagHit > 0) score += Math.min(tagHit * 0.01, 0.12)
    }

    let reason = 'Recommended for you'
    const overlap = tokenizeTitle(item.title).filter((t) => lastTokens.includes(t))
    if (overlap.length > 0 && lastWatched) {
      reason = `Because you watched ${lastWatched.title}`
    } else if (
      Array.isArray(item.tags) &&
      item.tags.some((t) => profile.tagWeights[String(t).toLowerCase().trim()])
    ) {
      const hit = item.tags.find((t) => profile.tagWeights[String(t).toLowerCase().trim()])
      if (hit) reason = `Because you like ${hit}`
    } else if (catW > 0 && profile.topCategory === item.category) {
      reason = `Top pick for you in ${item.category}`
    }

    if (score > threshold) candidates.push({ item, vec, score, reason })
  }

  candidates.sort((a, b) => b.score - a.score)
  const reranked = mmr(candidates.slice(0, limit * 3), limit, lambda)

  return reranked.map((c) => ({
    item: c.item,
    score: Number(c.score.toFixed(3)),
    reason: c.reason,
  }))
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

export function getPersonalizedRecommendations(
  items: StreamItem[],
  limit = 24,
): RecommendedItem[] {
  ensureCacheInvalidation()
  return rankRecommendations({
    items,
    history: listWatchHistory('all'),
    feedback: listRecommendFeedback(),
    limit,
  })
}
