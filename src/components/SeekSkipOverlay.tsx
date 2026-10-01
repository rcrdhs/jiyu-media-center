interface SeekSkipOverlayProps {
  visible: boolean
  onBack: () => void
  onForward: () => void
}

/** Hover ±10s undo/redo controls over the playback stage. */
export function SeekSkipOverlay({ visible, onBack, onForward }: SeekSkipOverlayProps) {
  return (
    <div
      className={`seek-skip-overlay${visible ? ' is-visible' : ''}`}
      aria-hidden={!visible}
    >
      <button
        type="button"
        className="seek-skip-btn"
        aria-label="Rewind 10 seconds"
        title="−10s"
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onBack()
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9.5 7.5H5.5V3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.7 7.6A8 8 0 1 1 5 12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        <span className="seek-skip-badge">10</span>
      </button>
      <button
        type="button"
        className="seek-skip-btn"
        aria-label="Forward 10 seconds"
        title="+10s"
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onForward()
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14.5 7.5H18.5V3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M18.3 7.6A8 8 0 1 0 19 12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        <span className="seek-skip-badge">10</span>
      </button>
    </div>
  )
}
