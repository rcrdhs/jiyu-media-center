import { useEffect, useMemo, useState } from 'react'
import { useCatalog } from '../context/CatalogContext'
import { getPersonalizedRecommendations } from '../lib/recommendations'
import { filterShelfVisibleItems, isSeriesWebCatalogItem } from '../lib/torrents'
import { isLikelyEnglish, shouldApplyEnglishFilter } from '../lib/language'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import { CONTINUE_WATCHING_EVENT } from '../lib/continueWatching'
import { WATCH_HISTORY_EVENT } from '../lib/watchHistory'
import { MediaCard } from './MediaCard'

/** Home shelf: on-device recommendations from watch history (private, local only). */
export function RecommendedShelf() {
  const { items, englishOnly, ready } = useCatalog()
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [historyTick, setHistoryTick] = useState(0)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  useEffect(() => {
    const bump = () => setHistoryTick((n) => n + 1)
    window.addEventListener(CONTINUE_WATCHING_EVENT, bump)
    window.addEventListener(WATCH_HISTORY_EVENT, bump)
    window.addEventListener('focus', bump)
    return () => {
      window.removeEventListener(CONTINUE_WATCHING_EVENT, bump)
      window.removeEventListener(WATCH_HISTORY_EVENT, bump)
      window.removeEventListener('focus', bump)
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
    return getPersonalizedRecommendations(pool, 16)
    // historyTick forces recompute when continue-watching / history changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, englishOnly, ready, kidsMode, historyTick])

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
          </div>
        ))}
      </div>
    </section>
  )
}
