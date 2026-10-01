import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import {
  ANDROID_LEAVE_WEB_EMBED_EVENT,
  androidExitApp,
  isAndroidShell,
  onAndroidBackButton,
  setAndroidBackHandling,
} from '../lib/androidFullscreen'
import { exitOsFullscreen, getFullscreenOwner } from '../lib/fullscreenSession'
import { dismissTopOverlay } from '../lib/overlayDismiss'

const EXIT_CONFIRM_MS = 2500

function sectionPathFromLocation(path: string, returnTo?: string | null): string {
  if (returnTo && returnTo.startsWith('/section/')) return returnTo
  if (path.startsWith('/section/')) return path
  const match = /^\/(show|watch)\/([^/?#]+)/.exec(path)
  if (match) {
    // Prefer an explicit shelf return; otherwise land on Home sections entry.
    if (returnTo && returnTo !== '/' && !returnTo.startsWith('/show') && !returnTo.startsWith('/watch')) {
      return returnTo
    }
  }
  if (path.startsWith('/library') || path.startsWith('/browse') || path.startsWith('/multiview')) {
    return path
  }
  return '/'
}

/**
 * Hardware Back on Android — finite ladder:
 * overlay → leave watch/embed → section → home → “press again to exit” → exit.
 */
export function AndroidBackBridge() {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, returnTo, minimizeToPip } = usePlayback()
  const {
    mode: webMode,
    fullscreen: webFullscreen,
    exitFullscreen,
    closeBrowser,
  } = useWebBrowser()
  const [exitHint, setExitHint] = useState<string | null>(null)
  const exitArmedUntil = useRef(0)

  const snap = useRef({
    path: location.pathname,
    mode,
    returnTo,
    webMode,
    webFullscreen,
  })
  snap.current = {
    path: location.pathname,
    mode,
    returnTo,
    webMode,
    webFullscreen,
  }

  useEffect(() => {
    if (!exitHint) return
    const t = window.setTimeout(() => setExitHint(null), EXIT_CONFIRM_MS)
    return () => window.clearTimeout(t)
  }, [exitHint])

  useEffect(() => {
    if (!isAndroidShell()) return
    let stopListen: (() => void) | undefined
    let cancelled = false
    void (async () => {
      stopListen = onAndroidBackButton(() => {
        const s = snap.current
        const now = Date.now()

        // 0) Added today / sections menu / other overlays.
        if (dismissTopOverlay()) {
          exitArmedUntil.current = 0
          setExitHint(null)
          return
        }

        // 1) Sports / series embed on /web → same as on-screen ← Back.
        if (s.path.startsWith('/web') && s.webMode === 'page') {
          exitArmedUntil.current = 0
          setExitHint(null)
          window.dispatchEvent(new Event(ANDROID_LEAVE_WEB_EMBED_EVENT))
          return
        }

        // 2) Exit OS / player fullscreen when not leaving an embed surface.
        if (s.webFullscreen || getFullscreenOwner() !== null) {
          exitArmedUntil.current = 0
          setExitHint(null)
          exitFullscreen()
          void exitOsFullscreen({ force: true })
          if (s.mode === 'full') {
            minimizeToPip()
            const dest = s.returnTo || '/'
            if (s.path.startsWith('/watch') || s.path.startsWith('/show')) {
              navigate(dest, { replace: true })
            }
          }
          return
        }

        // 3) Native full player → corner PiP and leave the watch route.
        if (s.mode === 'full') {
          exitArmedUntil.current = 0
          setExitHint(null)
          minimizeToPip()
          const dest = s.returnTo || '/'
          if (s.path.startsWith('/watch') || s.path.startsWith('/show')) {
            navigate(dest, { replace: true })
          }
          return
        }

        // 4) Web PiP alone — close it; stay on current shelf.
        if (s.webMode === 'pip') {
          exitArmedUntil.current = 0
          setExitHint(null)
          closeBrowser()
          return
        }

        const path = s.path || '/'
        const atHome = path === '/' || path === ''

        // 5) Detail / watch → section (not endless history.back).
        if (
          path.startsWith('/show/') ||
          path.startsWith('/watch/') ||
          path.startsWith('/web')
        ) {
          exitArmedUntil.current = 0
          setExitHint(null)
          const section = sectionPathFromLocation(path, s.returnTo)
          navigate(section === path ? '/' : section, { replace: true })
          return
        }

        // 6) Section / library / browse → home.
        if (!atHome) {
          exitArmedUntil.current = 0
          setExitHint(null)
          navigate('/', { replace: true })
          return
        }

        // 7) Home — confirm, then exit the app.
        if (now <= exitArmedUntil.current) {
          exitArmedUntil.current = 0
          setExitHint(null)
          void androidExitApp()
          return
        }
        exitArmedUntil.current = now + EXIT_CONFIRM_MS
        setExitHint('Press Back again to exit')
      })
      if (cancelled) {
        stopListen()
        return
      }
      await setAndroidBackHandling(true)
    })()
    return () => {
      cancelled = true
      stopListen?.()
      void setAndroidBackHandling(false)
    }
  }, [navigate, minimizeToPip, exitFullscreen, closeBrowser])

  if (!exitHint || typeof document === 'undefined') return null
  return createPortal(
    <p className="toast android-exit-toast" role="status">
      {exitHint}
    </p>,
    document.body,
  )
}
