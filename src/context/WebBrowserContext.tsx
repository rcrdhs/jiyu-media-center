import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AUTOPLAY_WITH_SOUND_SCRIPT,
  BLOCK_GUEST_FULLSCREEN_SCRIPT,
  isDesktopApp,
  toAutoplayUrl,
} from '../lib/webBrowser'
import type { BrowserBounds, BrowserNavState } from '../types'

export type WebBrowserMode = 'off' | 'page' | 'pip'

const PIP_WIDTH = 320
const PIP_HEIGHT = 180
const PIP_CHROME = 36
const PIP_MARGIN = 12
const FULLSCREEN_CHROME = 40

type WebBrowserContextValue = {
  desktop: boolean
  mode: WebBrowserMode
  nav: BrowserNavState
  address: string
  setAddress: (value: string) => void
  status: string | null
  setStatus: (value: string | null) => void
  fullscreen: boolean
  /** Bind the native browser to the page tile (no reload if already on a URL). */
  attachFrame: (frame: HTMLElement) => void
  detachFrame: () => void
  openUrl: (raw: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  openInPip: (url?: string, title?: string) => void
  expandFromPip: () => void
  closeBrowser: () => void
  toggleFullscreen: () => void
}

const WebBrowserContext = createContext<WebBrowserContextValue | null>(null)

function boundsFromElement(el: HTMLElement): BrowserBounds {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

function pipStageBounds(): BrowserBounds {
  const width = Math.round(Math.min(PIP_WIDTH, window.innerWidth * 0.42))
  return {
    x: Math.round(window.innerWidth - width - PIP_MARGIN),
    y: Math.round(window.innerHeight - PIP_HEIGHT - PIP_MARGIN),
    width,
    height: PIP_HEIGHT,
  }
}

function fullscreenBounds(): BrowserBounds {
  return {
    x: 0,
    y: FULLSCREEN_CHROME,
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight - FULLSCREEN_CHROME)),
  }
}

function sameWatchUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    if (left.hostname.replace(/^www\./, '') !== right.hostname.replace(/^www\./, '')) return false
    if (left.pathname === '/watch' && right.pathname === '/watch') {
      return left.searchParams.get('v') === right.searchParams.get('v')
    }
    return left.href.split('#')[0] === right.href.split('#')[0]
  } catch {
    return a === b
  }
}

export function WebBrowserProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const desktop = isDesktopApp()
  const modeRef = useRef<WebBrowserMode>('off')
  const frameRef = useRef<HTMLElement | null>(null)
  const autoplayTimers = useRef<number[]>([])
  /** Cancels a pending detach when React Strict Mode remounts or Expand re-attaches. */
  const detachGeneration = useRef(0)
  const [mode, setMode] = useState<WebBrowserMode>('off')
  const [fullscreen, setFullscreen] = useState(false)
  const [address, setAddress] = useState('https://www.youtube.com/')
  const [status, setStatus] = useState<string | null>(
    desktop ? null : 'Open Jiyu with npm run dev:desktop',
  )
  const [nav, setNav] = useState<BrowserNavState>({
    url: '',
    title: 'Web browser',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })

  modeRef.current = mode

  const clearAutoplayTimers = useCallback(() => {
    for (const id of autoplayTimers.current) window.clearTimeout(id)
    autoplayTimers.current = []
  }, [])

  const nudgePlayback = useCallback(() => {
    if (!desktop || !window.signalDesktop?.browserExecute) return
    clearAutoplayTimers()
    const run = () => {
      void window.signalDesktop?.browserExecute?.(BLOCK_GUEST_FULLSCREEN_SCRIPT)
      void window.signalDesktop?.browserExecute?.(AUTOPLAY_WITH_SOUND_SCRIPT)
    }
    run()
    autoplayTimers.current.push(window.setTimeout(run, 600))
    autoplayTimers.current.push(window.setTimeout(run, 1600))
  }, [clearAutoplayTimers, desktop])

  const showAt = useCallback(
    async (bounds: BrowserBounds) => {
      if (!desktop) return
      await window.signalDesktop?.browserShow?.(bounds)
    },
    [desktop],
  )

  const syncPageBounds = useCallback(async () => {
    if (!desktop || modeRef.current !== 'page' || fullscreen) return
    const frame = frameRef.current
    if (!frame) return
    const bounds = boundsFromElement(frame)
    if (bounds.width < 8 || bounds.height < 8) return
    await window.signalDesktop?.browserSetBounds?.(bounds)
  }, [desktop, fullscreen])

  const attachFrame = useCallback(
    (frame: HTMLElement) => {
      // Cancel any pending hide from a Strict Mode / effect cleanup.
      detachGeneration.current += 1
      frameRef.current = frame
      const wasPip = modeRef.current === 'pip'
      setMode('page')
      modeRef.current = 'page'
      setFullscreen(false)
      frame.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const place = () => {
        const bounds = boundsFromElement(frame)
        if (bounds.width < 8 || bounds.height < 8) return
        void showAt(bounds)
      }
      place()
      requestAnimationFrame(() => {
        place()
        requestAnimationFrame(place)
      })
      // Expanding from PiP: same WebContentsView, just resized — keep audio, no reload.
      if (wasPip) nudgePlayback()
    },
    [nudgePlayback, showAt],
  )

  const detachFrame = useCallback(() => {
    frameRef.current = null
    if (modeRef.current === 'pip') return
    const token = ++detachGeneration.current
    // Defer hide so Expand / Strict Mode remount can re-attach without wiping playback.
    window.setTimeout(() => {
      if (token !== detachGeneration.current) return
      if (modeRef.current === 'pip') return
      if (frameRef.current) return
      setMode('off')
      modeRef.current = 'off'
      setFullscreen(false)
      // Pause + hide only — do not blank (keeps the YouTube session alive).
      void window.signalDesktop?.browserHide?.()
    }, 0)
  }, [])

  const openUrl = useCallback(
    async (raw: string) => {
      const target = toAutoplayUrl(raw)
      setAddress(target)
      setNav((current) => ({ ...current, url: target, loading: true }))
      setStatus(null)
      if (!desktop) {
        setStatus('In-app browser needs the desktop app')
        return
      }
      if (modeRef.current === 'off') {
        setMode('page')
        modeRef.current = 'page'
      }
      if (modeRef.current === 'page' && frameRef.current) {
        await showAt(boundsFromElement(frameRef.current))
      } else if (modeRef.current === 'pip') {
        await showAt(pipStageBounds())
      }
      const result = await window.signalDesktop?.browserNavigate?.(target)
      if (result && !result.ok) {
        setStatus(result.error || 'Failed to open')
        setNav((current) => ({ ...current, loading: false, title: 'Failed' }))
        return
      }
      nudgePlayback()
    },
    [desktop, nudgePlayback, showAt],
  )

  const openInPip = useCallback(
    (url?: string, title?: string) => {
      if (!desktop) return
      const current = nav.url || address
      const target = toAutoplayUrl(url || current || 'https://www.youtube.com/')
      setFullscreen(false)
      setMode('pip')
      modeRef.current = 'pip'
      frameRef.current = null
      setAddress(target)
      setNav((currentNav) => ({
        ...currentNav,
        url: target,
        title: title || currentNav.title || 'Web browser',
      }))
      setStatus(null)
      void showAt(pipStageBounds())
      // Only reload when PiP needs a different page — Expand/PiP on the same
      // watch URL should just move the existing view.
      if (!current || !sameWatchUrl(current, target)) {
        void window.signalDesktop?.browserNavigate?.(target)
        nudgePlayback()
      } else {
        nudgePlayback()
      }
      navigate('/')
    },
    [address, desktop, nav.url, navigate, nudgePlayback, showAt],
  )

  const expandFromPip = useCallback(() => {
    // Instant: route to /web; attachFrame resizes the live view into the tile.
    navigate('/web')
  }, [navigate])

  const closeBrowser = useCallback(() => {
    clearAutoplayTimers()
    detachGeneration.current += 1
    frameRef.current = null
    setMode('off')
    modeRef.current = 'off'
    setFullscreen(false)
    setStatus(null)
    void window.signalDesktop?.browserHide?.({ blank: true })
  }, [clearAutoplayTimers])

  const toggleFullscreen = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    setFullscreen((current) => {
      const next = !current
      if (next) {
        void showAt(fullscreenBounds())
      } else if (modeRef.current === 'pip') {
        void showAt(pipStageBounds())
      } else if (frameRef.current) {
        void showAt(boundsFromElement(frameRef.current))
      }
      return next
    })
  }, [desktop, showAt])

  useEffect(() => {
    if (!desktop || !window.signalDesktop?.onBrowserNav) return
    return window.signalDesktop.onBrowserNav((next) => {
      if (modeRef.current === 'off') return
      setNav(next)
      if (next.url) setAddress(next.url)
      if (!next.loading) {
        setStatus(null)
        if (modeRef.current === 'pip') nudgePlayback()
      }
    })
  }, [desktop, nudgePlayback])

  useEffect(() => {
    if (!desktop || mode !== 'page' || !frameRef.current || fullscreen) return
    const frame = frameRef.current
    const stage = frame.closest('.main-stage') as HTMLElement | null
    const observer = new ResizeObserver(() => {
      void syncPageBounds()
    })
    observer.observe(frame)
    const onLayout = () => {
      void syncPageBounds()
    }
    stage?.addEventListener('scroll', onLayout, { passive: true })
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, { passive: true, capture: true })
    void syncPageBounds()
    return () => {
      observer.disconnect()
      stage?.removeEventListener('scroll', onLayout)
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [desktop, mode, fullscreen, syncPageBounds])

  useEffect(() => {
    if (!desktop || mode !== 'pip' || fullscreen) return
    const onWin = () => {
      void showAt(pipStageBounds())
    }
    window.addEventListener('resize', onWin)
    void showAt(pipStageBounds())
    return () => window.removeEventListener('resize', onWin)
  }, [desktop, mode, fullscreen, showAt])

  useEffect(() => () => clearAutoplayTimers(), [clearAutoplayTimers])

  useEffect(() => {
    if (!fullscreen) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setFullscreen(false)
      if (modeRef.current === 'pip') void showAt(pipStageBounds())
      else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, showAt])

  const value = useMemo<WebBrowserContextValue>(
    () => ({
      desktop,
      mode,
      nav,
      address,
      setAddress,
      status,
      setStatus,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      goBack: () => {
        void window.signalDesktop?.browserGoBack?.()
      },
      goForward: () => {
        void window.signalDesktop?.browserGoForward?.()
      },
      reload: () => {
        void window.signalDesktop?.browserReload?.()
      },
      openInPip,
      expandFromPip,
      closeBrowser,
      toggleFullscreen,
    }),
    [
      desktop,
      mode,
      nav,
      address,
      status,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      openInPip,
      expandFromPip,
      closeBrowser,
      toggleFullscreen,
    ],
  )

  return <WebBrowserContext.Provider value={value}>{children}</WebBrowserContext.Provider>
}

export function useWebBrowser() {
  const ctx = useContext(WebBrowserContext)
  if (!ctx) throw new Error('useWebBrowser must be used within WebBrowserProvider')
  return ctx
}

export function pipChromeMetrics() {
  return {
    width: PIP_WIDTH,
    stageHeight: PIP_HEIGHT,
    chromeHeight: PIP_CHROME,
    margin: PIP_MARGIN,
  }
}
