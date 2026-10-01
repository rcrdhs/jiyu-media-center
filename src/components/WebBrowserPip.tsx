import { useEffect, useRef, useState } from 'react'
import { getPipLayout, useWebBrowser } from '../context/WebBrowserContext'
import {
  androidBrowserGetVolume,
  androidBrowserSetVolume,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'

/** Floating chrome for web-browser PiP (native WebContentsView draws the page). */
export function WebBrowserPip() {
  const {
    mode,
    nav,
    expandFromPip,
    closeBrowser,
    fullscreen,
    toggleFullscreen,
    syncBrowserView,
  } = useWebBrowser()
  const [volumePercent, setVolumePercent] = useState(100)
  const volumeBeforeMuteRef = useRef(100)
  const [layout, setLayout] = useState(() =>
    typeof window === 'undefined'
      ? { width: 380, margin: 12, stageHeight: 180, chromeHeight: 40, chromeY: 0 }
      : getPipLayout(),
  )

  useEffect(() => {
    if (mode !== 'pip') return
    const android = isAndroidInAppBrowser()
    void (async () => {
      const pctRaw = android
        ? await androidBrowserGetVolume()
        : Number((await window.signalDesktop?.browserGetVolume?.())?.percent) || 100
      const pct = Math.max(0, Math.min(100, Number(pctRaw) || 100))
      setVolumePercent(pct)
      if (pct > 0) volumeBeforeMuteRef.current = pct
    })()
    const stop = window.signalDesktop?.onBrowserVolume?.((state) => {
      const pct = Math.max(0, Math.min(100, Number(state?.percent) || 0))
      setVolumePercent(pct)
      if (pct > 0) volumeBeforeMuteRef.current = pct
    })
    return () => stop?.()
  }, [mode])

  useEffect(() => {
    if (mode !== 'pip' || fullscreen) return
    const sync = () => {
      setLayout(getPipLayout())
      // Keep the native stage under the HTML chrome — never covering Close/Mute/Full.
      syncBrowserView()
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [mode, fullscreen, syncBrowserView])

  function setEmbedVolume(percent: number) {
    const pct = Math.max(0, Math.min(100, Math.round(percent)))
    if (pct > 0) volumeBeforeMuteRef.current = pct
    setVolumePercent(pct)
    if (isAndroidInAppBrowser()) void androidBrowserSetVolume(pct)
    else void window.signalDesktop?.browserSetVolume?.(pct)
  }

  function toggleEmbedMute() {
    if (volumePercent <= 0) {
      setEmbedVolume(volumeBeforeMuteRef.current || 100)
      return
    }
    volumeBeforeMuteRef.current = volumePercent || 100
    setEmbedVolume(0)
  }

  if (mode !== 'pip') return null

  const volumeControls = (
    <button
      type="button"
      className="ghost-btn control-btn web-pip-mute-btn"
      onClick={toggleEmbedMute}
      title={volumePercent <= 0 ? 'Unmute' : 'Mute'}
      aria-label={volumePercent <= 0 ? 'Unmute' : 'Mute'}
    >
      {volumePercent <= 0 ? 'Unmute' : 'Mute'}
    </button>
  )

  if (fullscreen) {
    return (
      <div className="web-browser-fs-bar web-browser-pip-fs-bar">
        <button
          type="button"
          className="ghost-btn control-btn pip-close-btn"
          onClick={closeBrowser}
          aria-label="Close"
        >
          ×
        </button>
        <span className="web-browser-pip-meta">
          <strong title={nav.title || nav.url}>{nav.title || 'Web browser'}</strong>
        </span>
        <div className="web-browser-pip-actions">
          {volumeControls}
          <button type="button" className="ghost-btn control-btn" onClick={toggleFullscreen}>
            Exit full
          </button>
          <button type="button" className="ghost-btn control-btn" onClick={expandFromPip}>
            Expand
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="web-browser-pip"
      style={{
        width: layout.width,
        height: layout.chromeHeight,
        right: layout.margin,
        bottom: layout.margin + layout.stageHeight,
      }}
    >
      <div className="web-browser-pip-bar">
        <button
          type="button"
          className="ghost-btn control-btn pip-close-btn"
          onClick={closeBrowser}
          aria-label="Close web PiP"
        >
          ×
        </button>
        <div className="web-browser-pip-meta">
          <strong title={nav.title || nav.url}>{nav.title || 'Web'}</strong>
        </div>
        <div className="web-browser-pip-actions">
          {volumeControls}
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
