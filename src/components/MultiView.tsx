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
  /** Leave the grid; keep streams parked for remount. */
  onDismount?: () => void
  onMinimize?: () => void
  /**
   * One native stream left after closing tiles: render it as the normal full / PiP
   * player in the same React position, so its <video> + hls.js keep playing.
   */
  solo?: { layout: 'full' | 'pip'; onExpand: () => void; onClose: () => void }
}

export function MultiView({
  slots,
  primaryId,
  onSpotlight,
  onRemove,
  onCloseAll,
  onDismount,
  onMinimize,
  solo,
}: MultiViewProps) {
  const isSolo = Boolean(solo)
  const navigate = useNavigate()
  const { awaitingAdd, armMultiviewAdd, cancelMultiviewAdd, dismountMulti } =
    usePlayback()
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
    if (isSolo) return
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
  }, [electron, android, isSolo])

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
    if (isSolo) return
    const stop = window.signalDesktop?.onBrowserMultiFocus?.((state) => {
      const id = String(state?.id || '')
      if (!id) return
      if (!slots.some((s) => s.id === id)) return
      if (id === primaryId) return
      onSpotlight(id)
    })
    return () => stop?.()
  }, [slots, primaryId, onSpotlight, isSolo])

  // Keep mute graph in sync whenever the spotlight changes.
  useEffect(() => {
    if (isSolo || !primaryId) return
    if (electron) void window.signalDesktop?.browserMultiSpotlight?.({ id: primaryId })
    else if (android) void androidBrowserMultiSpotlight({ id: primaryId })
  }, [primaryId, slots.length, electron, android, isSolo])

  const toggleFullscreen = useCallback(() => {
    if (getFullscreenOwner() === 'multi') {
      void exitOsFullscreen({ onlyIfOwner: 'multi' })
      return
    }
    void enterOsFullscreen('multi')
  }, [])

  useEffect(() => {
    if (isSolo) return
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
  }, [toggleFullscreen, isSolo])

  return (
    <div
      className={
        solo
          ? 'multi-view-solo'
          : `multi-view multi-view-full ${gridClass}${isFullscreen ? ' is-fullscreen' : ''}`
      }
      role={solo ? undefined : 'dialog'}
      aria-label={solo ? undefined : 'Multi-view'}
    >
      {/* Children keep fixed positions so a solo survivor is not remounted. */}
      {solo ? null : (
      <header className="multi-view-bar">
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={() => {
            void exitOsFullscreen({ onlyIfOwner: 'multi' })
            if (onDismount) {
              onDismount()
              return
            }
            dismountMulti()
            if (electron) void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
            else if (android) void androidBrowserMultiHideAll({ blank: false })
            navigate('/section/sports')
          }}
          title="Leave the grid — streams stay parked until you open Multi-view again"
        >
          ← Browse
        </button>
        <div className="multi-view-meta">
          <strong>Multi-view</strong>
          <span>
            {count} stream{count === 1 ? '' : 's'}
            {count > 1 ? ' · click a tile for audio' : ''}
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
                  dismountMulti()
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
          <button
            type="button"
            className="ghost-btn control-btn"
            onClick={onCloseAll}
            title="Stop every stream and leave multi-view"
          >
            Close all
          </button>
        </div>
      </header>
      )}
      {!solo && isFullscreen ? (
        <button
          type="button"
          className="multi-view-fs-exit"
          onClick={toggleFullscreen}
          title="Exit fullscreen (Esc / F)"
        >
          Exit full
        </button>
      ) : null}
      <div className={solo ? 'multi-view-solo-grid' : `multi-view-grid ${gridClass}`}>
        {slots.map((slot) =>
          solo ? (
            isWebEmbedPlaybackItem(slot) ? null : (
              <Player
                key={slot.id}
                item={slot}
                layout={solo.layout}
                onExpand={solo.onExpand}
                onClose={solo.onClose}
              />
            )
          ) : isWebEmbedPlaybackItem(slot) ? (
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
