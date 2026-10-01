import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Hls from 'hls.js'
import type { StreamItem } from '../types'
import { isYouTubeUrl } from '../lib/webBrowser'
import { resolveYouTubeLivePlay } from '../lib/youtubeLive'
import { isVimeoLiveEventUrl, resolveVimeoLiveHls } from '../lib/vimeoLive'
import { androidHlsConfig } from '../lib/hlsAndroid'

interface LocalChannelLiveProps {
  item: StreamItem
}

export function LocalChannelLive({ item }: LocalChannelLiveProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [youtubeLive, setYoutubeLive] = useState<boolean | null>(null)
  const [youtubePreview, setYoutubePreview] = useState('')
  const [youtubePoster, setYoutubePoster] = useState('')
  const [youtubeEmbedReady, setYoutubeEmbedReady] = useState(false)
  const youtube = isYouTubeUrl(item.url)

  useEffect(() => {
    if (!youtube) {
      setYoutubeLive(null)
      setYoutubePreview('')
      setYoutubePoster('')
      setYoutubeEmbedReady(false)
      return
    }
    let cancelled = false
    setYoutubeLive(null)
    setYoutubePreview('')
    setYoutubePoster('')
    setYoutubeEmbedReady(false)
    void resolveYouTubeLivePlay(item.url).then((resolved) => {
      if (cancelled) return
      if (!resolved.ok) {
        setYoutubeLive(false)
        setYoutubePreview('')
        setYoutubePoster('')
        return
      }
      setYoutubeLive(true)
      setYoutubePreview(resolved.previewUrl)
      // Live thumb always available even if the muted embed is slow/blocked.
      setYoutubePoster(
        resolved.posterUrl ||
          (resolved.videoId
            ? `https://i.ytimg.com/vi/${resolved.videoId}/hqdefault.jpg`
            : ''),
      )
    })
    return () => {
      cancelled = true
    }
  }, [item.url, youtube])

  useEffect(() => {
    if (youtube) return
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    setPlaying(false)
    setFailed(false)
    setConnecting(true)

    const fail = () => {
      if (!cancelled) {
        setFailed(true)
        setPlaying(false)
        setConnecting(false)
      }
    }

    const onPlaying = () => {
      if (!cancelled) {
        setPlaying(true)
        setFailed(false)
        setConnecting(false)
      }
    }

    video.addEventListener('playing', onPlaying)

    const destroyHls = () => {
      hlsRef.current?.destroy()
      hlsRef.current = null
    }

    const attach = (sourceUrl: string) => {
      if (cancelled) return
      destroyHls()

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 20,
          fragLoadingMaxRetry: 4,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          xhrSetup(xhr) {
            xhr.withCredentials = false
          },
          ...androidHlsConfig({ lowLatencyMode: false }),
        })
        hlsRef.current = hls
        hls.loadSource(sourceUrl)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(fail)
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) fail()
        })
        return
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = sourceUrl
        void video.play().catch(fail)
        return
      }
      fail()
    }

    if (isVimeoLiveEventUrl(item.url)) {
      void resolveVimeoLiveHls(item.url).then((resolved) => {
        if (cancelled) return
        if (!resolved.ok) {
          fail()
          return
        }
        attach(resolved.url)
      })
    } else {
      attach(item.url)
    }

    return () => {
      cancelled = true
      video.removeEventListener('playing', onPlaying)
      destroyHls()
      video.removeAttribute('src')
      video.load()
    }
  }, [item.url, youtube])

  const offline = youtube ? youtubeLive === false : failed
  const liveLabel = youtube
    ? youtubeLive === null
      ? 'Checking…'
      : offline
        ? 'Offline'
        : 'Live'
    : connecting
      ? 'Connecting…'
      : offline
        ? 'Offline'
        : 'Live'
  const detail = youtube
    ? offline
      ? 'Not on-air on YouTube right now — open Watch when they go live.'
      : 'Live on YouTube — Watch opens the full player (PiP on Back).'
    : failed
      ? 'Preview unavailable — open Watch to try the full player.'
      : connecting
        ? 'Connecting to live stream…'
        : item.description
  const showYoutubeEmbed = Boolean(youtube && youtubePreview && youtubeLive)
  const showYoutubeThumb = Boolean(youtube && youtubeLive && youtubePoster && !youtubeEmbedReady)

  return (
    <div className="local-channel-live">
      <Link
        to={`/watch/${item.id}`}
        state={{ from: '/' }}
        className="local-channel-live-stage"
        title={`Watch ${item.title}`}
      >
        {(showYoutubeThumb || (!youtube && item.poster) || (youtube && !youtubeLive && item.poster)) && (
          <img
            className={`local-channel-live-poster ${
              (playing && !youtube) || (showYoutubeEmbed && youtubeEmbedReady) ? 'is-hidden' : ''
            }`}
            src={youtubePoster || item.poster}
            alt=""
            aria-hidden
          />
        )}
        {!youtube && (
          <video
            ref={videoRef}
            className={`local-channel-live-video ${playing ? 'is-visible' : ''}`}
            muted
            playsInline
            autoPlay
          />
        )}
        {showYoutubeEmbed && (
          <iframe
            className={`local-channel-live-video ${youtubeEmbedReady ? 'is-visible' : ''}`}
            src={youtubePreview}
            title={`${item.title} live preview`}
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            tabIndex={-1}
            onLoad={() => {
              // Give the muted player a moment to paint before hiding the live thumb.
              window.setTimeout(() => setYoutubeEmbedReady(true), 700)
            }}
          />
        )}
        <span
          className={`local-channel-live-badge ${offline ? 'is-offline' : ''} ${connecting && !youtube ? 'is-connecting' : ''}`}
        >
          {liveLabel}
        </span>
      </Link>
      <div className="local-channel-live-meta">
        <div>
          <h3>{item.title}</h3>
          <p>{detail}</p>
        </div>
        <Link className="primary-btn" to={`/watch/${item.id}`} state={{ from: '/' }}>
          Watch
        </Link>
      </div>
    </div>
  )
}
