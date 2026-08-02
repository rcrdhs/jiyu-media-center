import { useEffect, useState } from 'react'
import { usePlayback } from '../context/PlaybackContext'
import { getPipLayout, useWebBrowser } from '../context/WebBrowserContext'
import { getMainStage } from '../lib/viewState'

const SHOW_AFTER_PX = 480
const GAP_ABOVE_PIP_PX = 10

/** Match `.player-shell-pip` geometry in index.css. */
function playerPipClearancePx(): number {
  const rem =
    typeof window !== 'undefined'
      ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      : 16
  const narrow = window.matchMedia('(max-width: 640px)').matches
  const width = narrow
    ? Math.min(13.5 * rem, window.innerWidth - 1.5 * rem)
    : Math.min(20 * rem, window.innerWidth * 0.42)
  const chrome = 40
  const stage = width * (9 / 16)
  const margin = 0.75 * rem
  return Math.ceil(margin + chrome + stage + GAP_ABOVE_PIP_PX)
}

function webPipClearancePx(): number {
  const layout = getPipLayout()
  return Math.ceil(layout.margin + layout.stageHeight + layout.chromeHeight + GAP_ABOVE_PIP_PX)
}

/** Floating control for the `.main-stage` scroll container (sections, home, etc.). */
export function BackToTop() {
  const { mode: playbackMode } = usePlayback()
  const { mode: webMode } = useWebBrowser()
  const [visible, setVisible] = useState(false)
  const [bottomPx, setBottomPx] = useState(20)
  const pipOpen = playbackMode === 'pip' || webMode === 'pip'
  /** Full / multi player covers the stage — Top is for shelf scrolling, not playback. */
  const hideForPlayer = playbackMode === 'full' || playbackMode === 'multi'

  useEffect(() => {
    const stage = getMainStage()
    if (!stage) return

    const onScroll = () => {
      setVisible(!hideForPlayer && stage.scrollTop > SHOW_AFTER_PX)
    }

    onScroll()
    stage.addEventListener('scroll', onScroll, { passive: true })
    return () => stage.removeEventListener('scroll', onScroll)
  }, [hideForPlayer])

  useEffect(() => {
    const syncBottom = () => {
      if (!pipOpen) {
        const narrow = window.matchMedia('(max-width: 640px)').matches
        setBottomPx(narrow ? 14 : 20)
        return
      }
      let clearance = 20
      if (playbackMode === 'pip') clearance = Math.max(clearance, playerPipClearancePx())
      if (webMode === 'pip') clearance = Math.max(clearance, webPipClearancePx())
      setBottomPx(clearance)
    }

    syncBottom()
    window.addEventListener('resize', syncBottom)
    return () => window.removeEventListener('resize', syncBottom)
  }, [pipOpen, playbackMode, webMode])

  if (!visible || hideForPlayer) return null

  return (
    <button
      type="button"
      className={`back-to-top${pipOpen ? ' back-to-top-above-pip' : ''}`}
      style={{ bottom: bottomPx }}
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
