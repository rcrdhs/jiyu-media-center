import { useLayoutEffect } from 'react'
import { getMainScroll, getMainStage, setMainScroll } from '../lib/viewState'

/**
 * Remembers and restores .main-stage scroll for a route key (e.g. /section/sports).
 */
export function useMainScrollRestore(key: string, ready = true) {
  useLayoutEffect(() => {
    if (!ready || !key) return

    const stage = getMainStage()
    if (!stage) return

    const saved = getMainScroll(key)
    if (typeof saved === 'number') {
      stage.scrollTop = saved
      // Layout may still grow (images / grids); nudge once more after paint
      requestAnimationFrame(() => {
        stage.scrollTop = saved
      })
    }

    return () => {
      const current = getMainStage()
      if (current) setMainScroll(key, current.scrollTop)
    }
  }, [key, ready])
}
