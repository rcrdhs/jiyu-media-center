import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { exitOsFullscreen } from '../lib/fullscreenSession'
import {
  isMinimizeToPipEnabled,
  subscribeMinimizeToPipPref,
} from '../lib/minimizeToPipPref'
import { isWebEmbedPlaybackItem } from '../lib/webBrowser'

/**
 * OS minimize → corner PiP (when armed). Syncs pref + eligibility to main so
 * Electron can restore the window instead of staying minimized.
 */
export function MinimizeToPipBridge() {
  const navigate = useNavigate()
  const { mode, item, slots, primaryId, minimizeToPip, stop } = usePlayback()
  const { mode: webMode, openInPip, minimizeActiveEmbedToPip, nav } = useWebBrowser()
  const handlingRef = useRef(false)
  const snapRef = useRef({
    mode,
    webMode,
    item,
    slots,
    primaryId,
    navUrl: nav.url,
  })
  snapRef.current = { mode, webMode, item, slots, primaryId, navUrl: nav.url }

  useEffect(() => {
    const sync = () => {
      const enabled = isMinimizeToPipEnabled()
      const snap = snapRef.current
      void window.signalDesktop?.setMinimizeToPipPolicy?.({
        enabled,
        armed:
          enabled &&
          snap.mode !== 'multi' &&
          snap.mode !== 'pip' &&
          snap.webMode !== 'pip' &&
          (snap.mode === 'full' || snap.webMode === 'page'),
      })
    }
    sync()
    return subscribeMinimizeToPipPref(sync)
  }, [mode, webMode])

  useEffect(() => {
    const stopListen = window.signalDesktop?.onMinimizeToPip?.(() => {
      if (handlingRef.current) return
      const snap = snapRef.current
      const enabled = isMinimizeToPipEnabled()
      const canPip =
        enabled &&
        snap.mode !== 'multi' &&
        snap.mode !== 'pip' &&
        snap.webMode !== 'pip' &&
        (snap.mode === 'full' || snap.webMode === 'page')
      if (!canPip) {
        void window.signalDesktop?.minimizeWindow?.()
        return
      }

      handlingRef.current = true
      window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))

      void (async () => {
        try {
          await exitOsFullscreen({ force: true })

          if (snap.webMode === 'page') {
            if (minimizeActiveEmbedToPip()) {
              navigate('/', { replace: true })
              return
            }
            if (snap.item && isWebEmbedPlaybackItem(snap.item) && snap.item.url) {
              stop()
              openInPip(snap.item.url, snap.item.title, { navigateTo: '/' })
              return
            }
            void window.signalDesktop?.minimizeWindow?.()
            return
          }

          if (snap.mode === 'full' && snap.item && isWebEmbedPlaybackItem(snap.item)) {
            const primary = snap.slots.find((s) => s.id === snap.primaryId) || snap.item
            stop()
            openInPip(primary.url || snap.navUrl, primary.title, { navigateTo: '/' })
            return
          }

          if (snap.mode === 'full') {
            minimizeToPip()
            navigate('/', { replace: true })
          }
        } finally {
          handlingRef.current = false
        }
      })()
    })
    return () => stopListen?.()
  }, [minimizeActiveEmbedToPip, minimizeToPip, navigate, openInPip, stop])

  return null
}
