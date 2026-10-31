import { useEffect, useRef, useState } from 'react'

/** Media3 must report 'playing' within this window, else open the embed. */
const NATIVE_STREAM_START_TIMEOUT_MS = 20_000
import { useLocation, useNavigate } from 'react-router-dom'
import { VolumeSlider } from '../components/VolumeSlider'
import { usePlayback } from '../context/PlaybackContext'
import {
  androidBrowserHide,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  isAndroidMedia3Host,
  media3Hide,
  media3OnPlayback,
  media3Play,
  media3SetBounds,
  media3SetVolume,
  media3Stop,
} from '../lib/androidMedia3'
import type { CategoryId } from '../types'

type NativeStreamState = {
  from?: string
  title?: string
  mediaUrl: string
  referrer?: string
  poster?: string
  category?: CategoryId
  continueId?: string
}

function boundsFromElement(el: HTMLElement | null) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return null
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

/**
 * Android Media3 watch surface — Gecko already resolved a direct media URL.
 */
export function NativeStreamPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state || {}) as NativeStreamState
  const stageRef = useRef<HTMLDivElement>(null)
  // Stay on "Unwrapping stream…" until Media3 reports real playback (not just play() ok).
  const [status, setStatus] = useState('Unwrapping stream\u2026')
  const [error, setError] = useState<string | null>(null)
  const [volume, setVolume] = useState(1)
  const mediaUrl = String(state.mediaUrl || '').trim()
  const { item: playingItem } = usePlayback()
  // Route state can be lost (HMR / process restore): fall back to the playing title.
  const title = state.title?.trim() || playingItem?.title?.trim() || 'Live'
  const from = state.from || '/section/sports'

  useEffect(() => {
    if (!isAndroidMedia3Host() || !mediaUrl) {
      setError('Native stream unavailable')
      return
    }
    if (isAndroidInAppBrowser()) {
      void androidBrowserHide({ blank: false, pause: true })
    }

    let cancelled = false
    let played = false
    let remove: { remove: () => Promise<void> } | null = null
    let fellBack = false
    let startTimer = 0

    const syncBounds = () => {
      const b = boundsFromElement(stageRef.current)
      if (b) void media3SetBounds(b)
    }

    const openEmbedFallback = () => {
      if (fellBack) return true
      const embed = String(state.referrer || '').trim()
      if (!embed) return false
      fellBack = true
      window.clearTimeout(startTimer)
      void media3Hide({ stop: true })
      navigate(`/web?url=${encodeURIComponent(embed)}`, {
        replace: true,
        state: { from, playerMode: 'embed', pipOnBack: true },
      })
      return true
    }

    // Media3 can sit in loading/buffering forever (dead or header-locked HLS) and
    // never emit 'error' - fall back to the Gecko embed if it hasn't started.
    startTimer = window.setTimeout(() => {
      if (cancelled || played) return
      console.warn('[jiyu] media3 start timeout - opening embed fallback')
      if (openEmbedFallback()) return
      setStatus('Error')
      setError('Stream did not start')
    }, NATIVE_STREAM_START_TIMEOUT_MS)

    void (async () => {
      const handle = await media3OnPlayback((ev) => {
        if (cancelled) return
        if (ev.state === 'playing') {
          played = true
          window.clearTimeout(startTimer)
          setStatus('Playing')
        } else if (ev.state === 'buffering' || ev.state === 'loading') {
          setStatus(played ? 'Buffering\u2026' : 'Unwrapping stream\u2026')
        }
        else if (ev.state === 'error') {
          // Auto-open the Gecko embed — a failed Media3 surface stays black.
          if (openEmbedFallback()) return
          setStatus('Error')
          setError(ev.detail || 'Playback failed')
        } else if (ev.state === 'ended') setStatus('Ended')
      })
      remove = handle

      const b = boundsFromElement(stageRef.current) || {
        x: 0,
        y: 56,
        width: window.innerWidth,
        height: Math.max(200, window.innerHeight - 120),
      }
      const result = await media3Play({
        url: mediaUrl,
        title,
        referrer: state.referrer || mediaUrl,
        ...b,
      })
      if (cancelled) return
      if (!result.ok) {
        if (openEmbedFallback()) return
        setError(result.error || 'Could not start Media3')
        return
      }
      void media3SetVolume(Math.round(volume * 100))
    })()

    const onResize = () => syncBounds()
    const orientTimers: number[] = []
    const onOrient = () => {
      syncBounds()
      for (const ms of [80, 280, 600, 1000]) {
        orientTimers.push(window.setTimeout(syncBounds, ms))
      }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrient)
    const ro =
      typeof ResizeObserver !== 'undefined' && stageRef.current
        ? new ResizeObserver(() => syncBounds())
        : null
    if (stageRef.current && ro) ro.observe(stageRef.current)

    return () => {
      cancelled = true
      window.clearTimeout(startTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onOrient)
      for (const id of orientTimers) window.clearTimeout(id)
      ro?.disconnect()
      void remove?.remove()
      void media3Hide({ stop: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per mediaUrl
  }, [mediaUrl])

  const goBack = () => {
    void media3Stop()
    void media3Hide({ stop: true })
    navigate(from, { replace: true })
  }

  if (!mediaUrl) {
    return (
      <div className="page web-browser-page">
        <p className="muted">No stream URL.</p>
        <button type="button" className="ghost-btn" onClick={() => navigate(from, { replace: true })}>
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="page web-browser-page is-watching is-embed-player native-stream-page">
      <div className="web-chrome">
        <div className="web-chrome-bar">
          <div className="web-chrome-nav">
            <button type="button" className="ghost-btn control-btn" onClick={goBack}>
              Back
            </button>
          </div>
          <div className="web-chrome-meta" title={title}>
            <strong className="web-chrome-title">{title}</strong>
            <span className="web-chrome-host">{status}</span>
          </div>
          <div className="web-chrome-actions">
            <label className="volume-control web-volume-control" title="Volume">
              <VolumeSlider
                value={volume}
                onChange={(v) => {
                  setVolume(v)
                  void media3SetVolume(Math.round(v * 100))
                }}
              />
            </label>
          </div>
        </div>
      </div>
      <div className="web-player-tile is-live">
        <div ref={stageRef} className="web-frame web-frame-tile native-stream-stage" />
      </div>
      {error ? (
        <div className="web-status" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              void media3Hide({ stop: true })
              const embed = state.referrer
              if (embed) {
                navigate(`/web?url=${encodeURIComponent(embed)}`, {
                  replace: true,
                  state: { from, playerMode: 'embed', pipOnBack: true },
                })
              } else {
                goBack()
              }
            }}
          >
            Open embed instead
          </button>
        </div>
      ) : null}
    </div>
  )
}
