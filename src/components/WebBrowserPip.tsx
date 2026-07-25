import { useWebBrowser } from '../context/WebBrowserContext'

/** Floating chrome for web-browser PiP (native WebContentsView draws the page). */
export function WebBrowserPip() {
  const { mode, nav, expandFromPip, closeBrowser, fullscreen, toggleFullscreen } = useWebBrowser()

  if (fullscreen && mode === 'pip') {
    return (
      <div className="web-browser-fs-bar">
        <span className="web-browser-pip-meta">
          <strong title={nav.title || nav.url}>{nav.title || 'Web browser'}</strong>
        </span>
        <button type="button" className="ghost-btn control-btn" onClick={toggleFullscreen}>
          Exit full
        </button>
      </div>
    )
  }

  if (mode !== 'pip') return null

  return (
    <div className="web-browser-pip">
      <div className="web-browser-pip-bar">
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={closeBrowser}
          aria-label="Close web PiP"
        >
          ×
        </button>
        <div className="web-browser-pip-meta">
          <strong title={nav.title || nav.url}>{nav.title || 'Web browser'}</strong>
        </div>
        <div className="web-browser-pip-actions">
          <button type="button" className="ghost-btn control-btn" onClick={toggleFullscreen}>
            Full
          </button>
          <button type="button" className="ghost-btn control-btn" onClick={expandFromPip}>
            Expand
          </button>
        </div>
      </div>
    </div>
  )
}
