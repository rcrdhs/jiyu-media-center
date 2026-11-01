import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isTvMode, TV_MODE_EVENT } from '../lib/tvMode'
import { focusTvPrimaryIfIdle, focusTvRememberedIfIdle, focusTvStart, focusTvSurfaceIfIdle, startTvNav } from '../lib/tvNav'

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
    // The floating "Top" button outlives the page: don't let it hold focus into the next route.
    const stale = document.activeElement
    if (stale instanceof HTMLElement && stale.classList.contains('back-to-top')) stale.blur()
    // A freshly opened stream page: put the remote on the Gecko surface.
    const timers = [700, 1800].map((ms) => window.setTimeout(focusTvSurfaceIfIdle, ms))
    // Coming back (Back / history): return to the card that was opened.
    // Lists can take a few seconds to re-render, so poll briefly; stop once anything has focus.
    const started = Date.now()
    const poll = window.setInterval(() => {
      const active = document.activeElement
      const busy = Boolean(active && active !== document.body)
      if (busy || focusTvRememberedIfIdle() || Date.now() - started > 6000) window.clearInterval(poll)
    }, 250)
    // A section picked from the sections sheet unmounts the focused item, leaving focus on
    // <body>: once the page has content, start the remote on its first shelf.
    const path = location.pathname
    if (!path.startsWith('/watch') && !path.startsWith('/show/')) {
      for (const ms of [1500, 3500]) {
        timers.push(
          window.setTimeout(() => {
            const active = document.activeElement
            if (active && active !== document.body) return
            if (!focusTvRememberedIfIdle()) focusTvStart()
          }, ms),
        )
      }
    }
    // Detail page: Watch / the resume episode (episode lists load a bit later).
    if (location.pathname.startsWith('/show/')) {
      for (const ms of [400, 1200, 2600, 4500]) {
        timers.push(window.setTimeout(focusTvPrimaryIfIdle, ms))
      }
    }
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      window.clearInterval(poll)
    }
  }, [tv, location.pathname])

  return null
}
