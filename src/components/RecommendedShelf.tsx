import { useEffect, useMemo, useRef, useState } from 'react'
import { useCatalog } from '../context/CatalogContext'
import { getPersonalizedRecommendations, itemTasteGenres } from '../lib/recommendations'
import {
  recordNotInterested,
  RECOMMEND_FEEDBACK_EVENT,
} from '../lib/recommendFeedback'
import { filterShelfVisibleItems, isSeriesWebCatalogItem } from '../lib/torrents'
import { isLikelyEnglish, shouldApplyEnglishFilter } from '../lib/language'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import { CONTINUE_WATCHING_EVENT, listContinueWatching } from '../lib/continueWatching'
import { WATCH_HISTORY_EVENT } from '../lib/watchHistory'
import { HIDE_KEYWORDS_EVENT } from '../lib/hideKeywords'
import { MediaCard } from './MediaCard'

/** Coalesce bursts of history / feedback events into one recompute. */
const RECOMPUTE_DEBOUNCE_MS = 400
/** Window focus alone only refreshes this often (recency drifts slowly). */
const FOCUS_REFRESH_MIN_MS = 5 * 60_000

/** Home shelf: on-device recommendations from watch history (private, local only). */
export function RecommendedShelf() {
  const { items, englishOnly, ready } = useCatalog()
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [historyTick, setHistoryTick] = useState(0)
  const lastComputedAt = useRef(0)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  useEffect(() => {
    let timer: number | null = null
    const bump = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        setHistoryTick((n) => n + 1)
      }, RECOMPUTE_DEBOUNCE_MS)
    }
    const onFocus = () => {
      if (Date.now() - lastComputedAt.current >= FOCUS_REFRESH_MIN_MS) bump()
    }
    window.addEventListener(CONTINUE_WATCHING_EVENT, bump)
    window.addEventListener(WATCH_HISTORY_EVENT, bump)
    window.addEventListener(HIDE_KEYWORDS_EVENT, bump)
    window.addEventListener(RECOMMEND_FEEDBACK_EVENT, bump)
    window.addEventListener('focus', onFocus)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener(CONTINUE_WATCHING_EVENT, bump)
      window.removeEventListener(WATCH_HISTORY_EVENT, bump)
      window.removeEventListener(HIDE_KEYWORDS_EVENT, bump)
      window.removeEventListener(RECOMMEND_FEEDBACK_EVENT, bump)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const recommendations = useMemo(() => {
    if (!ready) return []
    const pool = filterShelfVisibleItems(items).filter((item) => {
      if (kidsMode && item.category !== 'kids') return false
      if (!kidsMode && item.category === 'kids') return false
      if (item.category === 'series' && !isSeriesWebCatalogItem(item)) return false
      if (englishOnly && shouldApplyEnglishFilter(item.category) && !isLikelyEnglish(item)) {
        return false
      }
      // Sports live cards churn too fast for a “For You” shelf.
      if (item.category === 'sports') return false
      return true
    })
    // Titles already on Continue watching have their own shelf.
    const continueIds = listContinueWatching().map((entry) => entry.id)
    return getPersonalizedRecommendations(pool, 16, { excludeIds: continueIds })
    // historyTick forces recompute when continue-watching / history / feedback changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, englishOnly, ready, kidsMode, historyTick])

  useEffect(() => {
    lastComputedAt.current = Date.now()
  }, [recommendations])

  if (recommendations.length === 0) return null

  return (
    <section className="section-block recommended-shelf" aria-label="Recommended for you">
      <div className="section-head">
        <h2>Recommended for you</h2>
        <p>Learned on this device from what you watch — nothing leaves Jiyu.</p>
      </div>
      <div className="continue-row recommended-row">
        {recommendations.map(({ item, reason }) => (
          <div key={item.id} className="recommended-card-wrap">
            <MediaCard item={item} />
            {reason ? <p className="recommended-reason">{reason}</p> : null}
            <button
              type="button"
              className="ghost-btn recommended-not-interested"
              title="Hide this and similar picks"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                recordNotInterested(item.id, {
                  title: item.title,
                  category: item.category,
                  tags: itemTasteGenres(item),
                })
                setHistoryTick((n) => n + 1)
              }}
            >
              Not interested
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
