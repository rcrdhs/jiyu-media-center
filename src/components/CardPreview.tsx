import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

interface CardPreviewProps {
  url: string
  /** Called when the preview ends (5s elapsed or stream failed) */
  onEnd: () => void
  durationMs?: number
}

/** Lightweight muted live preview shown inside a media card on hover */
export function CardPreview({ url, onEnd, durationMs = 5000 }: CardPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let hls: Hls | null = null
    let stopTimer: number | null = null

    const end = () => {
      if (!cancelled) onEnd()
    }

    const onPlaying = () => {
      if (cancelled) return
      setVisible(true)
      // Count the 5 seconds from when frames actually appear
      if (stopTimer == null) stopTimer = window.setTimeout(end, durationMs)
    }

    video.addEventListener('playing', onPlaying)

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 10,
        capLevelToPlayerSize: true,
        fragLoadingMaxRetry: 1,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 1,
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(end)
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) end()
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener('error', end)
      video.src = url
      void video.play().catch(end)
    } else {
      end()
    }

    return () => {
      cancelled = true
      if (stopTimer != null) window.clearTimeout(stopTimer)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', end)
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [url, onEnd, durationMs])

  return (
    <video
      ref={videoRef}
      className={`card-preview-video ${visible ? 'is-visible' : ''}`}
      muted
      playsInline
      autoPlay
      aria-hidden
    />
  )
}
