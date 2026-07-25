import { useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { MultiView } from './MultiView'
import { Player } from './Player'

export function GlobalPlayer() {
  const {
    item,
    slots,
    primaryId,
    mode,
    returnTo,
    resumeItem,
    minimizeToPip,
    expand,
    stop,
    spotlight,
    removeSlot,
    leaveGuideWatch,
  } = usePlayback()
  const navigate = useNavigate()

  if (mode === 'off' || slots.length === 0) return null

  function forceSaveProgress() {
    window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))
  }

  async function exitFullscreenIfNeeded() {
    if (!document.fullscreenElement) return
    try {
      await document.exitFullscreen()
    } catch {
      /* ignore */
    }
  }

  async function leaveFullPlayer() {
    forceSaveProgress()
    // Back from fullscreen must leave the Fullscreen API first — otherwise PiP
    // keeps :fullscreen CSS and becomes a tiny video in a black full-screen shell.
    await exitFullscreenIfNeeded()
    const dest = returnTo || '/'

    // Resume prior PiP only when returning to Guide — not after switching channels
    // in Sports / Movies / etc. (those should PiP the stream you just left).
    if (resumeItem && dest === '/guide') {
      leaveGuideWatch()
      navigate(dest, { replace: true })
      return
    }

    minimizeToPip()
    // Always leave /watch so the loading route cannot fight sidebar navigation.
    navigate(dest, { replace: true })
  }

  if (slots.length > 1 && mode === 'multi') {
    return (
      <MultiView
        slots={slots}
        primaryId={primaryId}
        onSpotlight={spotlight}
        onRemove={removeSlot}
        onCloseAll={stop}
        onMinimize={() => {
          forceSaveProgress()
          void exitFullscreenIfNeeded().then(() => {
            minimizeToPip()
            navigate('/', { replace: true })
          })
        }}
      />
    )
  }

  if (!item) return null

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
          void exitFullscreenIfNeeded().then(() => stop())
        }
      }}
    />
  )
}
