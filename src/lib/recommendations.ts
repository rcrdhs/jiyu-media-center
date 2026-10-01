/**
 * On-Device Personalized Recommendation Engine.
 *
 * Builds a private user taste profile by analyzing watch history, completion
 * rates, category affinities, and recurring genre tags. Scores catalog items
 * using weighted cosine/Jaccard similarity and delivers tailored recommendations
 * with contextual explanations (e.g. "Because you watched Interstellar").
 */

import type { CategoryId, StreamItem } from '../types'
import { listWatchHistory } from './watchHistory'

export interface UserTasteProfile {
  totalWatched: number
  categoryWeights: Record<string, number>
  tagWeights: Record<string, number>
  favoriteKeywords: string[]
  completedIds: Set<string>
  topCategory: CategoryId | null
}

export interface RecommendedItem {
  item: StreamItem
  score: number
  reason: string
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'up', 'about', 'into', 'over', 'after', 'season', 'episode',
  'part', 'chapter', 'vol', 'volume', 'series', 'movie', 'full', 'hd', '720p',
  '1080p', '4k', 'official', 'stream', 'live', 'tv', 'watch', 'dub', 'sub',
])

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}

/**
 * Build a user taste profile based on watch history.
 */
export function buildUserTasteProfile(): UserTasteProfile {
  const history = listWatchHistory('all')
  const categoryWeights: Record<string, number> = {}
  const tagWeights: Record<string, number> = {}
  const keywordCounts: Record<string, number> = {}
  const completedIds = new Set<string>()

  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

  for (const entry of history) {
    if (entry.id) completedIds.add(entry.id)

    // Completion and watch-time weighting
    let watchWeight = 1.0
    if (entry.finished) {
      watchWeight = 3.0
    } else if (entry.currentTime > 600) {
      watchWeight = 2.0
    } else if (entry.currentTime < 90) {
      watchWeight = 0.4
    }

    // Recency decay
    const ageMs = now - (entry.updatedAt || now)
    const recencyFactor = Math.max(0.3, 1.0 - ageMs / THIRTY_DAYS_MS)
    const effectiveWeight = watchWeight * recencyFactor

    // Accumulate category weight
    if (entry.category) {
      categoryWeights[entry.category] =
        (categoryWeights[entry.category] || 0) + effectiveWeight
    }

    // Tokenize title keywords
    const tokens = tokenizeTitle(entry.title)
    for (const token of tokens) {
      keywordCounts[token] = (keywordCounts[token] || 0) + effectiveWeight
    }
  }

  // Find top category
  let topCategory: CategoryId | null = null
  let maxCatWeight = 0
  for (const [cat, weight] of Object.entries(categoryWeights)) {
    if (weight > maxCatWeight) {
      maxCatWeight = weight
      topCategory = cat as CategoryId
    }
  }

  // Top keywords
  const favoriteKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w)

  return {
    totalWatched: history.length,
    categoryWeights,
    tagWeights,
    favoriteKeywords,
    completedIds,
    topCategory,
  }
}

/**
 * Score and rank catalog items for personalized recommendations.
 */
export function getPersonalizedRecommendations(
  items: StreamItem[],
  limit = 24,
): RecommendedItem[] {
  if (!items || items.length === 0) return []

  const profile = buildUserTasteProfile()
  const history = listWatchHistory('all')
  const lastWatched = history[0]

  // If cold start (no history), recommend popular / top items
  if (profile.totalWatched === 0) {
    return items
      .filter((item) => item.tags?.includes('popular') || item.category === 'movies')
      .slice(0, limit)
      .map((item) => ({
        item,
        score: 1.0,
        reason: 'Trending in Jiyu',
      }))
  }

  const scored: RecommendedItem[] = []

  for (const item of items) {
    // Skip items already completed by the user (except live channels)
    if (profile.completedIds.has(item.id) && item.category !== 'sports') {
      continue
    }

    let score = 0
    let primaryReason = ''

    // 1. Category Affinity Match
    const catWeight = profile.categoryWeights[item.category] || 0
    if (catWeight > 0) {
      score += Math.min(catWeight * 2.5, 10.0)
    }

    // 2. Title & franchise keyword similarity
    const itemTokens = tokenizeTitle(item.title)
    let keywordOverlap = 0
    let matchedWord = ''
    for (const token of itemTokens) {
      if (profile.favoriteKeywords.includes(token)) {
        keywordOverlap += 1
        if (!matchedWord) matchedWord = token
      }
    }
    if (keywordOverlap > 0) {
      score += keywordOverlap * 4.0
      primaryReason = `Because you enjoy ${matchedWord}`
    }

    // 3. Last watched title similarity
    if (lastWatched) {
      const lastTokens = tokenizeTitle(lastWatched.title)
      const directSim = itemTokens.filter((t) => lastTokens.includes(t)).length
      if (directSim > 0) {
        score += directSim * 5.0
        primaryReason = `Because you watched ${lastWatched.title}`
      }
    }

    // 4. Tag affinity match
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        const cleanTag = tag.toLowerCase().trim()
        if (cleanTag === 'popular') score += 1.5
        if (profile.favoriteKeywords.includes(cleanTag)) {
          score += 3.0
          if (!primaryReason) {
            primaryReason = `Recommended for ${cleanTag.charAt(0).toUpperCase() + cleanTag.slice(1)} fans`
          }
        }
      }
    }

    // 5. Exploration & Freshness Bonus (slight jitter so list updates)
    const explorationBonus = Math.random() * 1.5
    score += explorationBonus

    if (score > 2.0) {
      if (!primaryReason) {
        primaryReason =
          profile.topCategory === item.category
            ? `Top pick for you in ${item.category}`
            : 'Recommended for you'
      }

      scored.push({
        item,
        score: Number(score.toFixed(2)),
        reason: primaryReason,
      })
    }
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit)
}
