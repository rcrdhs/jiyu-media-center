import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Hls from 'hls.js'
import type { StreamItem } from '../types'

interface LocalChannelLiveProps {
  item: StreamItem
}

export function LocalChannelLive({ item }: LocalChannelLiveProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let hls: Hls | null = null
    setPlaying(false)
    setFailed(false)

    const fail = () => {
      if (!cancelled) {
        setFailed(true)
        setPlaying(false)
      }
    }

    const onPlaying = () => {
      if (!cancelled) {
        setPlaying(true)
        setFailed(false)
      }
    }

    video.addEventListener('playing', onPlaying)

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 20,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 2,
      })
      hls.loadSource(item.url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(fail)
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) fail()
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const onError = () => fail()
      video.addEventListener('error', onError)
      video.src = item.url
      void video.play().catch(fail)
      return () => {
        cancelled = true
        video.removeEventListener('playing', onPlaying)
        video.removeEventListener('error', onError)
        video.removeAttribute('src')
        video.load()
      }
    } else {
      fail()
    }

    return () => {
      cancelled = true
      video.removeEventListener('playing', onPlaying)
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [item.url])

  return (
    <div className="local-channel-live">
      <Link to={`/watch/${item.id}`} className="local-channel-live-stage" title={`Watch ${item.title}`}>
        {item.poster && (
          <img
            className={`local-channel-live-poster ${playing ? 'is-hidden' : ''}`}
            src={item.poster}
            alt=""
            aria-hidden
          />
        )}
        <video
          ref={videoRef}
          className={`local-channel-live-video ${playing ? 'is-visible' : ''}`}
          muted
          playsInline
          autoPlay
        />
        <span className={`local-channel-live-badge ${failed ? 'is-offline' : ''}`}>
          {failed ? 'Offline' : 'Live'}
        </span>
      </Link>
      <div className="local-channel-live-meta">
        <div>
          <h3>{item.title}</h3>
          <p>{failed ? 'Preview unavailable — open Watch to try the full player.' : item.description}</p>
        </div>
        <Link className="primary-btn" to={`/watch/${item.id}`}>
          Watch
        </Link>
      </div>
    </div>
  )
}
