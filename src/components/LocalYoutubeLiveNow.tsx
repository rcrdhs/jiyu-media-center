import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LOCAL_YOUTUBE_LIVE_TARGETS,
  probeLocalYoutubeLive,
  type LocalYoutubeLiveTarget,
} from '../lib/youtubeLive'

/** CVM / Nationwide cards under Local — only when YouTube reports them live */
export function LocalYoutubeLiveNow() {
  const navigate = useNavigate()
  const [live, setLive] = useState<LocalYoutubeLiveTarget[]>([])
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    setChecking(true)
    void probeLocalYoutubeLive(LOCAL_YOUTUBE_LIVE_TARGETS).then((rows) => {
      if (!cancelled) {
        setLive(rows)
        setChecking(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (checking) {
    return <p className="fine-print local-youtube-status">Checking CVM &amp; Nationwide live status…</p>
  }

  if (live.length === 0) return null

  return (
    <div className="local-youtube-live">
      <div className="local-youtube-live-head">
        <h3>Live on YouTube</h3>
        <p>On-air now — opens in the Web browser tile.</p>
      </div>
      <div className="local-youtube-live-grid">
        {live.map((target) => (
          <button
            key={target.id}
            type="button"
            className="local-youtube-live-card"
            onClick={() => navigate(`/web?url=${encodeURIComponent(target.url)}`)}
          >
            <span className="local-youtube-live-badge">Live</span>
            <strong>{target.label}</strong>
            <span>{target.detail}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
