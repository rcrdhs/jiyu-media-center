import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { exitOsFullscreen, handFullscreenToCurrentStream } from '../lib/fullscreenSession'
import {
  androidBrowserHide,
  androidBrowserMultiHide,
  androidBrowserMultiHideAll,
  androidBrowserMultiPromote,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  isNativeMedia3PlaybackItem,
  isWebEmbedPlaybackItem,
  toAutoplayUrl,
} from '../lib/webBrowser'
import { notePromotedEmbed } from '../lib/multiviewCollapse'
import type { StreamItem } from '../types'
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
  // Multi-view collapsed to this native stream: keep rendering it through MultiView's
  // tree (solo) so the same <video>/hls.js instance continues instead of restarting.
  const [soloId, setSoloId] = useState<string | null>(null)

  useEffect(() => {
    if (!soloId) return
    if (mode === 'off' || mode === 'multi' || item?.id !== soloId) setSoloId(null)
  }, [soloId, mode, item?.id])

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

  /** Closing tiles left one stream: leave Multi-view and continue it as the normal player. */
  function collapseMultiviewTo(survivor: StreamItem) {
    if (isWebEmbedPlaybackItem(survivor)) {
      // Hand the live tile to the single browser view (no reload), then show /web.
      const tileUrl = toAutoplayUrl(survivor.url)
      const urls = [tileUrl, survivor.url]
      notePromotedEmbed(urls)
      if (isAndroidInAppBrowser()) {
        void androidBrowserMultiPromote({ id: survivor.id, url: tileUrl })
      } else {
        void window.signalDesktop?.browserMultiPromote?.({ id: survivor.id, url: tileUrl, urls })
      }
      navigate(`/web?url=${encodeURIComponent(survivor.url)}`, {
        replace: true,
        state: {
          from: returnTo || '/section/sports',
          playerMode: 'embed',
          pipOnBack: true,
          continueWatch: {
            id: survivor.id,
            title: survivor.title,
            poster: survivor.poster,
            category: survivor.category,
            playlistIndex: 0,
            detailUrl: survivor.detailUrl || survivor.url,
            playUrl: survivor.url,
            transport: survivor.transport,
            sourceKind: survivor.sourceKind,
            source: survivor.source,
          },
        },
      })
      return
    }
    setSoloId(survivor.id)
    navigate(`/watch/${survivor.id}`, { replace: true, state: { from: returnTo || '/' } })
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

  // Multi-view grid (a lone tile only while docked / still adding). Closing tiles down
  // to one stream collapses to the normal player via collapseMultiviewTo().
  if (mode === 'multi' && slots.length >= 1 && multiMounted) {
    return (
      <MultiView
        slots={slots}
        primaryId={primaryId}
        onSpotlight={spotlight}
        onRemove={(id) => {
          const remaining = slots.filter((slot) => slot.id !== id)
          void window.signalDesktop?.browserMultiHide?.({ id, destroy: true })
          if (isAndroidInAppBrowser()) void androidBrowserMultiHide({ id, destroy: true })
          if (remaining.length === 1) collapseMultiviewTo(remaining[0])
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

  const current = item
  const layout = mode === 'pip' ? 'pip' : 'full'
  const onExpand = () => {
    expand()
    navigate(`/watch/${current.id}`)
  }
  const onClose = () => {
    if (mode === 'full' || mode === 'multi') {
      void leaveFullPlayer()
    } else {
      forceSaveProgress()
      void exitFullscreenIfNeeded().then(() => {
        clearWebSurfaces({ blank: true })
        stop()
      })
    }
  }

  // Survivor of a collapsed Multi-view: same tree position as its tile = no restart.
  if (soloId && current.id === soloId && slots.length === 1 && slots[0].id === soloId) {
    return (
      <MultiView
        slots={slots}
        primaryId={current.id}
        onSpotlight={spotlight}
        onRemove={() => {}}
        onCloseAll={() => {}}
        solo={{ layout, onExpand, onClose }}
      />
    )
  }

  return <Player item={current} layout={layout} onExpand={onExpand} onClose={onClose} />
}
