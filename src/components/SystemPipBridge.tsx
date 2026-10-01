import { useEffect, useRef } from 'react'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import {
  isAndroidSystemPipHost,
  onAndroidSystemPip,
  setAndroidHomePip,
} from '../lib/androidSystemPip'

/**
 * While a stream is playing, arm Android so the device Home button leaves a
 * system picture-in-picture window instead of pausing the video in the background.
 *
 * Must NOT arm for Home shelf previews / Local channel tiles — those are muted
 * autoplay <video>s and would open a splash PiP when the user isn't watching.
 */
export function SystemPipBridge() {
  const { mode: playbackMode } = usePlayback()
  const { mode: webMode } = useWebBrowser()
  const sessionRef = useRef({ playbackMode, webMode })
  sessionRef.current = { playbackMode, webMode }

  useEffect(() => {
    if (!isAndroidSystemPipHost()) return

    let lastKey = ''
    let replayKicks = 0

    const arm = () => {
      const { playbackMode: playMode, webMode: browserMode } = sessionRef.current
      const inNativeWatch =
        playMode === 'full' || playMode === 'pip' || playMode === 'multi'
      const inEmbedWatch = browserMode === 'page' || browserMode === 'pip'
      const sys = document.documentElement.classList.contains('is-system-pip')

      const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]
      const playing = inNativeWatch
        ? videos.find((video) => {
            if (!video.currentSrc || video.paused || video.ended) return false
            // Ignore card-preview / shelf autoplay outside the real player.
            return Boolean(
              video.closest(
                '.player-shell, .player-shell-pip, .player-shell-tile, .multiview-grid',
              ),
            )
          })
        : undefined

      const embed =
        inEmbedWatch &&
        document.querySelector(
          '.web-browser-page.is-embed-player.is-watching, .web-browser-pip',
        )

      if (sys) {
        for (const video of videos) {
          if (!video.currentSrc || video.ended || !video.paused) continue
          if (
            !video.closest(
              '.player-shell, .player-shell-pip, .player-shell-tile, .multiview-grid',
            )
          ) {
            continue
          }
          if (replayKicks > 4) break
          replayKicks += 1
          void video.play().catch(() => undefined)
        }
      } else {
        replayKicks = 0
      }

      const enabled = Boolean(playing || embed)
      const sample = playing || videos.find((video) => video.videoWidth > 0)
      const width = sample && sample.videoWidth > 0 ? sample.videoWidth : 16
      const height = sample && sample.videoHeight > 0 ? sample.videoHeight : 9
      const key = `${enabled}:${width}x${height}`
      if (key === lastKey) return
      lastKey = key
      void setAndroidHomePip({ enabled, width, height })
    }

    const onPause = (event: Event) => {
      if (!document.documentElement.classList.contains('is-system-pip')) return
      const video = event.target
      if (!(video instanceof HTMLVideoElement) || video.ended || !video.currentSrc) return
      if (
        !video.closest(
          '.player-shell, .player-shell-pip, .player-shell-tile, .multiview-grid',
        )
      ) {
        return
      }
      if (replayKicks > 4) return
      replayKicks += 1
      void video.play().catch(() => undefined)
    }

    arm()
    const timer = window.setInterval(arm, 1000)
    document.addEventListener('play', arm, true)
    document.addEventListener('pause', onPause, true)
    document.addEventListener('emptied', arm, true)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('play', arm, true)
      document.removeEventListener('pause', onPause, true)
      document.removeEventListener('emptied', arm, true)
      lastKey = ''
      void setAndroidHomePip({ enabled: false, width: 16, height: 9 })
    }
  }, [playbackMode, webMode])

  useEffect(() => {
    if (!isAndroidSystemPipHost()) return
    return onAndroidSystemPip((active) => {
      document.documentElement.classList.toggle('is-system-pip', active)
      const fire = () => window.dispatchEvent(new Event('resize'))
      window.requestAnimationFrame(() => {
        fire()
        window.requestAnimationFrame(fire)
      })
      window.setTimeout(fire, 80)
      window.setTimeout(fire, 280)
    })
  }, [])

  return null
}
