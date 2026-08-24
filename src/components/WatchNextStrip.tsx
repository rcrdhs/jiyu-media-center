import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  clearWatchNext,
  getWatchNext,
  subscribeWatchNext,
  type WatchNextEntry,
} from '../lib/watchNext'

/** Home “Up next” slot — one queued title, clearable. */
export function WatchNextStrip() {
  const [entry, setEntry] = useState<WatchNextEntry | null>(() => getWatchNext())

  useEffect(() => subscribeWatchNext(setEntry), [])

  if (!entry) return null

  return (
    <section className="section-block watch-next-strip" aria-label="Up next">
      <div className="section-head">
        <h2>Up next</h2>
        <p>Plays after your current title finishes · one slot</p>
      </div>
      <div className="watch-next-card">
        <Link to={entry.href} className="watch-next-link" title={`Play ${entry.title}`}>
          <div className="watch-next-art" aria-hidden={!entry.poster}>
            {entry.poster ? (
              <img src={entry.poster} alt="" loading="lazy" />
            ) : (
              <span>{entry.title.slice(0, 1)}</span>
            )}
          </div>
          <div className="watch-next-body">
            <strong>{entry.title}</strong>
            <span>Queued</span>
          </div>
        </Link>
        <button
          type="button"
          className="ghost-btn watch-next-clear"
          onClick={() => clearWatchNext()}
          title="Clear up next"
        >
          Clear
        </button>
      </div>
    </section>
  )
}
