import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'

/** Ensures multi-view is expanded when visiting /multiview */
export function MultiviewPage() {
  const navigate = useNavigate()
  const { slots, mode, expand, awaitingAdd, armMultiviewAdd, cancelMultiviewAdd, item } =
    usePlayback()

  useEffect(() => {
    if (slots.length > 1 && mode === 'pip') expand()
  }, [slots.length, mode, expand])

  if (slots.length < 2) {
    return (
      <div className="page">
        <header className="page-header">
          <p className="eyebrow">Watch together</p>
          <h1>Multi-view</h1>
          <p className="lede">
            Multi-view is opt-in. Start a stream, press <strong>Multi-view</strong> on the player,
            then open another channel to watch both.
          </p>
        </header>
        <div className="empty-state">
          {item ? (
            <>
              <p>
                Playing <strong>{item.title}</strong>.
                {awaitingAdd
                  ? ' Open another channel to add it to the grid.'
                  : ' Arm multi-view, then pick a second stream.'}
              </p>
              <div className="hero-actions">
                {awaitingAdd ? (
                  <button type="button" className="ghost-btn" onClick={cancelMultiviewAdd}>
                    Cancel add
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => {
                      armMultiviewAdd()
                      navigate('/')
                    }}
                  >
                    Add next channel
                  </button>
                )}
                <Link className="ghost-btn" to="/">
                  Browse home
                </Link>
              </div>
            </>
          ) : (
            <>
              <p>No stream playing yet. Open a channel first, then choose Multi-view on the player.</p>
              <Link className="primary-btn" to="/">
                Browse home
              </Link>
            </>
          )}
        </div>
      </div>
    )
  }

  return <div className="watch-placeholder" aria-hidden />
}
