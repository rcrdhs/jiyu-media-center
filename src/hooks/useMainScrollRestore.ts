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
    if (typeof saved === 'number' && saved > 0) {
      const apply = () => {
        const el = getMainStage()
        if (el) el.scrollTop = saved
      }
      apply()
      // Layout may still grow (infinite-scroll window / images); re-apply a few times.
      requestAnimationFrame(apply)
      const t1 = window.setTimeout(apply, 50)
      const t2 = window.setTimeout(apply, 200)
      return () => {
        window.clearTimeout(t1)
        window.clearTimeout(t2)
        const current = getMainStage()
        if (current) setMainScroll(key, current.scrollTop)
      }
    }

    return () => {
      const current = getMainStage()
      if (current) setMainScroll(key, current.scrollTop)
    }
  }, [key, ready])
}
