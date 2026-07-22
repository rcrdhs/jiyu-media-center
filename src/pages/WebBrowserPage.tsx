import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AUTOPLAY_SCRIPT,
  WEB_PRESETS,
  isDesktopApp,
  toAutoplayUrl,
} from '../lib/webBrowser'
import type { BrowserNavState } from '../types'

const DEFAULT_URL = WEB_PRESETS[0].url
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

type ElectronWebview = HTMLElement & {
  src: string
  loadURL?: (url: string) => void
  getURL?: () => string
  getTitle?: () => string
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  isLoading?: () => boolean
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
  addEventListener: (type: string, listener: (...args: unknown[]) => void) => void
  removeEventListener: (type: string, listener: (...args: unknown[]) => void) => void
}

function isElectronShell() {
  return isDesktopApp() || /Electron/i.test(navigator.userAgent)
}

function readNav(webview: ElectronWebview): BrowserNavState {
  try {
    return {
      url: webview.getURL?.() || webview.src || '',
      title: webview.getTitle?.() || 'Web browser',
      canGoBack: Boolean(webview.canGoBack?.()),
      canGoForward: Boolean(webview.canGoForward?.()),
      loading: Boolean(webview.isLoading?.()),
    }
  } catch {
    return {
      url: webview.src || '',
      title: 'Web browser',
      canGoBack: false,
      canGoForward: false,
      loading: false,
    }
  }
}

export function WebBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tileRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<ElectronWebview | null>(null)
  const autoplayTimers = useRef<number[]>([])
  const allowHtmlFullscreen = useRef(false)
  const electron = isElectronShell()
  const requestedUrl = toAutoplayUrl(searchParams.get('url') || DEFAULT_URL)

  const [address, setAddress] = useState(requestedUrl)
  const [status, setStatus] = useState(
    electron ? 'Pick a live source — it will play in the tile' : 'Open Jiyu with npm run dev:desktop',
  )
  const [ready, setReady] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [nav, setNav] = useState<BrowserNavState>({
    url: requestedUrl,
    title: 'Web browser',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })

  const clearAutoplayTimers = useCallback(() => {
    for (const id of autoplayTimers.current) window.clearTimeout(id)
    autoplayTimers.current = []
  }, [])

  const tryAutoplay = useCallback((webview: ElectronWebview) => {
    if (typeof webview.executeJavaScript !== 'function') return
    clearAutoplayTimers()
    const run = () => {
      void webview.executeJavaScript?.(AUTOPLAY_SCRIPT, true).catch(() => {})
    }
    run()
    // One delayed nudge only — avoids play/pause toggling from repeated clicks
    autoplayTimers.current.push(window.setTimeout(run, 1500))
  }, [clearAutoplayTimers])

  const openInApp = useCallback(
    async (raw: string) => {
      const target = toAutoplayUrl(raw)
      setAddress(target)
      setSearchParams(target === DEFAULT_URL ? {} : { url: target }, { replace: true })
      setNav((c) => ({ ...c, url: target, loading: true, title: 'Loading live…' }))
      setStatus('Opening live stream…')

      // Always stay in the 6×4 tile — never pop a separate fullscreen-like window
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen()
        } catch {
          /* ignore */
        }
      }

      const webview = webviewRef.current
      if (electron && webview) {
        try {
          if (typeof webview.loadURL === 'function') webview.loadURL(target)
          else webview.src = target
          return
        } catch (err) {
          setStatus(err instanceof Error ? err.message : 'Webview failed')
          setNav((c) => ({ ...c, loading: false, title: 'Failed' }))
          return
        }
      }

      setStatus('In-app browser not ready — fully quit Jiyu and run npm run dev:desktop')
      setNav((c) => ({ ...c, loading: false, title: 'Unavailable' }))
    },
    [electron, setSearchParams],
  )

  const toggleFullscreen = useCallback(async () => {
    const tile = tileRef.current
    if (!tile) return
    try {
      if (document.fullscreenElement) {
        allowHtmlFullscreen.current = false
        await document.exitFullscreen()
      } else {
        // Only our tile chrome goes fullscreen — not YouTube's internal fullscreen
        allowHtmlFullscreen.current = true
        await tile.requestFullscreen()
      }
    } catch {
      allowHtmlFullscreen.current = false
      setStatus('Fullscreen not available')
    }
  }, [])

  useEffect(() => {
    const onFs = () => {
      const active = Boolean(document.fullscreenElement)
      setFullscreen(active)
      if (!active) allowHtmlFullscreen.current = false
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    if (!electron) return
    const frame = frameRef.current
    if (!frame) return

    void window.signalDesktop?.browserHide?.()

    const webview = document.createElement('webview') as unknown as ElectronWebview
    webview.setAttribute('partition', 'persist:jiyu-web')
    webview.setAttribute('useragent', CHROME_UA)
    webview.setAttribute('allowpopups', 'false')
    webview.setAttribute(
      'webpreferences',
      'contextIsolation=yes, sandbox=no, nativeWindowOpen=no, javascript=yes',
    )
    Object.assign(webview.style, {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'flex',
      background: '#000',
    })
    webview.src = requestedUrl

    const refresh = () => {
      const next = readNav(webview)
      setNav(next)
      if (next.url) setAddress(next.url)
      if (!next.loading) setStatus(next.title || 'Ready')
      else setStatus('Loading live stream…')
    }

    let sawReady = false
    let autoplayArmed = false

    const onDomReady = () => {
      sawReady = true
      setReady(true)
      refresh()
      if (!autoplayArmed) {
        autoplayArmed = true
        tryAutoplay(webview)
      }
      setStatus('Live player ready')
    }

    const onStop = () => {
      refresh()
      // Single autoplay pass after navigation settles
      if (!autoplayArmed) {
        autoplayArmed = true
        tryAutoplay(webview)
      }
    }

    const onStart = () => {
      autoplayArmed = false
      clearAutoplayTimers()
      refresh()
    }

    const onFail = (...args: unknown[]) => {
      const code = typeof args[1] === 'number' ? args[1] : 0
      const desc = typeof args[2] === 'string' ? args[2] : 'Load failed'
      if (code === -3) return
      // Stay in the tile — do not open another window or fullscreen
      setNav((c) => ({ ...c, loading: false, title: `Unavailable (${desc})` }))
      setStatus(`Stream unavailable — stay in tile. Try another source or Fullscreen when playing.`)
    }

    // Block YouTube/HTML fullscreen unless user pressed our Fullscreen button
    const onEnterHtmlFs = () => {
      if (allowHtmlFullscreen.current) return
      void webview.executeJavaScript?.(
        `(() => { try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {} })();`,
        false,
      )
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-navigate', onStart)
    webview.addEventListener('did-navigate-in-page', refresh)
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    webview.addEventListener('page-title-updated', refresh)
    webview.addEventListener('did-fail-load', onFail)
    webview.addEventListener('enter-html-fullscreen', onEnterHtmlFs)

    frame.innerHTML = ''
    frame.appendChild(webview)
    webviewRef.current = webview

    const probe = window.setTimeout(() => {
      if (sawReady || webviewRef.current !== webview) return
      if (typeof webview.loadURL !== 'function') {
        setStatus('Restart Jiyu fully with npm run dev:desktop')
        setNav((c) => ({ ...c, loading: false, title: 'Unavailable' }))
      }
    }, 2500)

    return () => {
      window.clearTimeout(probe)
      clearAutoplayTimers()
      webviewRef.current = null
      setReady(false)
      try {
        frame.removeChild(webview)
      } catch {
        frame.innerHTML = ''
      }
      void window.signalDesktop?.browserHide?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [electron])

  useEffect(() => {
    if (!electron || !ready) return
    if (!searchParams.get('url')) return
    void openInApp(requestedUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [electron, ready])

  return (
    <div className="page web-browser-page">
      <header className="page-header web-browser-header">
        <p className="eyebrow">Desktop</p>
        <h1>Web browser</h1>
        <p className="lede">
          Live links play in the <strong>6″×4″ tile</strong>. Fullscreen only when you press the button.
        </p>
      </header>

      {!electron && (
        <div className="web-frame-banner">
          <p>This tab is not the Jiyu desktop app. Quit this browser tab and run:</p>
          <code className="web-frame-cmd">npm run dev:desktop</code>
        </div>
      )}

      <div className="web-presets">
        {WEB_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="local-source-btn"
            onClick={() => void openInApp(preset.url)}
          >
            <strong>{preset.label}</strong>
            <span>{preset.detail}</span>
          </button>
        ))}
      </div>

      <div className="web-toolbar">
        <button
          type="button"
          className="ghost-btn control-btn"
          disabled={!electron || !nav.canGoBack}
          onClick={() => webviewRef.current?.goBack?.()}
        >
          ←
        </button>
        <button
          type="button"
          className="ghost-btn control-btn"
          disabled={!electron || !nav.canGoForward}
          onClick={() => webviewRef.current?.goForward?.()}
        >
          →
        </button>
        <button
          type="button"
          className="ghost-btn control-btn"
          disabled={!electron}
          onClick={() => webviewRef.current?.reload?.()}
        >
          Reload
        </button>
        <form
          className="web-address-form"
          onSubmit={(e) => {
            e.preventDefault()
            void openInApp(address)
          }}
        >
          <input
            className="search-input web-address-input"
            type="url"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://…"
            aria-label="Address"
          />
          <button type="submit" className="primary-btn" disabled={!electron}>
            Play
          </button>
        </form>
        <button
          type="button"
          className="primary-btn"
          disabled={!electron}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? 'Exit full' : 'Fullscreen'}
        </button>
      </div>

      <div className="web-status">
        <span>{status}</span>
      </div>

      <div
        ref={tileRef}
        className={`web-player-tile ${fullscreen ? 'web-player-tile-fs' : ''} ${electron ? 'is-live' : ''}`}
      >
        <div className="web-player-tile-bar">
          <span className="web-player-tile-label">{nav.title || 'Live player'}</span>
          <button type="button" className="ghost-btn control-btn" onClick={() => void toggleFullscreen()}>
            {fullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
        <div
          ref={frameRef}
          className={`web-frame web-frame-tile ${electron ? 'web-frame-embed-active' : ''}`}
          aria-label="Live player tile"
        >
          {!electron && (
            <div className="web-frame-fallback">
              <p>Use the Jiyu desktop window to play here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
