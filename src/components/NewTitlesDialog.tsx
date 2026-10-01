import { useEffect } from 'react'
import { CatalogGrid } from './CatalogGrid'
import { pushOverlayDismiss } from '../lib/overlayDismiss'
import type { StreamItem } from '../types'

interface NewTitlesDialogProps {
  title: string
  items: StreamItem[]
  emptyHint?: string
  onClose: () => void
}

export function NewTitlesDialog({ title, items, emptyHint, onClose }: NewTitlesDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const pop = pushOverlayDismiss(onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      pop()
    }
  }, [onClose])

  return (
    <div
      className="new-titles-backdrop"
      role="presentation"
      onClick={onClose}
      onPointerUp={(e) => {
        // Empty dimmed area closes; ignore presses that started on the sheet.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
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
            onClick={onClose}
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
