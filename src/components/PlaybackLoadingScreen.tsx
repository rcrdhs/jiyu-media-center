interface PlaybackLoadingScreenProps {
  title: string
  status?: string
  /** Full-viewport fixed overlay (show page) vs stage-fill (player). */
  variant?: 'page' | 'stage'
}

/** Shared “getting the episode ready” surface — logo top-center, loader mid-screen. */
export function PlaybackLoadingScreen({
  title,
  status = 'Getting episode ready…',
  variant = 'page',
}: PlaybackLoadingScreenProps) {
  const heading = title.trim() || 'Loading…'

  return (
    <div
      className={`playback-loading playback-loading-${variant}`}
      role="status"
      aria-live="polite"
      aria-busy
      aria-label={`${heading}. ${status}`}
    >
      <img
        className="playback-loading-logo"
        src="./jiyu-logo.png"
        alt=""
        width={96}
        height={96}
        aria-hidden
      />
      <div className="playback-loading-center">
        <p className="playback-loading-title">{heading}</p>
        <p className="playback-loading-status">{status}</p>
        <div className="watch-loading-line" role="progressbar" aria-hidden>
          <span />
        </div>
      </div>
    </div>
  )
}
