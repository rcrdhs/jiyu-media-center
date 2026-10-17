import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { exitOsFullscreen, handFullscreenToCurrentStream } from '../lib/fullscreenSession'
import {
  androidBrowserHide,
  androidBrowserMultiHide,
  androidBrowserMultiHideAll,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  isNativeMedia3PlaybackItem,
  isWebEmbedPlaybackItem,
} from '../lib/webBrowser'
import { media3Hide, isAndroidMedia3Host } from '../lib/androidMedia3'
import { MultiView } from './MultiView'
import { Player } from './Player'

function clearWebSurfaces(options?: { blank?: boolean }) {
  const blank = options?.blank !== false
  // Single-stream BrowserView/Gecko must hide too — multiHideAll alone left
  // atlantic.st's Warp interstitial painted over native Movy/Atlantic HLS.
  void window.signalDesktop?.browserMultiHideAll?.({ blank })
  void window.signalDesktop?.browserAdDockClose?.()
  void window.signalDesktop?.browserHide?.({ blank, pause: true })
  if (isAndroidInAppBrowser()) {
    void androidBrowserMultiHideAll({ blank })
    void androidBrowserHide({ blank, pause: true })
  }
  window.dispatchEvent(new Event('jiyu:clear-web-surfaces'))
}

export function GlobalPlayer() {
  const {
    item,
    slots,
    primaryId,
    mode,
    returnTo,
    resumeItem,
    awaitingAdd,
    multiMounted,
    cancelMultiviewAdd,
    dismountMulti,
    mountMulti,
    minimizeToPip,
    expand,
    stop,
    spotlight,
    removeSlot,
    leaveGuideWatch,
  } = usePlayback()
  const { openInPip, parkForMultiview, closeBrowser } = useWebBrowser()
  const navigate = useNavigate()
  const location = useLocation()

  // Hard-reset native web tiles whenever playback stops.
  useEffect(() => {
    if (mode !== 'off') return
    clearWebSurfaces({ blank: true })
    if (isAndroidMedia3Host()) void media3Hide({ stop: true })
    void handFullscreenToCurrentStream(null)
  }, [mode])

  // Stream selected — Full ownership follows the current title (not a leftover PiP).
  useEffect(() => {
    if (!item || mode === 'off') return
    // Multi grid (mounted or docked) owns embed tiles — don't hand Full to /web.
    if (mode === 'multi') return
    if (isNativeMedia3PlaybackItem(item)) {
      void handFullscreenToCurrentStream('native')
      clearWebSurfaces({ blank: true })
      closeBrowser()
      return
    }
    if (isWebEmbedPlaybackItem(item)) {
      if (isAndroidMedia3Host()) void media3Hide({ stop: true })
      void handFullscreenToCurrentStream('web')
      return
    }
    // Native HLS (Movy/Atlantic) — never leave a leftover embed covering the stage
    // (atlantic.st Warp interstitial was showing over playing video + subs).
    void handFullscreenToCurrentStream('native')
    clearWebSurfaces({ blank: true })
    // Always close even if mode was already "off" — view can desync and stay visible.
    closeBrowser()
    if (isAndroidMedia3Host()) void media3Hide({ stop: true })
  }, [item?.id, mode, closeBrowser, item])

  // Entering multi-view: park the single-player browser so tiles own the embeds.
  useEffect(() => {
    if (mode !== 'multi' || !multiMounted || slots.length < 1) return
    if (!slots.some((slot) => isWebEmbedPlaybackItem(slot))) return
    parkForMultiview()
  }, [mode, multiMounted, slots, parkForMultiview])

  // Dismounted grid / add-another: detach native tiles so shelves stay usable.
  const multiDocked =
    mode === 'multi' && slots.length >= 1 && (!multiMounted || awaitingAdd) &&
    !location.pathname.startsWith('/multiview')

  useEffect(() => {
    if (mode !== 'multi' || multiMounted) return
    void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
    if (isAndroidInAppBrowser()) void androidBrowserMultiHideAll({ blank: false })
  }, [mode, multiMounted])

  useEffect(() => {
    if (!multiDocked || !awaitingAdd) return
    void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
  }, [multiDocked, awaitingAdd])

  if (mode === 'off' || slots.length === 0) return null

  function forceSaveProgress() {
    window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))
  }

  async function exitFullscreenIfNeeded() {
    await exitOsFullscreen({ force: true })
  }

  async function leaveFullPlayer() {
    forceSaveProgress()
    await exitFullscreenIfNeeded()
    const dest = returnTo || '/'

    if (resumeItem && dest === '/guide') {
      leaveGuideWatch()
      navigate(dest, { replace: true })
      return
    }

    minimizeToPip()
    navigate(dest, { replace: true })
  }

  function goToMultiGrid() {
    cancelMultiviewAdd()
    mountMulti()
    navigate('/multiview', { replace: true })
  }

  // Dismounted: streams kept; browse the app until remount.
  if (mode === 'multi' && slots.length >= 1 && !multiMounted) {
    return (
      <div className="multiview-pick-bar" role="status">
        <strong>Multi-view</strong>
        <span>
          {slots.length}/4 parked
          {awaitingAdd ? ' · pick another live stream to add' : ' · streams kept'}
        </span>
        <button type="button" className="ghost-btn control-btn" onClick={goToMultiGrid}>
          Back to grid
        </button>
        {awaitingAdd ? (
          <button
            type="button"
            className="ghost-btn control-btn"
            onClick={() => cancelMultiviewAdd()}
          >
            Cancel add
          </button>
        ) : null}
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={() => {
            clearWebSurfaces({ blank: true })
            stop()
            navigate('/', { replace: true })
          }}
        >
          Close all
        </button>
      </div>
    )
  }

  // Keep MultiView for a single leftover tile too — remounting as /web kills playback.
  if (mode === 'multi' && slots.length >= 1 && multiMounted) {
    return (
      <MultiView
        slots={slots}
        primaryId={primaryId}
        onSpotlight={spotlight}
        onRemove={(id) => {
          void window.signalDesktop?.browserMultiHide?.({ id, destroy: true })
          if (isAndroidInAppBrowser()) void androidBrowserMultiHide({ id, destroy: true })
          removeSlot(id)
        }}
        onCloseAll={() => {
          clearWebSurfaces({ blank: true })
          void window.signalDesktop?.browserHide?.({ blank: true })
          if (isAndroidInAppBrowser()) void androidBrowserHide({ blank: true, pause: true })
          stop()
          navigate('/', { replace: true })
        }}
        onDismount={() => {
          void exitFullscreenIfNeeded().then(() => {
            dismountMulti()
            void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
            if (isAndroidInAppBrowser()) void androidBrowserMultiHideAll({ blank: false })
            navigate(returnTo || '/section/sports', { replace: true })
          })
        }}
        onMinimize={() => {
          forceSaveProgress()
          void exitFullscreenIfNeeded().then(() => {
            const primary = slots.find((s) => s.id === primaryId) || slots[0]
            clearWebSurfaces({ blank: true })
            if (primary && isWebEmbedPlaybackItem(primary)) {
              stop()
              openInPip(primary.url, primary.title, { navigateTo: '/' })
              return
            }
            minimizeToPip()
            navigate('/', { replace: true })
          })
        }}
      />
    )
  }

  if (!item) return null

  // Media3 and web embeds own their own surfaces — don't mount Capacitor HLS on them.
  if (isNativeMedia3PlaybackItem(item) || isWebEmbedPlaybackItem(item)) {
    return null
  }

  return (
    <Player
      item={item}
      layout={mode === 'pip' ? 'pip' : 'full'}
      onExpand={() => {
        expand()
        navigate(`/watch/${item.id}`)
      }}
      onClose={() => {
        if (mode === 'full' || mode === 'multi') {
          void leaveFullPlayer()
        } else {
          forceSaveProgress()
          void exitFullscreenIfNeeded().then(() => {
            clearWebSurfaces({ blank: true })
            stop()
          })
        }
      }}
    />
  )
}
