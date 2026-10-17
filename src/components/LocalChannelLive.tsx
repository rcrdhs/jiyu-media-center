import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import Hls from 'hls.js'
import type { StreamItem } from '../types'
import { isYouTubeUrl } from '../lib/webBrowser'
import { resolveYouTubeLivePlay } from '../lib/youtubeLive'
import { isVimeoLiveEventUrl, resolveVimeoLiveHls } from '../lib/vimeoLive'
import { androidHlsConfig } from '../lib/hlsAndroid'
import { getPerformanceKnobs } from '../lib/deviceProfile'
import {
  claimLocalChannelAudio,
  subscribeLocalChannelAudio,
} from '../lib/localChannelAudio'

interface LocalChannelLiveProps {
  item: StreamItem
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden width="18" height="18">
        <path
          fill="currentColor"
          d="M4.5 9.5v5h3.2L13 19.2V4.8L7.7 9.5H4.5zm11.1 1.1 1.4-1.4 1.4 1.4 1.4-1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.4-1.4z"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden width="18" height="18">
      <path
        fill="currentColor"
        d="M4.5 9.5v5h3.2L13 19.2V4.8L7.7 9.5H4.5zm10.7 1.1a3.2 3.2 0 0 1 0 2.8l-1.2-.7a1.8 1.8 0 0 0 0-1.4l1.2-.7zm1.9-2.3a6 6 0 0 1 0 6.9l-1.2-.8a4.5 4.5 0 0 0 0-5.3l1.2-.8z"
      />
    </svg>
  )
}

function postYoutube(iframe: HTMLIFrameElement | null, payload: unknown) {
  if (!iframe?.contentWindow) return
  const raw = JSON.stringify(payload)
  try {
    iframe.contentWindow.postMessage(raw, '*')
  } catch {
    /* ignore */
  }
}

/** Widget API ignores commands until the parent sends listening. */
function armYoutubeApi(iframe: HTMLIFrameElement | null) {
  postYoutube(iframe, {
    event: 'listening',
    id: iframe?.id || 'local-yt',
    channel: 'widget',
  })
}

function postYoutubeCommand(
  iframe: HTMLIFrameElement | null,
  func: 'mute' | 'unMute' | 'setVolume',
  args: unknown[] = [],
) {
  armYoutubeApi(iframe)
  postYoutube(iframe, { event: 'command', func, args })
}

/** mute=1 in the embed URL sticks; a user click must reload with mute=0 to get sound. */
function applyYoutubeMuteParam(iframe: HTMLIFrameElement | null, muted: boolean) {
  if (!iframe?.src) return
  try {
    const url = new URL(iframe.src)
    const want = muted ? '1' : '0'
    if (url.searchParams.get('mute') === want) return
    url.searchParams.set('mute', want)
    url.searchParams.set('autoplay', '1')
    url.searchParams.set('enablejsapi', '1')
    iframe.src = url.toString()
  } catch {
    /* ignore */
  }
}

export function LocalChannelLive({ item }: LocalChannelLiveProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const youtubeRef = useRef<HTMLIFrameElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [youtubeLive, setYoutubeLive] = useState<boolean | null>(null)
  const [youtubePreview, setYoutubePreview] = useState('')
  const [youtubePoster, setYoutubePoster] = useState('')
  const [youtubeEmbedReady, setYoutubeEmbedReady] = useState(false)
  const [muted, setMuted] = useState(true)
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
    setMuted(true)
    video.muted = true

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
        const perf = getPerformanceKnobs()
        const hls = new Hls({
          enableWorker: perf.enableMediaWorkers,
          // Local / live shelf previews — same anti-stall knobs as sports IPTV.
          lowLatencyMode: perf.liveHlsLowLatency,
          maxBufferLength: Math.max(perf.liveHlsMaxBufferLength, 36),
          maxMaxBufferLength: Math.max(perf.liveHlsMaxBufferLength + 24, 72),
          liveSyncDurationCount: perf.liveHlsSyncSegments,
          liveMaxLatencyDurationCount: Math.max(perf.liveHlsSyncSegments + 4, 10),
          fragLoadingTimeOut: 20_000,
          fragLoadingMaxRetry: 8,
          manifestLoadingMaxRetry: 6,
          levelLoadingMaxRetry: 6,
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

  // Another local channel took audio — mute this one.
  useEffect(() => {
    return subscribeLocalChannelAudio((activeId) => {
      if (activeId === item.id) return
      setMuted(true)
      if (videoRef.current) videoRef.current.muted = true
      postYoutubeCommand(youtubeRef.current, 'mute')
    })
  }, [item.id])

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted
    const iframe = youtubeRef.current
    if (!iframe) return
    postYoutubeCommand(iframe, muted ? 'mute' : 'unMute')
    postYoutubeCommand(iframe, 'setVolume', [muted ? 0 : 100])
    if (youtubeEmbedReady) applyYoutubeMuteParam(iframe, muted)
  }, [muted, youtubeEmbedReady])

  function toggleAudio(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const next = !muted
    if (!next) {
      claimLocalChannelAudio(item.id)
      const video = videoRef.current
      if (video) {
        video.muted = false
        void video.play().catch(() => {
          video.muted = true
          setMuted(true)
        })
      }
      const iframe = youtubeRef.current
      postYoutubeCommand(iframe, 'unMute')
      postYoutubeCommand(iframe, 'setVolume', [100])
      applyYoutubeMuteParam(iframe, false)
      setMuted(false)
      return
    }
    if (videoRef.current) videoRef.current.muted = true
    const iframe = youtubeRef.current
    postYoutubeCommand(iframe, 'mute')
    applyYoutubeMuteParam(iframe, true)
    setMuted(true)
  }

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
  const audioReady = (!youtube && playing) || (showYoutubeEmbed && youtubeEmbedReady)

  return (
    <div className="local-channel-live">
      <div className="local-channel-live-stage">
        <Link
          to={`/watch/${item.id}`}
          state={{ from: '/' }}
          className="local-channel-live-hit"
          title={`Watch ${item.title}`}
        >
          {(showYoutubeThumb ||
            (!youtube && item.poster) ||
            (youtube && !youtubeLive && item.poster)) && (
            <img
              className={`local-channel-live-poster ${
                (playing && !youtube) || (showYoutubeEmbed && youtubeEmbedReady)
                  ? 'is-hidden'
                  : ''
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
              ref={youtubeRef}
              id={`yt-${item.id}`}
              className={`local-channel-live-video ${youtubeEmbedReady ? 'is-visible' : ''}`}
              src={youtubePreview}
              title={`${item.title} live preview`}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              tabIndex={-1}
              onLoad={() => {
                armYoutubeApi(youtubeRef.current)
                // Give the muted player a moment to paint before hiding the live thumb.
                window.setTimeout(() => setYoutubeEmbedReady(true), 700)
              }}
            />
          )}
        </Link>
        <span
          className={`local-channel-live-badge ${offline ? 'is-offline' : ''} ${connecting && !youtube ? 'is-connecting' : ''}`}
        >
          {liveLabel}
        </span>
        {audioReady ? (
          <button
            type="button"
            className={`local-channel-audio-btn${muted ? ' is-muted' : ''}`}
            aria-label={muted ? `Unmute ${item.title}` : `Mute ${item.title}`}
            title={muted ? 'Unmute' : 'Mute'}
            onClick={toggleAudio}
          >
            <SpeakerIcon muted={muted} />
          </button>
        ) : null}
      </div>
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
