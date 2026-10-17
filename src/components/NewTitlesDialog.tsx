import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { CatalogGrid } from './CatalogGrid'
import { pushOverlayDismiss } from '../lib/overlayDismiss'
import { clearOverlayView, getOverlayView, setOverlayView } from '../lib/viewState'
import type { StreamItem } from '../types'

interface NewTitlesDialogProps {
  title: string
  items: StreamItem[]
  emptyHint?: string
  onClose: () => void
  /**
   * Remembers the sheet's scroll spot (and last opened card) under this key so
   * Back from a title reopens it in the same place. Cleared on explicit close.
   */
  restoreKey?: string
}

/** Give late layout (catalog hydrate, posters) this long to reach the saved spot. */
const RESTORE_WINDOW_MS = 2500

export function NewTitlesDialog({
  title,
  items,
  emptyHint,
  onClose,
  restoreKey,
}: NewTitlesDialogProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const viewKey = restoreKey ? `overlay:${restoreKey}` : ''
  // Stops restore retries once the user scrolls on their own.
  const userScrolledRef = useRef(false)
  // While a restore is pending, programmatic scrolls must not overwrite the spot.
  const restoringRef = useRef(false)

  // Explicit dismiss (Close, backdrop, Escape, Android Back) forgets the spot;
  // unmounting because a title was opened keeps it.
  const dismiss = useCallback(() => {
    if (viewKey) clearOverlayView(viewKey)
    onClose()
  }, [onClose, viewKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    const pop = pushOverlayDismiss(dismiss)
    return () => {
      window.removeEventListener('keydown', onKey)
      pop()
    }
  }, [dismiss])

  useEffect(() => {
    const el = sheetRef.current
    if (!el || !viewKey) return
    let frame = 0
    const onScroll = () => {
      if (restoringRef.current && !userScrolledRef.current) return
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setOverlayView(viewKey, { scrollTop: el.scrollTop })
      })
    }
    const onUser = () => {
      userScrolledRef.current = true
    }
    const onOpenCard = (e: Event) => {
      const card = (e.target as HTMLElement | null)?.closest?.('[data-item-id]')
      const id = card?.getAttribute('data-item-id')
      if (id) setOverlayView(viewKey, { scrollTop: el.scrollTop, focusItemId: id })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onUser, { passive: true })
    el.addEventListener('touchstart', onUser, { passive: true })
    el.addEventListener('keydown', onUser)
    el.addEventListener('click', onOpenCard, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onUser)
      el.removeEventListener('touchstart', onUser)
      el.removeEventListener('keydown', onUser)
      el.removeEventListener('click', onOpenCard, true)
    }
  }, [viewKey])

  // Restore after mount and whenever the list grows (items hydrate late on a
  // cold start / Android resume), until the saved spot is reachable.
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el || !viewKey || userScrolledRef.current) return
    const saved = getOverlayView(viewKey)
    if (!saved || (saved.scrollTop <= 0 && !saved.focusItemId)) return
    const started = performance.now()
    let raf = 0
    let done = false
    restoringRef.current = true
    const attempt = () => {
      if (done) return
      if (userScrolledRef.current) {
        restoringRef.current = false
        return
      }
      const maxTop = el.scrollHeight - el.clientHeight
      const reachable = maxTop >= saved.scrollTop - 2
      if (reachable) {
        el.scrollTop = saved.scrollTop
      } else if (saved.focusItemId) {
        const card = el.querySelector(`[data-item-id="${CSS.escape(saved.focusItemId)}"]`)
        if (card) card.scrollIntoView({ block: 'center' })
        else el.scrollTop = maxTop
      } else {
        el.scrollTop = maxTop
      }
      if (reachable) {
        done = true
        // Let the async scroll event from this assignment land first.
        requestAnimationFrame(() => {
          restoringRef.current = false
        })
        return
      }
      if (performance.now() - started < RESTORE_WINDOW_MS) raf = requestAnimationFrame(attempt)
      else restoringRef.current = false
    }
    attempt()
    return () => {
      done = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [viewKey, items.length])

  return (
    <div
      className="new-titles-backdrop"
      role="presentation"
      onClick={dismiss}
      onPointerUp={(e) => {
        // Empty dimmed area closes; ignore presses that started on the sheet.
        if (e.target === e.currentTarget) dismiss()
      }}
    >
      <div
        ref={sheetRef}
        className="new-titles-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-titles-title"
        onClick={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <header className="new-titles-head">
          <div className="new-titles-head-copy">
            <h2 id="new-titles-title">{title}</h2>
            <p>
              {items.length.toLocaleString()} title{items.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            className="ghost-btn control-btn new-titles-close"
            onClick={dismiss}
          >
            Close
          </button>
        </header>
        <CatalogGrid
          items={items}
          showToolbar={false}
          autoCheck={false}
          showHealthFilters={false}
          emptyHint={
            emptyHint ||
            'No tracked titles yet — open this shelf again after the next catalog sync.'
          }
        />
      </div>
    </div>
  )
}
