import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isTvMode, TV_MODE_EVENT } from '../lib/tvMode'
import { focusTvSurfaceIfIdle, startTvNav } from '../lib/tvNav'

/** Remote (D-pad) navigation — only active while html.tv-mode is set. */
export function TvNavBridge() {
  const [tv, setTv] = useState(() => isTvMode())
  const location = useLocation()

  useEffect(() => {
    const sync = () => setTv(isTvMode())
    window.addEventListener(TV_MODE_EVENT, sync)
    sync()
    return () => window.removeEventListener(TV_MODE_EVENT, sync)
  }, [])

  useEffect(() => {
    if (!tv) return
    return startTvNav()
  }, [tv])

  useEffect(() => {
    if (!tv) return
    // A freshly opened stream page: put the remote on the Gecko surface.
    const timers = [700, 1800].map((ms) => window.setTimeout(focusTvSurfaceIfIdle, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [tv, location.pathname])

  return null
}
