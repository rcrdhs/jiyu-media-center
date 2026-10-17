/**
 * Explicit / implicit negative signals for on-device recommendations.
 * Persisted locally; never leaves the device.
 */

export type RecommendFeedbackKind = 'notInterested' | 'dislike' | 'abandon'

export type RecommendFeedbackEntry = {
  id: string
  kind: RecommendFeedbackKind
  title?: string
  category?: string
  tags?: string[]
  /** How many times this signal was reinforced (abandons). */
  count: number
  updatedAt: number
}

export const RECOMMEND_FEEDBACK_EVENT = 'jiyu:recommend-feedback'
const KEY = 'jiyu.recommend-feedback.v1'
const MAX_ENTRIES = 200

type Store = Record<string, RecommendFeedbackEntry>

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Store
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(store: Store) {
  try {
    const entries = Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt)
    const trimmed = Object.fromEntries(
      entries.slice(0, MAX_ENTRIES).map((e) => [e.id, e]),
    )
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    /* quota */
  }
  window.dispatchEvent(new CustomEvent(RECOMMEND_FEEDBACK_EVENT))
}

function upsert(
  id: string,
  kind: RecommendFeedbackKind,
  detail?: { title?: string; category?: string; tags?: string[] },
) {
  const key = String(id || '').trim()
  if (!key) return
  const store = load()
  const prev = store[key]
  // Stronger signals win over weaker ones for the same id.
  const rank = { abandon: 1, notInterested: 2, dislike: 3 } as const
  if (prev && rank[prev.kind] > rank[kind]) {
    store[key] = {
      ...prev,
      count: prev.count + 1,
      updatedAt: Date.now(),
      title: detail?.title || prev.title,
      category: detail?.category || prev.category,
      tags: detail?.tags?.length ? detail.tags : prev.tags,
    }
  } else {
    store[key] = {
      id: key,
      kind,
      title: detail?.title || prev?.title,
      category: detail?.category || prev?.category,
      tags: detail?.tags?.length ? detail.tags : prev?.tags,
      count: (prev?.kind === kind ? prev.count : 0) + 1,
      updatedAt: Date.now(),
    }
  }
  save(store)
}

export function listRecommendFeedback(): RecommendFeedbackEntry[] {
  return Object.values(load()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getRecommendFeedback(id: string): RecommendFeedbackEntry | null {
  const key = String(id || '').trim()
  if (!key) return null
  return load()[key] || null
}

export function recordNotInterested(
  id: string,
  detail?: { title?: string; category?: string; tags?: string[] },
) {
  upsert(id, 'notInterested', detail)
}

export function recordDislike(
  id: string,
  detail?: { title?: string; category?: string; tags?: string[] },
) {
  upsert(id, 'dislike', detail)
}

/**
 * Quick bail — a playback session that ended before the first minute.
 * Called once per session (player teardown), never per progress tick.
 */
export function recordRecommendAbandon(
  id: string,
  detail?: { title?: string; category?: string; tags?: string[] },
) {
  upsert(id, 'abandon', detail)
}

/**
 * Drop implicit abandon entries for titles that were later watched past the
 * first minute. Explicit dislike / not interested entries are kept. Only
 * writes (and fires the event) when something was removed.
 */
export function dropRecommendAbandons(ids: Iterable<string>): number {
  const store = load()
  let removed = 0
  for (const id of ids) {
    const key = String(id || '').trim()
    if (key && store[key]?.kind === 'abandon') {
      delete store[key]
      removed++
    }
  }
  if (removed > 0) save(store)
  return removed
}

export function clearRecommendFeedback(id?: string) {
  if (!id) {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(RECOMMEND_FEEDBACK_EVENT))
    return
  }
  const store = load()
  delete store[id]
  save(store)
}

export function recommendFeedbackSignature(entries = listRecommendFeedback()): string {
  return entries.map((e) => `${e.id}:${e.kind}:${e.count}`).join('|')
}

export function subscribeRecommendFeedback(handler: () => void): () => void {
  window.addEventListener(RECOMMEND_FEEDBACK_EVENT, handler)
  return () => window.removeEventListener(RECOMMEND_FEEDBACK_EVENT, handler)
}
