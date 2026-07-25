import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWebBrowser } from '../context/WebBrowserContext'
import { buildSearchUrl, toAutoplayUrl, type WebSearchKind } from '../lib/webBrowser'

const DEFAULT_URL = 'https://www.youtube.com/'

export function WebBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const frameRef = useRef<HTMLDivElement>(null)
  const {
    desktop,
    mode,
    nav,
    address,
    setAddress,
    status,
    fullscreen,
    attachFrame,
    detachFrame,
    openUrl,
    goBack,
    goForward,
    reload,
    openInPip,
    toggleFullscreen,
  } = useWebBrowser()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchKind, setSearchKind] = useState<WebSearchKind>('youtube')
  const bootedRef = useRef(false)

  useEffect(() => {
    const frame = frameRef.current
    if (!desktop || !frame) return
    // Capture before attachFrame flips mode pip → page.
    const expandingFromPip = mode === 'pip'
    attachFrame(frame)
    if (!bootedRef.current) {
      bootedRef.current = true
      // Expand / live session: only resize — never reload (reload = blank + delay).
      if (!expandingFromPip) {
        const paramUrl = searchParams.get('url')
        if (paramUrl) {
          void openUrl(toAutoplayUrl(paramUrl))
        } else if (!nav.url) {
          void openUrl(DEFAULT_URL)
        }
      }
    }
    return () => {
      detachFrame()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, attachFrame, detachFrame])

  return (
    <div className="page web-browser-page">
      <header className="page-header web-browser-header">
        <p className="eyebrow">Desktop</p>
        <h1>Web browser</h1>
        <p className="lede">
          Search YouTube or the web, paste a link, and use <strong>PiP</strong> to keep watching
          while you browse Jiyu.
        </p>
      </header>

      {!desktop && (
        <div className="web-frame-banner">
          <p>This tab is not the Jiyu desktop app. Quit this browser tab and run:</p>
          <code className="web-frame-cmd">npm run dev:desktop</code>
        </div>
      )}

      <form
        className="web-search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void openUrl(buildSearchUrl(searchQuery, searchKind))
        }}
      >
        <div className="web-search-kind" role="group" aria-label="Search target">
          <button
            type="button"
            className={searchKind === 'youtube' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'}
            onClick={() => setSearchKind('youtube')}
          >
            YouTube
          </button>
          <button
            type="button"
            className={searchKind === 'web' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'}
            onClick={() => setSearchKind('web')}
          >
            Web
          </button>
        </div>
        <input
          className="search-input web-search-input"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={searchKind === 'youtube' ? 'Search YouTube…' : 'Search the web…'}
          aria-label={searchKind === 'youtube' ? 'Search YouTube' : 'Search the web'}
          disabled={!desktop}
        />
        <button type="submit" className="primary-btn" disabled={!desktop || !searchQuery.trim()}>
          Search
        </button>
      </form>

      <div className="web-toolbar">
        <button
          type="button"
          className="ghost-btn control-btn"
          disabled={!desktop || !nav.canGoBack}
          onClick={goBack}
        >
          ←
        </button>
        <button
          type="button"
          className="ghost-btn control-btn"
          disabled={!desktop || !nav.canGoForward}
          onClick={goForward}
        >
          →
        </button>
        <button type="button" className="ghost-btn control-btn" disabled={!desktop} onClick={reload}>
          Reload
        </button>
        <form
          className="web-address-form"
          onSubmit={(e) => {
            e.preventDefault()
            const target = toAutoplayUrl(address)
            setSearchParams(target === DEFAULT_URL ? {} : { url: target }, { replace: true })
            void openUrl(target)
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
          <button type="submit" className="primary-btn" disabled={!desktop}>
            Go
          </button>
        </form>
        <button
          type="button"
          className="primary-btn"
          disabled={!desktop}
          onClick={toggleFullscreen}
        >
          {fullscreen ? 'Exit full' : 'Fullscreen'}
        </button>
      </div>

      {status && (
        <div className="web-status">
          <span>{status}</span>
        </div>
      )}

      <div className={`web-player-tile ${fullscreen ? 'web-player-tile-fs' : ''} ${desktop ? 'is-live' : ''}`}>
        <div className="web-player-tile-bar">
          <span className="web-player-tile-label">{nav.title || 'Web browser'}</span>
          <div className="web-player-tile-actions">
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop}
              onClick={() => openInPip(nav.url || address, nav.title)}
            >
              PiP
            </button>
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop}
              onClick={toggleFullscreen}
            >
              {fullscreen ? 'Exit' : 'Full'}
            </button>
          </div>
        </div>
        <div
          ref={frameRef}
          className={`web-frame web-frame-tile ${desktop ? 'web-frame-embed-active' : ''}`}
          aria-label="Browser tile"
        >
          {!desktop && (
            <div className="web-frame-fallback">
              <p>Use the Jiyu desktop window to browse here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
