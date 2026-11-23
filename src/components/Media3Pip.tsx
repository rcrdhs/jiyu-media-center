import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { getPipLayout } from '../context/WebBrowserContext'
import {
  isAndroidMedia3Host,
  media3Hide,
  media3Resume,
  media3SetBounds,
  media3SetVolume,
  media3Stop,
} from '../lib/androidMedia3'
import { isNativeMedia3PlaybackItem } from '../lib/webBrowser'

function pipBounds() {
  const { x, stageY, width, stageHeight } = getPipLayout()
  return { x, y: stageY, width, height: stageHeight }
}

/**
 * Corner chrome + Media3 surface for sports streams that were unwrapped to
 * native HLS. Keeps the same ExoPlayer instance — never reloads on Back.
 */
export function Media3Pip() {
  const navigate = useNavigate()
  const location = useLocation()
  const { item, mode, returnTo, stop, expand } = usePlayback()
  const [layout, setLayout] = useState(() =>
    typeof window === 'undefined'
      ? { width: 280, margin: 12, stageHeight: 158, chromeHeight: 40, x: 0, stageY: 0, chromeY: 0 }
      : getPipLayout(),
  )
  const [volumePercent, setVolumePercent] = useState(100)
  const active =
    isAndroidMedia3Host() &&
    mode === 'pip' &&
    Boolean(item && isNativeMedia3PlaybackItem(item))

  useEffect(() => {
    if (!active) return
    const place = () => {
      const next = getPipLayout()
      setLayout(next)
      void media3SetBounds(pipBounds())
    }
    place()
    void media3Resume()
    const t1 = window.setTimeout(place, 80)
    const t2 = window.setTimeout(place, 280)
    window.addEventListener('resize', place)
    window.addEventListener('orientationchange', place)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.removeEventListener('resize', place)
      window.removeEventListener('orientationchange', place)
    }
  }, [active, location.pathname])

  if (!active || !item) return null

  const pipItem = item
  const title = pipItem.title || 'Live'

  function closePip() {
    void media3Stop()
    void media3Hide({ stop: true })
    stop()
  }

  function expandPip() {
    expand()
    const from = returnTo || '/section/sports'
    navigate('/native-stream', {
      replace: true,
      state: {
        from,
        title: pipItem.title,
        mediaUrl: pipItem.url,
        referrer: pipItem.httpReferrer || pipItem.detailUrl || pipItem.url,
        poster: pipItem.poster,
        category: pipItem.category,
        continueId: pipItem.id,
      },
    })
  }

  return (
    <div
      className="web-browser-pip media3-pip"
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
          onClick={closePip}
          aria-label="Close"
        >
          ×
        </button>
        <div className="web-browser-pip-meta">
          <strong title={title}>{title}</strong>
        </div>
        <div className="web-browser-pip-actions">
          <button
            type="button"
            className="ghost-btn control-btn web-pip-mute-btn"
            onClick={() => {
              const next = volumePercent <= 0 ? 100 : 0
              setVolumePercent(next)
              void media3SetVolume(next)
            }}
            title={volumePercent <= 0 ? 'Unmute' : 'Mute'}
            aria-label={volumePercent <= 0 ? 'Unmute' : 'Mute'}
          >
            {volumePercent <= 0 ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" className="ghost-btn control-btn" onClick={expandPip}>
            Expand
          </button>
        </div>
      </div>
    </div>
  )
}

/** Resize Media3 into the corner PiP stage (same layout as web embed PiP). */
export function placeMedia3InPipCorner() {
  void media3SetBounds(pipBounds())
  void media3Resume()
}
