import { useEffect, useRef } from 'react'
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
import { isWebEmbedPlaybackItem } from '../lib/webBrowser'
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
    cancelMultiviewAdd,
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
  const wasMultiRef = useRef(false)

  // Hard-reset native web tiles whenever playback stops.
  useEffect(() => {
    if (mode !== 'off') return
    clearWebSurfaces({ blank: true })
    void handFullscreenToCurrentStream(null)
  }, [mode])

  // Stream selected — Full ownership follows the current title (not a leftover PiP).
  useEffect(() => {
    if (!item || mode === 'off') return
    if (isWebEmbedPlaybackItem(item)) {
      void handFullscreenToCurrentStream('web')
      return
    }
    // Native HLS (Movy/Atlantic) — never leave a leftover embed covering the stage
    // (atlantic.st Warp interstitial was showing over playing video + subs).
    void handFullscreenToCurrentStream('native')
    clearWebSurfaces({ blank: true })
    // Always close even if mode was already "off" — view can desync and stay visible.
    closeBrowser()
  }, [item?.id, mode, closeBrowser, item])

  // Entering multi-view: park the single-player browser so tiles own the embeds.
  useEffect(() => {
    if (mode !== 'multi' || slots.length < 2) return
    if (!slots.some((slot) => isWebEmbedPlaybackItem(slot))) return
    parkForMultiview()
  }, [mode, slots, parkForMultiview])

  // Leaving multi-view with one web embed → restore /web.
  useEffect(() => {
    if (mode === 'multi') {
      wasMultiRef.current = true
      return
    }
    if (!wasMultiRef.current) return
    wasMultiRef.current = false
    if (slots.length !== 1 || !item || !isWebEmbedPlaybackItem(item)) return
    clearWebSurfaces({ blank: true })
    navigate(`/web?url=${encodeURIComponent(item.url)}`, {
      replace: true,
      state: {
        from: returnTo || '/section/sports',
        playerMode: 'embed',
        pipOnBack: true,
        continueWatch: {
          id: item.id,
          title: item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex: 0,
          playUrl: item.url,
          transport: item.transport,
          sourceKind: item.sourceKind,
          source: item.source,
        },
      },
    })
  }, [mode, slots.length, item, navigate, returnTo])

  // Armed "Add stream": leave the grid so Sports / shelves are usable.
  // Keep slots in memory; MultiView remounts when picking finishes (/multiview).
  const pickingExtra =
    mode === 'multi' &&
    slots.length > 1 &&
    awaitingAdd &&
    !location.pathname.startsWith('/multiview')

  useEffect(() => {
    if (!pickingExtra) return
    void window.signalDesktop?.browserMultiHideAll?.({ blank: false })
  }, [pickingExtra])

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

  if (pickingExtra) {
    return (
      <div className="multiview-pick-bar" role="status">
        <strong>Multi-view</strong>
        <span>
          {slots.length}/4 · pick another live stream to add
        </span>
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={() => {
            cancelMultiviewAdd()
            navigate('/multiview', { replace: true })
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ghost-btn control-btn"
          onClick={() => {
            cancelMultiviewAdd()
            navigate('/multiview', { replace: true })
          }}
        >
          Back to grid
        </button>
      </div>
    )
  }

  if (slots.length > 1 && mode === 'multi') {
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

  // Single web embed is owned by /web (or web PiP) — don't mount the HLS player on it.
  if (isWebEmbedPlaybackItem(item)) {
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
