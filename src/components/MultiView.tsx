import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StreamItem } from '../types'
import { usePlayback } from '../context/PlaybackContext'
import {
  enterOsFullscreen,
  exitOsFullscreen,
  getFullscreenOwner,
  subscribeFullscreenOwner,
} from '../lib/fullscreenSession'
import {
  androidBrowserHide,
  androidBrowserMultiHideAll,
  androidBrowserMultiSpotlight,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import { isDesktopApp, isWebEmbedPlaybackItem } from '../lib/webBrowser'
import { Player } from './Player'
import { WebEmbedTile } from './WebEmbedTile'

interface MultiViewProps {
  slots: StreamItem[]
  primaryId: string | null
  onSpotlight: (id: string) => void
  onRemove: (id: string) => void
  onCloseAll: () => void
  onMinimize?: () => void
}

export function MultiView({
  slots,
  primaryId,
  onSpotlight,
  onRemove,
  onCloseAll,
  onMinimize,
}: MultiViewProps) {
  const navigate = useNavigate()
  const { awaitingAdd, armMultiviewAdd, cancelMultiviewAdd } = usePlayback()
  const electron = isDesktopApp()
  const android = isAndroidInAppBrowser()
  const count = slots.length
  const gridClass =
    count <= 1 ? 'cols-1' : count === 2 ? 'cols-2' : count === 3 ? 'cols-3' : 'cols-2x2'
  const aliveRef = useRef(true)
  const [isFullscreen, setIsFullscreen] = useState(
    () => getFullscreenOwner() === 'multi',
  )

  useEffect(() => {
    aliveRef.current = true
    document.documentElement.classList.add('multiview-open')
    // Kill single-stream Gecko completely so its audio cannot leak under Multiview.
    if (electron) void window.signalDesktop?.browserHide?.({ blank: true, pause: true })
    else if (android) void androidBrowserHide({ blank: true, pause: true })
    const t = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
    return () => {
      aliveRef.current = false
      window.clearTimeout(t)
      document.documentElement.classList.remove('multiview-open')
      void exitOsFullscreen({ onlyIfOwner: 'multi' })
    }
  }, [electron, android])

  useEffect(() => {
    return subscribeFullscreenOwner((owner) => {
      setIsFullscreen(owner === 'multi')
    })
  }, [])

  // Native tile overlays must re-measure after the bar collapses / stage goes edge-to-edge.
  useEffect(() => {
    const t1 = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    const t2 = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 250)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [isFullscreen])

  useEffect(() => {
    const stop = window.signalDesktop?.onFullScreenChange?.((state) => {
      if (!state?.fullScreen && getFullscreenOwner() === 'multi') {
        void exitOsFullscreen({ onlyIfOwner: 'multi' })
      }
    })
    return () => stop?.()
  }, [])

  // Clicking a non-primary native embed switches audio there.
  useEffect(() => {
    const stop = window.signalDesktop?.onBrowserMultiFocus?.((state) => {
      const id = String(state?.id || '')
      if (!id) return
      if (!slots.some((s) => s.id === id)) return
      if (id === primaryId) return
      onSpotlight(id)
    })
    return () => stop?.()
  }, [slots, primaryId, onSpotlight])

  // Keep mute graph in sync whenever the spotlight changes.
  useEffect(() => {
    if (!primaryId) return
    if (electron) void window.signalDesktop?.browserMultiSpotlight?.({ id: primaryId })
    else if (android) void androidBrowserMultiSpotlight({ id: primaryId })
  }, [primaryId, slots.length, electron, android])

  const toggleFullscreen = useCallback(() => {
    if (getFullscreenOwner() === 'multi') {
      void exitOsFullscreen({ onlyIfOwner: 'multi' })
      return
    }
    void enterOsFullscreen('multi')
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'f' || e.key === 'F') {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        toggleFullscreen()
      }
      if (e.key === 'Escape' && getFullscreenOwner() === 'multi') {
        e.preventDefault()
        void exitOsFullscreen({ onlyIfOwner: 'multi' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen])

  return (
    <div
      className={`multi-view multi-view-full ${gridClass}${isFullscreen ? ' is-fullscreen' : ''}`}
      role="dialog"
      aria-label="Multi-view"
    >
      <header className="multi-view-bar">
        <button type="button" className="ghost-btn control-btn" onClick={onCloseAll}>
          ← Close all
        </button>
        <div className="multi-view-meta">
          <strong>Multi-view</strong>
          <span>
            {count} stream{count === 1 ? '' : 's'} · click a tile for audio
            {awaitingAdd ? ' · pick another channel to add' : ''}
          </span>
        </div>
        <div className="multi-view-actions">
          {count < 4 && (
            <button
              type="button"
              className={`ghost-btn control-btn${awaitingAdd ? ' is-armed' : ''}`}
              onClick={() => {
                if (awaitingAdd) cancelMultiviewAdd()
                else {
                  armMultiviewAdd()
                  void exitOsFullscreen({ onlyIfOwner: 'multi' })
                  // Detach tiles so the sports shelf isn't covered by native views.
                  if (electron) {
                    void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
                  } else if (android) {
                    void androidBrowserMultiHideAll({ blank: false })
                  }
                  navigate('/section/sports')
                }
              }}
            >
              {awaitingAdd ? 'Cancel add' : 'Add stream'}
            </button>
          )}
          <button
            type="button"
            className={`ghost-btn control-btn${isFullscreen ? ' is-armed' : ''}`}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc / F)' : 'Fullscreen multi-view (F)'}
          >
            {isFullscreen ? 'Exit full' : 'Full'}
          </button>
          {onMinimize && (
            <button
              type="button"
              className="ghost-btn control-btn"
              onClick={() => {
                void exitOsFullscreen({ onlyIfOwner: 'multi' })
                onMinimize()
              }}
              title="Leave multi-view — keep spotlight stream in PiP"
            >
              PiP
            </button>
          )}
        </div>
      </header>
      {isFullscreen ? (
        <button
          type="button"
          className="multi-view-fs-exit"
          onClick={toggleFullscreen}
          title="Exit fullscreen (Esc / F)"
        >
          Exit full
        </button>
      ) : null}
      <div className={`multi-view-grid ${gridClass}`}>
        {slots.map((slot) =>
          isWebEmbedPlaybackItem(slot) ? (
            <WebEmbedTile
              key={slot.id}
              item={slot}
              isPrimary={slot.id === primaryId}
              onSpotlight={() => onSpotlight(slot.id)}
              onClose={() => onRemove(slot.id)}
            />
          ) : (
            <Player
              key={slot.id}
              item={slot}
              layout="tile"
              isPrimary={slot.id === primaryId}
              onSpotlight={() => onSpotlight(slot.id)}
              onClose={() => onRemove(slot.id)}
            />
          ),
        )}
      </div>
    </div>
  )
}
