import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { placeMedia3InPipCorner } from './Media3Pip'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { armMedia3PipHandoff } from '../lib/androidMedia3'
import { isNativeMedia3PlaybackItem } from '../lib/webBrowser'

/** Keep sports / live streams in PiP when leaving the watch or embed routes. */
export function NavigationPiPBridge() {
  const location = useLocation()
  const routeKeyRef = useRef('')
  const { mode, minimizeToPip, item } = usePlayback()
  const { minimizeActiveEmbedToPip } = useWebBrowser()

  useEffect(() => {
    const routeKey = `${location.pathname}${location.search}`
    const prevKey = routeKeyRef.current
    routeKeyRef.current = routeKey
    if (!prevKey || prevKey === routeKey) return

    const prevPath = prevKey.split('?')[0]
    const nextPath = location.pathname

    const leavingWatch =
      (prevPath.startsWith('/watch/') || prevPath === '/native-stream') &&
      !nextPath.startsWith('/watch/') &&
      nextPath !== '/native-stream'
    if (leavingWatch) {
      // Multi-view is entered from /watch → /multiview. Do NOT demote it to PiP
      // or the second stream never mounts (mode becomes pip with 2 slots).
      if (mode === 'multi' || nextPath.startsWith('/multiview')) return
      // Embed handoff (/web) owns playback — don't leave a native PiP fighting OS FS.
      if (nextPath === '/web') return
      if (mode === 'full') {
        if (prevPath === '/native-stream' && item && isNativeMedia3PlaybackItem(item)) {
          armMedia3PipHandoff()
          placeMedia3InPipCorner()
        }
        minimizeToPip()
      }
    }

    if (prevPath === '/web' && nextPath !== '/web') {
      // Armed multi-view: first embed is already in PiP while picking the next match.
      if (mode === 'multi' || nextPath.startsWith('/multiview')) return
      minimizeActiveEmbedToPip()
    }
  }, [location.pathname, location.search, mode, item, minimizeToPip, minimizeActiveEmbedToPip])

  return null
}
