import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'

/** Keep sports / live streams in PiP when leaving the watch or embed routes. */
export function NavigationPiPBridge() {
  const location = useLocation()
  const routeKeyRef = useRef('')
  const { mode, minimizeToPip } = usePlayback()
  const { minimizeActiveEmbedToPip } = useWebBrowser()

  useEffect(() => {
    const routeKey = `${location.pathname}${location.search}`
    const prevKey = routeKeyRef.current
    routeKeyRef.current = routeKey
    if (!prevKey || prevKey === routeKey) return

    const prevPath = prevKey.split('?')[0]
    const nextPath = location.pathname

    if (prevPath.startsWith('/watch/') && !nextPath.startsWith('/watch/')) {
      // Multi-view is entered from /watch → /multiview. Do NOT demote it to PiP
      // or the second stream never mounts (mode becomes pip with 2 slots).
      if (mode === 'multi' || nextPath.startsWith('/multiview')) return
      // Embed handoff (/web) owns playback — don't leave a native PiP fighting OS FS.
      if (nextPath === '/web') return
      if (mode === 'full') minimizeToPip()
    }

    if (prevPath === '/web' && nextPath !== '/web') {
      // Armed multi-view: first embed is already in PiP while picking the next match.
      if (mode === 'multi' || nextPath.startsWith('/multiview')) return
      minimizeActiveEmbedToPip()
    }
  }, [location.pathname, location.search, mode, minimizeToPip, minimizeActiveEmbedToPip])

  return null
}
