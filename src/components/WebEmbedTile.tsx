import { useEffect, useRef } from 'react'
import {
  androidBrowserMultiHide,
  androidBrowserMultiNudge,
  androidBrowserMultiSetAudio,
  androidBrowserMultiSetBounds,
  androidBrowserMultiShow,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import { boundsFromElement } from '../context/WebBrowserContext'
import { isDesktopApp, toAutoplayUrl } from '../lib/webBrowser'
import type { StreamItem } from '../types'

interface WebEmbedTileProps {
  item: StreamItem
  isPrimary: boolean
  onSpotlight: () => void
  onClose: () => void
}

/** Native overlay tile for multi-view sports / embed streams (Electron or Android Gecko). */
export function WebEmbedTile({ item, isPrimary, onSpotlight, onClose }: WebEmbedTileProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const electron = isDesktopApp()
  const android = isAndroidInAppBrowser()
  const native = electron || android
  const playUrl = toAutoplayUrl(item.url)
  const primaryRef = useRef(isPrimary)
  primaryRef.current = isPrimary

  // Keep the native view alive for this slot — do NOT recreate when spotlight changes.
  useEffect(() => {
    if (!native || !frameRef.current) return
    const el = frameRef.current
    let cancelled = false

    const boundsOf = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return null
      // Android: shared clamp so tiles don't sit under the rail / top chrome.
      if (android) return boundsFromElement(el)
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
    }

    const place = () => {
      if (cancelled || !el.isConnected) return
      const bounds = boundsOf()
      if (!bounds) return
      if (electron) {
        void window.signalDesktop?.browserMultiShow?.({
          id: item.id,
          url: playUrl,
          bounds,
          primary: primaryRef.current,
        })
      } else {
        void androidBrowserMultiShow({
          id: item.id,
          url: playUrl,
          bounds,
          primary: primaryRef.current,
        })
      }
    }

    place()
    const t1 = window.setTimeout(place, 50)
    const t2 = window.setTimeout(place, 200)
    const nudge = () => {
      if (electron) void window.signalDesktop?.browserMultiNudge?.({ id: item.id })
      else void androidBrowserMultiNudge({ id: item.id })
    }
    const nudgeAt = primaryRef.current ? [700, 1800] : [500, 1400, 2800]
    const nudgeTimers = nudgeAt.map((ms) => window.setTimeout(nudge, ms))

    const syncBounds = () => {
      const bounds = boundsOf()
      if (!bounds) return
      if (electron) {
        void window.signalDesktop?.browserMultiSetBounds?.({ id: item.id, bounds })
      } else {
        void androidBrowserMultiSetBounds({ id: item.id, bounds })
      }
    }
    const ro = new ResizeObserver(syncBounds)
    ro.observe(el)
    window.addEventListener('resize', syncBounds)
    window.addEventListener('orientationchange', syncBounds)
    return () => {
      cancelled = true
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      for (const t of nudgeTimers) window.clearTimeout(t)
      ro.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('orientationchange', syncBounds)
      if (electron) void window.signalDesktop?.browserMultiHide?.({ id: item.id })
      else void androidBrowserMultiHide({ id: item.id })
    }
  }, [native, electron, android, item.id, playUrl])

  useEffect(() => {
    if (!native) return
    if (!isPrimary) {
      if (electron) {
        void window.signalDesktop?.browserMultiSetAudio?.({ id: item.id, muted: true })
      } else {
        void androidBrowserMultiSetAudio({ id: item.id, muted: true })
      }
    }
  }, [native, electron, item.id, isPrimary])

  return (
    <div
      className={`player-shell player-shell-tile web-embed-tile${isPrimary ? ' is-primary' : ''}`}
    >
      <header
        className="player-bar player-chrome tile-chrome"
        onClick={onSpotlight}
        title={isPrimary ? 'Audio on this stream' : 'Click to switch audio here'}
      >
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Remove stream"
        >
          ×
        </button>
        <div className="player-meta">
          <h2 title={item.title}>{item.title}</h2>
        </div>
        <div className="player-controls">
          <button
            type="button"
            className={`ghost-btn control-btn${isPrimary ? ' is-armed' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onSpotlight()
            }}
            title={isPrimary ? 'Audio is on this stream' : 'Switch audio to this stream'}
          >
            {isPrimary ? 'Audio' : 'Audio'}
          </button>
        </div>
      </header>
      <div ref={frameRef} className="web-embed-tile-stage" aria-label={item.title} />
    </div>
  )
}
