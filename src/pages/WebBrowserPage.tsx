import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWebBrowser } from '../context/WebBrowserContext'
import { buildSearchUrl, toAutoplayUrl, type WebSearchKind } from '../lib/webBrowser'

const DEFAULT_URL = 'https://www.youtube.com/'

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

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
  const [toolsOpen, setToolsOpen] = useState(false)
  const bootedRef = useRef(false)
  const paramUrl = searchParams.get('url')
  const watching = Boolean(paramUrl || nav.url)

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

  const title = nav.title?.trim() || displayHost(nav.url || address) || 'Web'
  const host = displayHost(nav.url || address)

  return (
    <div
      className={`page web-browser-page${watching && !toolsOpen ? ' is-watching' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
    >
      {!watching && (
        <header className="page-header web-browser-header">
          <p className="eyebrow">Desktop</p>
          <h1>Web browser</h1>
          <p className="lede">
            Search YouTube or the web, then use <strong>PiP</strong> to keep watching while you
            browse Jiyu.
          </p>
        </header>
      )}

      {!desktop && (
        <div className="web-frame-banner">
          <p>This tab is not the Jiyu desktop app. Quit this browser tab and run:</p>
          <code className="web-frame-cmd">npm run dev:desktop</code>
        </div>
      )}

      <div className="web-chrome">
        <div className="web-chrome-bar">
          <div className="web-chrome-nav">
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop || !nav.canGoBack}
              onClick={goBack}
              aria-label="Back"
            >
              ←
            </button>
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop || !nav.canGoForward}
              onClick={goForward}
              aria-label="Forward"
            >
              →
            </button>
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop}
              onClick={reload}
              aria-label="Reload"
            >
              ↻
            </button>
          </div>

          <div className="web-chrome-meta" title={nav.url || address}>
            <strong className="web-chrome-title">{title}</strong>
            {host ? <span className="web-chrome-host">{host}</span> : null}
          </div>

          <div className="web-chrome-actions">
            <button
              type="button"
              className={`ghost-btn control-btn${toolsOpen ? ' is-active' : ''}`}
              disabled={!desktop}
              onClick={() => setToolsOpen((open) => !open)}
            >
              {toolsOpen ? 'Hide tools' : 'Browse'}
            </button>
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
              className="primary-btn control-btn"
              disabled={!desktop}
              onClick={toggleFullscreen}
            >
              {fullscreen ? 'Exit' : 'Full'}
            </button>
          </div>
        </div>

        {(toolsOpen || !watching) && (
          <div className="web-chrome-tools">
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
                  className={
                    searchKind === 'youtube' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'
                  }
                  onClick={() => setSearchKind('youtube')}
                >
                  YouTube
                </button>
                <button
                  type="button"
                  className={
                    searchKind === 'web' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'
                  }
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
              <button
                type="submit"
                className="primary-btn"
                disabled={!desktop || !searchQuery.trim()}
              >
                Search
              </button>
            </form>

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
          </div>
        )}
      </div>

      {status && (
        <div className="web-status">
          <span>{status}</span>
        </div>
      )}

      <div className={`web-player-tile ${fullscreen ? 'web-player-tile-fs' : ''} ${desktop ? 'is-live' : ''}`}>
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
