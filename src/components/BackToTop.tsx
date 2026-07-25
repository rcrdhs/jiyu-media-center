import { useEffect, useState } from 'react'
import { getMainStage } from '../lib/viewState'

const SHOW_AFTER_PX = 480

/** Floating control for the `.main-stage` scroll container (sections, home, etc.). */
export function BackToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const stage = getMainStage()
    if (!stage) return

    const onScroll = () => {
      setVisible(stage.scrollTop > SHOW_AFTER_PX)
    }

    onScroll()
    stage.addEventListener('scroll', onScroll, { passive: true })
    return () => stage.removeEventListener('scroll', onScroll)
  }, [])

  if (!visible) return null

  return (
    <button
      type="button"
      className="back-to-top"
      aria-label="Back to top"
      title="Back to top"
      onClick={() => {
        const stage = getMainStage()
        if (!stage) return
        const reduceMotion =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        stage.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
      }}
    >
      <span aria-hidden>↑</span>
      Top
    </button>
  )
}
