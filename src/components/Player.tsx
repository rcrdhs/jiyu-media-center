import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import { isHlsUrl, isMpegTsUrl } from '../lib/iptv'
import {
  formatClock,
  getContinueEntry,
  isEpisodeComplete,
  isVodCategory,
  removeContinueEntry,
  upsertContinueEntry,
  FORCE_SAVE_CONTINUE_EVENT,
} from '../lib/continueWatching'
import {
  activeSkipInterval,
  resolveAnimeSkipIntervals,
  shouldAutoSkipOpening,
  skipButtonLabel,
  type AnimeSkipInterval,
} from '../lib/animeSkip'
import { activeSubtitleText, parseSubtitleCues, type SubtitleCue } from '../lib/subtitles'
import { getViewingQuality, viewingQualityLabel } from '../lib/viewingQuality'
import type { StreamItem, StreamPlaylistItem } from '../types'

/** Remux pipe (`/stream.mp4`) is not byte-seekable — resume via ffmpeg `-ss` query. */
function withResumeOffset(
  url: string,
  seconds: number,
  options?: { exact?: boolean },
): string {
  if (!url || !Number.isFinite(seconds) || seconds < 5) return url
  try {
    const parsed = new URL(url)
    if (/\/stream\.mp4$/i.test(parsed.pathname) || parsed.searchParams.has('source')) {
      parsed.searchParams.set('t', String(Math.floor(seconds)))
      if (options?.exact) parsed.searchParams.set('exact', '1')
      else parsed.searchParams.delete('exact')
      return parsed.toString()
    }
  } catch {
    /* keep going */
  }
  const base = url.replace(/#.*$/, '')
  return `${base}#t=${Math.floor(seconds)}`
}

/** Drop remux/hash resume offsets so playback opens at the true start. */
function stripResumeOffset(url: string): string {
  if (!url) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('t')
    parsed.searchParams.delete('exact')
    return parsed.toString()
  } catch {
    return url.replace(/([?&])t=\d+(&|$)/, '$1').replace(/[?&]$/, '').replace(/#t=\d+\b/, '')
  }
}

function isTimeBuffered(video: HTMLVideoElement, time: number): boolean {
  if (!Number.isFinite(time) || time < 0) return false
  try {
    const { buffered } = video
    for (let i = 0; i < buffered.length; i += 1) {
      if (time >= buffered.start(i) && time <= buffered.end(i) - 0.35) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function isRemuxPlaybackUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return /\/stream\.mp4$/i.test(parsed.pathname) || parsed.searchParams.has('source')
  } catch {
    return false
  }
}

/** WebTorrent / remux URLs die as soon as torrentStop() removes the swarm. */
function isEphemeralLocalStreamUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch {
    return false
  }
}

interface PlayerProps {
  item: StreamItem
  onClose: () => void
  onExpand?: () => void
  onSpotlight?: () => void
  layout?: 'full' | 'pip' | 'tile'
  /** When false in multi-view, force mute (spotlight owns audio) */
  isPrimary?: boolean
}

type Engine = 'hls' | 'ts' | 'native'

const VOLUME_KEY = 'jiyu.player.volume'
const MUTE_KEY = 'jiyu.player.muted'
const CHROME_IDLE_MS = 2800
function pickEngines(url: string): Engine[] {
  const engines: Engine[] = []
  const hls = isHlsUrl(url)
  const ts = isMpegTsUrl(url)

  // Local torrent streams (webtorrent HTTP server) are plain progressive video
  if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(url) && !hls && !ts) {
    return ['native']
  }

  if (hls) engines.push('hls')
  if (ts) engines.push('ts')
  if (!hls && !ts) {
    engines.push('hls', 'ts')
  }
  engines.push('native')
  return [...new Set(engines)]
}

function describeHlsError(data: { type?: string }): string {
  if (data.type === 'networkError' || data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    return 'Network error — stream offline, blocked, or refused the connection.'
  }
  if (data.type === 'mediaError' || data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    return 'Media error — this channel may use an unsupported or protected format.'
  }
  return 'Could not load this HLS / IPTV stream.'
}

function loadSavedVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw == null) return 1
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
  } catch {
    return 1
  }
}

function loadSavedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function Player({
  item,
  onClose,
  onExpand,
  onSpotlight,
  layout = 'full',
  isPrimary = true,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('Connecting…')
  const [engineLabel, setEngineLabel] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(loadSavedMuted)
  const [volume, setVolume] = useState(loadSavedVolume)
  const [hint, setHint] = useState<string | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [playlistIndex, setPlaylistIndex] = useState(0)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const playlistOpenRef = useRef(false)
  /** Local copy so we can fill in torrent URLs as episodes are resolved. */
  const [localPlaylist, setLocalPlaylist] = useState<StreamPlaylistItem[] | null>(null)
  const [episodeLoading, setEpisodeLoading] = useState(false)
  const [subsEnabled, setSubsEnabled] = useState(true)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [subtitleLine, setSubtitleLine] = useState('')
  const [subsStatus, setSubsStatus] = useState<'idle' | 'loading' | 'ready' | 'missing'>('idle')
  const hintTimer = useRef<number | null>(null)
  const chromeTimer = useRef<number | null>(null)
  const resumeKeyRef = useRef<string | null>(null)
  const watchClockRef = useRef({ lastTs: 0, accrued: 0 })
  /** Seconds skipped via remux `t=` / ffmpeg -ss — add to video.currentTime when saving/showing subs. */
  const timelineOffsetRef = useRef(0)
  const [timelineOffset, setTimelineOffset] = useState(0)
  const resumePendingRef = useRef(false)
  /** After Restart, block saves until the playhead is back near 0 (avoids re-writing old time). */
  const restartGuardRef = useRef(false)
  const [resumeOffer, setResumeOffer] = useState<number | null>(null)
  const [skipIntervals, setSkipIntervals] = useState<AnimeSkipInterval[]>([])
  const [skipTarget, setSkipTarget] = useState<AnimeSkipInterval | null>(null)
  const skipDismissedRef = useRef<string | null>(null)
  const selectPlaylistItemRef = useRef<(index: number) => Promise<void>>(async () => {})
  const skipAnimeIntervalRef = useRef<
    (interval: AnimeSkipInterval, options?: { auto?: boolean }) => void
  >(() => {})
  const isPip = layout === 'pip'
  const isTile = layout === 'tile'
  // In multi-view, only the selected (primary) tile has audio
  const effectiveMuted = isTile ? !isPrimary : muted
  const { nowNextFor } = useEpg()
  const { awaitingAdd, armMultiviewAdd, cancelMultiviewAdd, slots } = usePlayback()
  const epg = !isPip && !isTile ? nowNextFor(item) : {}
  const inMultiview = slots.length > 1
  const playlist =
    localPlaylist && localPlaylist.length > 0
      ? localPlaylist
      : item.playlist && item.playlist.length > 0
        ? item.playlist
        : [{ title: item.title, url: item.url, fileName: item.description, subtitleUrl: item.subtitleUrl }]
  const activePlaylistItem = playlist[Math.min(playlistIndex, playlist.length - 1)] ?? {
    title: item.title,
    url: item.url,
    subtitleUrl: item.subtitleUrl,
  }
  const hasPlaylist = playlist.length > 1
  // Prefer the active episode's subs only — never fall back to episode 1's URL.
  const subtitleUrl = hasPlaylist
    ? activePlaylistItem.subtitleUrl
    : (activePlaylistItem.subtitleUrl ?? item.subtitleUrl)

  useEffect(() => {
    const list =
      item.playlist && item.playlist.length > 0
        ? item.playlist.map((entry) => ({ ...entry }))
        : null
    setLocalPlaylist(list)

    const saved = getContinueEntry(item.id)
    const maxIndex = Math.max(0, (list?.length ?? 1) - 1)
    let nextIndex = 0
    if (list && list.length > 0) {
      const byUrl = list.findIndex((entry) => entry.url && entry.url === item.url)
      if (byUrl >= 0) nextIndex = byUrl
      else if (saved) nextIndex = Math.min(Math.max(0, saved.playlistIndex), maxIndex)
    }
    setPlaylistIndex(nextIndex)
    // Open the episode drawer for multi-episode titles so the list is obvious.
    const multi = Boolean(list && list.length > 1)
    setPlaylistOpen(multi)
    playlistOpenRef.current = multi
    setSubsEnabled(true)
    setEpisodeLoading(false)
    resumeKeyRef.current = null
    timelineOffsetRef.current = 0
    setTimelineOffset(0)
    resumePendingRef.current = Boolean(saved && saved.playlistIndex === nextIndex && saved.currentTime >= 5)
    watchClockRef.current = {
      lastTs: 0,
      accrued: saved?.currentTime && saved.currentTime >= 5 ? saved.currentTime : 0,
    }
    setResumeOffer(
      saved && saved.playlistIndex === nextIndex && saved.currentTime >= 5
        ? saved.currentTime
        : null,
    )
    setSkipIntervals([])
    setSkipTarget(null)
    skipDismissedRef.current = null
  }, [item.id, item.playlist?.length, item.url])

  useEffect(() => {
    if (isTile || isPip || item.category !== 'anime') {
      setSkipIntervals([])
      setSkipTarget(null)
      return
    }

    let cancelled = false
    const episodeTitle = activePlaylistItem.title || item.title
    const showTitle = item.title

    async function loadSkipTimes() {
      const video = videoRef.current
      const reported =
        video && Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
          ? video.duration + timelineOffsetRef.current
          : 0
      // Prefer a saved full length over progressive remux buffer duration.
      const saved = getContinueEntry(item.id)
      const savedDuration =
        saved?.duration && saved.duration >= 5 * 60 ? saved.duration : 0
      const duration = reported >= 5 * 60 ? reported : savedDuration
      const intervals = await resolveAnimeSkipIntervals({
        title: showTitle,
        showTitle,
        episodeTitle,
        episodeLength: duration,
        episodeHint: playlistIndex + 1,
      })
      if (!cancelled) setSkipIntervals(intervals)
    }

    void loadSkipTimes()

    const video = videoRef.current
    const onDuration = () => {
      const d = videoRef.current?.duration
      if (d && Number.isFinite(d) && d !== Infinity && d + timelineOffsetRef.current >= 5 * 60) {
        void loadSkipTimes()
      }
    }
    video?.addEventListener('durationchange', onDuration)

    return () => {
      cancelled = true
      video?.removeEventListener('durationchange', onDuration)
    }
  }, [
    item.category,
    item.id,
    item.title,
    activePlaylistItem.title,
    playlistIndex,
    isTile,
    isPip,
  ])

  function setPlaylistOpenState(open: boolean) {
    playlistOpenRef.current = open
    setPlaylistOpen(open)
    if (open) {
      setChromeVisible(true)
      if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
    } else {
      bumpChrome()
    }
  }

  function setTimelineOffsetSeconds(seconds: number) {
    const next = Math.max(0, Math.floor(seconds))
    timelineOffsetRef.current = next
    setTimelineOffset(next)
  }

  function absolutePlayhead(video: HTMLVideoElement): number {
    const reported = Number.isFinite(video.currentTime) ? video.currentTime : 0
    return reported + timelineOffsetRef.current
  }

  function applyResumePosition(video: HTMLVideoElement) {
    if (isTile) return
    const key = `${item.id}:${playlistIndex}`
    if (resumeKeyRef.current === key) return
    const saved = getContinueEntry(item.id)
    if (!saved || saved.playlistIndex !== playlistIndex) return
    if (saved.currentTime < 5) {
      resumeKeyRef.current = key
      resumePendingRef.current = false
      return
    }

    const target = saved.currentTime
    const playbackUrl = activePlaylistItem.url || item.url || video.currentSrc

    // Remux streams cannot byte-seek — restart the pipe at the saved time.
    if (isRemuxPlaybackUrl(playbackUrl)) {
      const resumeUrl = withResumeOffset(playbackUrl, target)
      if (video.currentSrc !== resumeUrl && !video.currentSrc.includes(`t=${Math.floor(target)}`)) {
        setTimelineOffsetSeconds(target)
        resumePendingRef.current = false
        resumeKeyRef.current = key
        setResumeOffer(null)
        video.src = resumeUrl
        video.load()
        void video.play().catch(() => undefined)
        flash(`Resumed at ${formatClock(target)}`)
        return
      }
      setTimelineOffsetSeconds(target)
      resumeKeyRef.current = key
      resumePendingRef.current = false
      setResumeOffer(null)
      flash(`Resumed at ${formatClock(target)}`)
      return
    }

    const seekOnce = (): boolean => {
      const trustedDuration =
        Number.isFinite(video.duration) && video.duration !== Infinity && video.duration >= 5 * 60
      const aim = trustedDuration ? Math.min(target, Math.max(0, video.duration - 5)) : target
      if (aim < 5) return true
      try {
        video.currentTime = aim
      } catch {
        return false
      }
      // Only treat as done when the engine actually moved near the target.
      if (Math.abs(video.currentTime - aim) <= 2 || video.currentTime >= aim - 1.5) {
        setTimelineOffsetSeconds(0)
        resumeKeyRef.current = key
        resumePendingRef.current = false
        setResumeOffer(null)
        flash(`Resumed at ${formatClock(aim)}`)
        return true
      }
      return false
    }

    if (seekOnce()) return

    const startedAt = Date.now()
    const retry = () => {
      if (resumeKeyRef.current === key || isTile) return
      if (seekOnce()) return
      if (Date.now() - startedAt > 90_000) {
        resumePendingRef.current = false
        return
      }
      window.setTimeout(retry, 400)
    }
    video.addEventListener('seekablechange', retry)
    video.addEventListener('canplay', retry)
    video.addEventListener('durationchange', retry)
    window.setTimeout(retry, 300)
  }

  function effectivePlayhead(video: HTMLVideoElement): number {
    const absolute = absolutePlayhead(video)
    return Math.max(absolute, watchClockRef.current.accrued)
  }

  function tickWatchClock(video: HTMLVideoElement) {
    const now = performance.now()
    if (!video.paused && !video.ended) {
      if (watchClockRef.current.lastTs > 0) {
        watchClockRef.current.accrued += (now - watchClockRef.current.lastTs) / 1000
      }
      watchClockRef.current.lastTs = now
      const absolute = absolutePlayhead(video)
      if (absolute > watchClockRef.current.accrued) {
        watchClockRef.current.accrued = absolute
      }
    } else {
      watchClockRef.current.lastTs = 0
    }
  }

  function saveContinueProgress() {
    if (isTile) return
    const video = videoRef.current
    if (!video) return
    tickWatchClock(video)
    const reportedDuration =
      Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
        ? video.duration
        : 0
    // Absolute timeline: remux resume uses -ss offset so add it back for % complete.
    const duration =
      reportedDuration > 0
        ? reportedDuration + timelineOffsetRef.current
        : 0
    const currentTime = effectivePlayhead(video)
    if (restartGuardRef.current) {
      // Drop stale mid-episode ticks until the restarted stream is actually at the start.
      if (currentTime >= 5) return
      restartGuardRef.current = false
      return
    }
    const saved = getContinueEntry(item.id)
    // Prefer a trusted full length over progressive remux buffer duration.
    const knownDuration =
      duration >= 5 * 60
        ? duration
        : saved?.duration && saved.duration >= 5 * 60
          ? saved.duration
          : duration > 0
            ? duration
            : saved?.duration || 0

    // Don't clobber a real resume point with ~0 while seek/remux restart is still pending.
    if (
      resumePendingRef.current &&
      saved &&
      currentTime + 10 < saved.currentTime
    ) {
      return
    }

    // Finished (≥95% of a known length) or natural end — leave Continue watching.
    if (video.ended || isEpisodeComplete(currentTime, knownDuration)) {
      removeContinueEntry(item.id)
      return
    }

    upsertContinueEntry(
      {
        id: item.id,
        title: item.title,
        poster: item.poster,
        category: item.category,
        playlistIndex,
        episodeTitle: hasPlaylist ? activePlaylistItem.title : undefined,
        currentTime,
        duration: knownDuration,
        torrentUri: item.torrentUri,
        detailUrl: item.detailUrl,
        // Prefer a stable catalog/detail URL over the ephemeral 127.0.0.1 remux URL.
        playUrl:
          item.detailUrl ||
          item.torrentUri ||
          (item.url && !/^https?:\/\/127\.0\.0\.1/i.test(item.url) ? item.url : undefined),
        transport: item.transport,
        sourceKind: item.sourceKind,
        source: item.source,
      },
      { allowUnknownDuration: true },
    )
  }

  function restartEpisode() {
    if (isPip || isTile || episodeLoading) return
    // Clear Continue watching for this title — restart is the only bypass for resume.
    restartGuardRef.current = true
    removeContinueEntry(item.id)
    resumePendingRef.current = false
    resumeKeyRef.current = `${item.id}:${playlistIndex}:restart`
    setResumeOffer(null)
    skipDismissedRef.current = null
    setSkipTarget(null)
    const hadOffset = timelineOffsetRef.current > 0
    setTimelineOffsetSeconds(0)
    watchClockRef.current = { lastTs: 0, accrued: 0 }

    const video = videoRef.current
    if (!video) return

    const raw = activePlaylistItem.url || item.url || video.currentSrc
    const url = stripResumeOffset(raw)
    const hadRemuxSeek =
      isRemuxPlaybackUrl(raw) ||
      /[?&]t=\d+/.test(video.currentSrc) ||
      hadOffset

    setError(null)
    if (hadRemuxSeek || isRemuxPlaybackUrl(url)) {
      setStatus('Restarting…')
      video.src = url
      video.load()
      void video.play().catch(() => setStatus('Press play'))
    } else {
      try {
        video.currentTime = 0
      } catch {
        /* ignore */
      }
      void video.play().catch(() => undefined)
    }
    flash('Restarted from beginning')
    bumpChrome()
  }

  function seekToResumeOffer() {
    const video = videoRef.current
    const target = resumeOffer
    if (!video || target == null || target < 5) return
    const playbackUrl = activePlaylistItem.url || item.url || video.currentSrc
    if (isRemuxPlaybackUrl(playbackUrl)) {
      setTimelineOffsetSeconds(target)
      resumePendingRef.current = false
      resumeKeyRef.current = `${item.id}:${playlistIndex}`
      setStatus(`Resuming at ${formatClock(target)}…`)
      const baseUrl = playbackUrl.replace(/([?&])t=\d+(&|$)/, '$1').replace(/[?&]$/, '')
      const resumeUrl = withResumeOffset(baseUrl, target)
      let settled = false
      const failTimer = window.setTimeout(() => {
        if (settled) return
        settled = true
        setTimelineOffsetSeconds(0)
        setResumeOffer(target)
        video.src = baseUrl
        video.load()
        void video.play().catch(() => undefined)
        setStatus('Ready')
        flash('Resume not buffered yet — try again in a bit')
      }, 18000)
      const onReady = () => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('canplay', onReady)
        setResumeOffer(null)
        setStatus('Ready')
        flash(`Resumed at ${formatClock(target)}`)
        void video.play().catch(() => undefined)
      }
      video.addEventListener('loadeddata', onReady)
      video.addEventListener('canplay', onReady)
      video.src = resumeUrl
      video.load()
      void video.play().catch(() => undefined)
      return
    }
    try {
      video.currentTime = target
      if (Math.abs(video.currentTime - target) > 3) {
        flash('Resume is not ready yet — try again in a moment')
        return
      }
      resumeKeyRef.current = `${item.id}:${playlistIndex}`
      resumePendingRef.current = false
      setResumeOffer(null)
      flash(`Resumed at ${formatClock(target)}`)
      void video.play().catch(() => undefined)
    } catch {
      flash('Resume is not ready yet — try again in a moment')
    }
  }

  useEffect(() => {
    let cancelled = false
    setSubtitleCues([])
    setSubtitleLine('')

    if (!subtitleUrl) {
      setSubsStatus('idle')
      return
    }

    setSubsStatus('loading')
    const startedAt = Date.now()
    // Keep refreshing for a long time — progressive extract fills cues as the
    // torrent downloads; stopping early makes subs vanish mid-episode.
    const maxWaitMs = 3 * 60 * 60 * 1000
    let latestCount = 0
    let lastCueEnd = 0

    async function waitForPlaybackHeadStart() {
      const video = videoRef.current
      if (!video) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        return
      }
      if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          video.removeEventListener('playing', finish)
          window.clearTimeout(timer)
          resolve()
        }
        // Let remux grab opening pieces before subtitle extract competes for bandwidth.
        const timer = window.setTimeout(finish, 12000)
        video.addEventListener('playing', finish)
      })
    }

    async function loadSubtitles() {
      await waitForPlaybackHeadStart()
      if (cancelled) return

      while (!cancelled && Date.now() - startedAt < maxWaitMs) {
        try {
          const response = await fetch(
            `${subtitleUrl}${subtitleUrl!.includes('?') ? '&' : '?'}t=${Date.now()}`,
          )
          if (response.ok) {
            const text = await response.text()
            const cues = parseSubtitleCues(text)
            if (cues.length >= latestCount) {
              if (cues.length > latestCount) {
                latestCount = cues.length
                lastCueEnd = cues.reduce((max, cue) => Math.max(max, cue.end), 0)
                if (!cancelled) {
                  setSubtitleCues(cues)
                  setSubsStatus('ready')
                }
              } else if (cues.length > 0 && latestCount === 0) {
                latestCount = cues.length
                if (!cancelled) {
                  setSubtitleCues(cues)
                  setSubsStatus('ready')
                }
              }
            }
            const extractDone = response.headers.get('X-Jiyu-Subs-Done') === '1'
            const playhead = videoRef.current ? absolutePlayhead(videoRef.current) : 0

            // Only stop polling once extract is finished AND we're not about to run past
            // the last cue (progressive jobs sometimes flip "done" too early).
            if (extractDone && latestCount > 0 && playhead < lastCueEnd - 90) {
              await new Promise((resolve) => window.setTimeout(resolve, 5000))
              continue
            }
            if (extractDone && latestCount > 0 && lastCueEnd > 0 && playhead >= lastCueEnd - 5) {
              break
            }

            // If playback is catching up to the last known cue, poll faster.
            if (!extractDone && lastCueEnd > 0 && playhead > lastCueEnd - 45) {
              await new Promise((resolve) => window.setTimeout(resolve, 800))
              continue
            }
          } else if (latestCount === 0 && response.status === 404) {
            const message = await response.text().catch(() => '')
            if (/not ready|timed out|read failed|could not read/i.test(message)) {
              /* retry */
            } else if (/no subtitle track/i.test(message) && Date.now() - startedAt > 45_000) {
              // Don't give up too early — remux/resume may still be spinning up extract.
              break
            }
          }
        } catch {
          /* retry while torrent pieces / ffmpeg catch up */
        }
        // Keep polling even after "done" if cues look short for a long title —
        // progressive extract often resumes after an early EOF.
        await new Promise((resolve) => window.setTimeout(resolve, 2000))
      }
      if (!cancelled && latestCount === 0) setSubsStatus('missing')
    }

    void loadSubtitles()
    return () => {
      cancelled = true
    }
  }, [subtitleUrl, playlistIndex])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const syncCue = () => {
      if (!subsEnabled || subtitleCues.length === 0) {
        setSubtitleLine('')
        return
      }
      // Remux resume uses ffmpeg -ss, so video.currentTime is relative — add offset.
      setSubtitleLine(activeSubtitleText(subtitleCues, absolutePlayhead(video)))
    }

    syncCue()
    video.addEventListener('timeupdate', syncCue)
    video.addEventListener('seeked', syncCue)
    return () => {
      video.removeEventListener('timeupdate', syncCue)
      video.removeEventListener('seeked', syncCue)
    }
  }, [subtitleCues, subsEnabled, activePlaylistItem.url, playlistIndex, timelineOffset])

  function toggleSubtitles() {
    setSubsEnabled((on) => !on)
    bumpChrome()
  }

  async function selectPlaylistItem(index: number) {
    if (index < 0 || index >= playlist.length || index === playlistIndex || episodeLoading) return
    const entry = playlist[index]
    // Always re-resolve torrent episodes. Sibling entries often still hold a
    // 127.0.0.1 remux URL from earlier, but torrentStop() kills that swarm —
    // reusing it shows "Native playback failed".
    const needsTorrent =
      Boolean(entry.torrentUri) &&
      (!entry.url ||
        !/^https?:\/\//i.test(entry.url) ||
        isEphemeralLocalStreamUrl(entry.url))

    if (needsTorrent) {
      if (!window.signalDesktop?.torrentStream) {
        setError('Torrent playback needs the Jiyu desktop app.')
        return
      }
      setEpisodeLoading(true)
      setStatus('Loading episode…')
      setError(null)
      try {
        // Drop the previous episode's swarm so the new one can fetch opening pieces.
        await window.signalDesktop.torrentStop?.()
        const result = await window.signalDesktop.torrentStream(entry.torrentUri!)
        if (!result.ok || !result.url) {
          setError(result.error || 'Could not start episode')
          setEpisodeLoading(false)
          return
        }
        setLocalPlaylist((prev) => {
          const base = prev ?? item.playlist ?? []
          return base.map((row, i) => {
            if (i === index) {
              return {
                ...row,
                url: result.url!,
                subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                fileName: result.fileName,
              }
            }
            // Invalidate dead local URLs after the swarm swap.
            if (isEphemeralLocalStreamUrl(row.url)) {
              return { ...row, url: '', subtitleUrl: undefined }
            }
            return row
          })
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start episode')
        setEpisodeLoading(false)
        return
      }
      setEpisodeLoading(false)
    }

    // Always start a freshly selected episode at 0 — don't remux-seek into
    // undownloaded pieces from a prior resume point for another episode.
    watchClockRef.current = { lastTs: 0, accrued: 0 }
    timelineOffsetRef.current = 0
    setTimelineOffset(0)
    resumeKeyRef.current = null
    resumePendingRef.current = false
    setResumeOffer(null)
    skipDismissedRef.current = null
    setSkipTarget(null)
    setPlaylistIndex(index)
    setPlaylistOpenState(false)
    bumpChrome()
  }
  selectPlaylistItemRef.current = selectPlaylistItem

  function moveInPlaylist(delta: number) {
    void selectPlaylistItem(playlistIndex + delta)
  }

  function toggleMultiviewAdd() {
    if (awaitingAdd) cancelMultiviewAdd()
    else {
      armMultiviewAdd()
      flash('Multi-view: open another channel')
    }
    bumpChrome()
  }

  function bumpChrome() {
    setChromeVisible(true)
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
    // Keep chrome up while the episode list is open.
    if (playlistOpenRef.current || isPip) return
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS)
  }

  function togglePlaylist() {
    setPlaylistOpenState(!playlistOpenRef.current)
  }

  function flash(message: string) {
    setHint(message)
    if (hintTimer.current) window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHint(null), 900)
  }

  function applyVolume(next: number, options?: { unmute?: boolean }) {
    const video = videoRef.current
    const clamped = Math.min(1, Math.max(0, next))
    setVolume(clamped)
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped))
    } catch {
      /* ignore */
    }
    if (video) video.volume = clamped
    if (options?.unmute && muted) {
      setMuted(false)
      if (video) video.muted = false
      try {
        localStorage.setItem(MUTE_KEY, '0')
      } catch {
        /* ignore */
      }
    }
    flash(muted && !options?.unmute ? 'Muted' : `Volume ${Math.round(clamped * 100)}%`)
  }

  function toggleMute() {
    const video = videoRef.current
    const next = !muted
    setMuted(next)
    if (video) video.muted = next
    try {
      localStorage.setItem(MUTE_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
    flash(next ? 'Muted' : `Volume ${Math.round(volume * 100)}%`)
  }

  function togglePause() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().then(
        () => {
          setPaused(false)
          flash('Playing')
        },
        () => flash('Press play'),
      )
    } else {
      video.pause()
      setPaused(true)
      flash('Paused')
    }
  }

  function seekBy(seconds: number) {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration === Infinity) {
      flash('Live — seek unavailable')
      return
    }
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds))
    flash(seconds < 0 ? `Back ${Math.abs(seconds)}s` : `Forward ${seconds}s`)
  }

  function skipAnimeInterval(
    interval: AnimeSkipInterval,
    options?: { auto?: boolean },
  ) {
    const video = videoRef.current
    if (!video) return
    const endAt = Math.max(0, interval.endTime)
    skipDismissedRef.current = `${playlistIndex}:${interval.skipType}:${Math.round(interval.endTime)}`
    setSkipTarget(null)

    const url = activePlaylistItem.url
    const relative = Math.max(0, endAt - timelineOffsetRef.current)
    const notice = options?.auto ? 'Skipped intro' : skipButtonLabel(interval)

    // Prefer an in-stream seek whenever the target is already buffered — keeps
    // audio, video, and subs on the same clock (no remux restart drift).
    if (isTimeBuffered(video, relative)) {
      video.currentTime = relative
      watchClockRef.current = { lastTs: 0, accrued: endAt }
      void video.play().catch(() => undefined)
      flash(notice)
      return
    }

    if (isRemuxPlaybackUrl(url)) {
      // Accurate output seek (-ss after -i) so A/V/subs stay aligned after skip.
      setStatus('Skipping…')
      setTimelineOffsetSeconds(endAt)
      watchClockRef.current = { lastTs: 0, accrued: endAt }
      resumeKeyRef.current = `${item.id}:${playlistIndex}:skip`
      resumePendingRef.current = false
      video.src = withResumeOffset(url, endAt, { exact: true })
      video.load()
      void video.play().catch(() => undefined)
      flash(notice)
      return
    }

    video.currentTime = relative
    watchClockRef.current = { lastTs: 0, accrued: endAt }
    void video.play().catch(() => undefined)
    flash(notice)
  }
  skipAnimeIntervalRef.current = skipAnimeInterval

  function toggleFullscreen() {
    const stage = shellRef.current
    if (!stage) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      flash('Exit fullscreen')
    } else {
      void stage.requestFullscreen().catch(() => undefined)
      flash('Fullscreen')
    }
  }

  useEffect(() => {
    if (isTile || isPip) return
    const video = videoRef.current
    const shell = shellRef.current
    if (!video || !shell) return

    const keepSubsInFullscreen = () => {
      // Native <video> fullscreen drops our overlay subs — bounce to the shell.
      if (document.fullscreenElement === video) {
        void document
          .exitFullscreen()
          .then(() => shell.requestFullscreen())
          .catch(() => undefined)
      }
    }

    document.addEventListener('fullscreenchange', keepSubsInFullscreen)
    video.addEventListener('webkitbeginfullscreen', keepSubsInFullscreen as EventListener)
    return () => {
      document.removeEventListener('fullscreenchange', keepSubsInFullscreen)
      video.removeEventListener('webkitbeginfullscreen', keepSubsInFullscreen as EventListener)
    }
  }, [isTile, isPip, item.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = effectiveMuted
  }, [item, retryTick, volume, effectiveMuted])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activePlaylistItem?.url) return

    let cancelled = false
    let hls: Hls | null = null
    let tsPlayer: ReturnType<typeof mpegts.createPlayer> | null = null

    const applyHlsQuality = () => {
      if (!hls || hls.levels.length === 0) return
      const preference = getViewingQuality()
      if (preference === 'auto') {
        hls.autoLevelCapping = -1
        hls.currentLevel = -1
        setEngineLabel('hls · auto')
        return
      }
      const levels = hls.levels
        .map((level, index) => ({ index, height: level.height || 0 }))
        .filter((level) => level.height > 0)
        .sort((a, b) => a.height - b.height)
      if (levels.length === 0) return
      const selected =
        [...levels].reverse().find((level) => level.height <= preference) ?? levels[0]
      hls.autoLevelCapping = selected.index
      hls.currentLevel = selected.index
      setEngineLabel(`hls · ${viewingQualityLabel(preference)}`)
    }
    const onViewingQuality = () => applyHlsQuality()
    window.addEventListener('jiyu:viewing-quality', onViewingQuality)

    setError(null)
    setStatus('Connecting…')
    setEngineLabel('')
    setPaused(false)

    const onPlaying = () => {
      if (!cancelled) {
        setError(null)
        setStatus('Playing')
        setPaused(false)
      }
    }
    const onWaiting = () => {
      if (!cancelled) setStatus('Buffering…')
    }
    const onPause = () => {
      if (!cancelled) setPaused(true)
    }
    const onEnded = () => {
      saveContinueProgress()
      if (!cancelled && playlistIndex < playlist.length - 1) {
        // Re-resolve torrent URLs — don't just bump the index onto a dead remux link.
        void selectPlaylistItemRef.current(playlistIndex + 1)
      }
    }

    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)

    const cleanupPlayers = () => {
      if (hls) {
        hls.destroy()
        hls = null
      }
      if (tsPlayer) {
        try {
          tsPlayer.pause()
          tsPlayer.unload()
          tsPlayer.detachMediaElement()
          tsPlayer.destroy()
        } catch {
          /* ignore */
        }
        tsPlayer = null
      }
      video.removeAttribute('src')
      video.load()
    }

    const tryNative = () =>
      new Promise<void>((resolve, reject) => {
        setEngineLabel('native')
        setStatus('Loading stream…')
        let settled = false
        let resumeAttempt = 0
        const saved = getContinueEntry(item.id)
        const resumeAt =
          saved && saved.playlistIndex === playlistIndex && saved.currentTime >= 5
            ? saved.currentTime
            : 0

        const isAlreadyPlaying = () =>
          !video.error &&
          (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime > 0.1) &&
          (video.currentTime > 0.1 || (!video.paused && !video.ended))

        const finishOk = () => {
          if (settled) return
          settled = true
          window.clearTimeout(loadTimer)
          cleanup()
          setError(null)
          setStatus('Ready')
          resolve()
        }

        const onError = () => {
          if (settled) return
          // Playing through a decode glitch — don't fail the whole load.
          if (isAlreadyPlaying()) {
            finishOk()
            return
          }
          // If a mid-title remux resume failed, fall back to the start so we don't spin forever.
          if (resumeAttempt > 0 && resumeAt >= 5) {
            resumeAttempt = 0
            setTimelineOffsetSeconds(0)
            setResumeOffer(resumeAt)
            resumePendingRef.current = false
            resumeKeyRef.current = null
            setStatus('Starting from the beginning…')
            // Re-arm ready listeners — the first onReady path already removed them.
            cleanup()
            video.addEventListener('error', onError)
            video.addEventListener('loadeddata', onReady)
            video.addEventListener('canplay', onReady)
            video.addEventListener('playing', onPlayingSuccess)
            video.addEventListener('timeupdate', onProgressTick)
            window.clearTimeout(loadTimer)
            loadTimer = window.setTimeout(onLoadTimeout, 35000)
            video.src = activePlaylistItem.url
            video.load()
            void video.play().catch(() => undefined)
            flash('Resume not buffered yet — started from the beginning')
            return
          }
          settled = true
          window.clearTimeout(loadTimer)
          cleanup()
          reject(new Error('Native playback failed — stream offline, blocked, or unsupported.'))
        }

        const onReady = () => {
          if (settled) return
          cleanupReadyOnly()
          setStatus('Ready')
          // Start from the opening pieces first (always available). Then try resume.
          if (resumeAt >= 5 && resumeAttempt === 0 && isRemuxPlaybackUrl(activePlaylistItem.url)) {
            resumeAttempt = 1
            setStatus(`Resuming at ${formatClock(resumeAt)}…`)
            setTimelineOffsetSeconds(resumeAt)
            resumeKeyRef.current = `${item.id}:${playlistIndex}`
            resumePendingRef.current = false
            setResumeOffer(null)
            video.src = withResumeOffset(activePlaylistItem.url, resumeAt)
            video.load()
            void video.play().catch(() => undefined)
            // Keep listening for ready/error on the resumed URL.
            video.addEventListener('error', onError)
            video.addEventListener('loadeddata', onResumeReady)
            video.addEventListener('canplay', onResumeReady)
            video.addEventListener('playing', onPlayingSuccess)
            video.addEventListener('timeupdate', onProgressTick)
            return
          }
          if (resumeAttempt === 0) {
            applyResumePosition(video)
          }
          void video.play().catch(() => setStatus('Press play'))
          finishOk()
        }

        const onResumeReady = () => {
          if (settled) return
          flash(`Resumed at ${formatClock(resumeAt)}`)
          void video.play().catch(() => setStatus('Press play'))
          finishOk()
        }

        const onPlayingSuccess = () => {
          // Remux often decodes before loadeddata/canplay — any real playback is success,
          // including after a remux -ss resume swap.
          if (settled) return
          if (resumeAttempt > 0) {
            flash(`Resumed at ${formatClock(resumeAt)}`)
          }
          finishOk()
        }

        const onProgressTick = () => {
          if (settled) return
          if (isAlreadyPlaying()) finishOk()
        }

        const cleanupReadyOnly = () => {
          video.removeEventListener('loadeddata', onReady)
          video.removeEventListener('canplay', onReady)
        }

        const cleanup = () => {
          cleanupReadyOnly()
          video.removeEventListener('error', onError)
          video.removeEventListener('loadeddata', onResumeReady)
          video.removeEventListener('canplay', onResumeReady)
          video.removeEventListener('playing', onPlayingSuccess)
          video.removeEventListener('timeupdate', onProgressTick)
        }

        const onLoadTimeout = () => {
          if (settled) return
          // Stream may already be playing even if ready events never arrived.
          if (isAlreadyPlaying()) {
            finishOk()
            return
          }
          if (resumeAttempt > 0 && resumeAt >= 5) {
            onError()
            return
          }
          settled = true
          cleanup()
          reject(new Error('Timed out loading stream — try another source or quality.'))
        }

        // Remux -ss into undownloaded pieces can hang forever — bail out to t=0.
        let loadTimer = window.setTimeout(onLoadTimeout, resumeAt >= 5 ? 22000 : 35000)

        video.addEventListener('error', onError)
        video.addEventListener('loadeddata', onReady)
        video.addEventListener('canplay', onReady)
        video.addEventListener('playing', onPlayingSuccess)
        video.addEventListener('timeupdate', onProgressTick)

        // Always open at t=0 first so the swarm's priority pieces can start playback.
        setTimelineOffsetSeconds(0)
        if (resumeAt >= 5) setResumeOffer(resumeAt)
        video.src = activePlaylistItem.url
        video.load()
        void video.play().catch(() => {
          /* wait for events */
        })
      })

    const tryHls = () =>
      new Promise<void>((resolve, reject) => {
        if (!Hls.isSupported()) {
          reject(new Error('HLS not supported'))
          return
        }
        setEngineLabel('hls')
        setStatus('Loading HLS…')
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 30,
          fragLoadingMaxRetry: 6,
          manifestLoadingMaxRetry: 5,
          levelLoadingMaxRetry: 5,
          xhrSetup(xhr) {
            xhr.withCredentials = false
          },
        })
        let recoveries = 0
        hls.loadSource(activePlaylistItem.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return
          applyHlsQuality()
          setStatus('Ready')
          applyResumePosition(video)
          void video.play().catch(() => setStatus('Press play'))
          resolve()
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return
          if (recoveries < 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            recoveries += 1
            try {
              hls?.startLoad()
              return
            } catch {
              /* fall through */
            }
          }
          if (recoveries < 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            recoveries += 1
            try {
              hls?.recoverMediaError()
              return
            } catch {
              /* fall through */
            }
          }
          const message = describeHlsError(data)
          hls?.destroy()
          hls = null
          reject(new Error(message))
        })
      })

    const tryTs = () =>
      new Promise<void>((resolve, reject) => {
        if (!mpegts.isSupported()) {
          reject(new Error('MPEG-TS not supported'))
          return
        }
        setEngineLabel('mpeg-ts')
        setStatus('Loading MPEG-TS…')
        let settled = false
        tsPlayer = mpegts.createPlayer(
          { type: 'mse', isLive: true, url: activePlaylistItem.url },
          {
            enableWorker: true,
            enableStashBuffer: false,
            liveBufferLatencyChasing: true,
            autoCleanupSourceBuffer: true,
          },
        )
        tsPlayer.on(mpegts.Events.ERROR, () => {
          if (settled) return
          settled = true
          reject(new Error('MPEG-TS playback failed — stream offline or unsupported.'))
        })
        tsPlayer.attachMediaElement(video)
        tsPlayer.load()
        void tsPlayer.play().then(
          () => {
            if (settled || cancelled) return
            settled = true
            setStatus('Playing')
            resolve()
          },
          () => {
            if (settled || cancelled) return
            settled = true
            setStatus('Press play')
            resolve()
          },
        )
      })

    const runners: Record<Engine, () => Promise<void>> = {
      hls: tryHls,
      ts: tryTs,
      native: tryNative,
    }

    ;(async () => {
      const engines = pickEngines(activePlaylistItem.url)
      let lastError = 'Playback failed.'
      for (const engine of engines) {
        if (cancelled) return
        cleanupPlayers()
        try {
          await runners[engine]()
          if (!cancelled) setError(null)
          return
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }
      // Don't paint a timeout/error overlay on top of a stream that actually started.
      if (
        !cancelled &&
        !video.error &&
        (video.currentTime > 0.25 ||
          (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused))
      ) {
        setError(null)
        setStatus('Playing')
        return
      }
      if (!cancelled) setError(lastError)
    })()

    return () => {
      cancelled = true
      saveContinueProgress()
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      window.removeEventListener('jiyu:viewing-quality', onViewingQuality)
      cleanupPlayers()
    }
  }, [item.id, item.url, activePlaylistItem.url, playlistIndex, playlist.length, retryTick])

  useEffect(() => {
    if (isTile) return

    const persist = () => saveContinueProgress()
    const onTimeUpdate = () => {
      persist()
      const video = videoRef.current
      // Clear a stale load-timeout overlay if the stream is clearly progressing.
      if (
        video &&
        !video.error &&
        video.currentTime > 0.5 &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        setError((prev) => (prev ? null : prev))
      }
      if (video && skipIntervals.length > 0 && item.category === 'anime') {
        const playhead = absolutePlayhead(video)
        const active = activeSkipInterval(skipIntervals, playhead)
        const dismissKey = active
          ? `${playlistIndex}:${active.skipType}:${Math.round(active.endTime)}`
          : null
        if (active && skipDismissedRef.current !== dismissKey) {
          // Cold open already played — auto-jump AniSkip OPs that start after a teaser.
          if (shouldAutoSkipOpening(active)) {
            skipAnimeIntervalRef.current(active, { auto: true })
            return
          }
          setSkipTarget(active)
        } else {
          setSkipTarget(null)
        }
      }
    }
    const onPauseSave = () => persist()
    const onPageHide = () => persist()
    const onForceSave = () => persist()

    const video = videoRef.current
    video?.addEventListener('timeupdate', onTimeUpdate)
    video?.addEventListener('pause', onPauseSave)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
    // Interval backup — timeupdate is unreliable on some remux streams, and the
    // video ref may not be ready on the first effect pass.
    const interval = window.setInterval(persist, 2500)

    return () => {
      persist()
      video?.removeEventListener('timeupdate', onTimeUpdate)
      video?.removeEventListener('pause', onPauseSave)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
      window.clearInterval(interval)
    }
  }, [item.id, item.title, item.poster, item.category, playlistIndex, activePlaylistItem.title, isTile, hasPlaylist, skipIntervals])

  useEffect(() => {
    if (isTile) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      bumpChrome()

      switch (e.key) {
        case 'Escape':
          if (document.fullscreenElement) {
            void document.exitFullscreen()
          } else {
            onClose()
          }
          break
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault()
          togglePause()
          break
        case 'm':
        case 'M':
          e.preventDefault()
          toggleMute()
          break
        case 'c':
        case 'C':
          if (subtitleUrl && subsStatus !== 'missing') {
            e.preventDefault()
            toggleSubtitles()
          }
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'ArrowUp':
          e.preventDefault()
          applyVolume(volume + 0.05, { unmute: true })
          break
        case 'ArrowDown':
          e.preventDefault()
          applyVolume(volume - 0.05)
          break
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault()
          seekBy(-10)
          break
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault()
          seekBy(10)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, muted, volume, isTile, subtitleUrl, subsStatus])

  useEffect(() => {
    if (isTile || isPip) return
    const stage = shellRef.current?.querySelector('.player-stage')
    if (!stage) return

    const onWheel = (e: Event) => {
      const we = e as globalThis.WheelEvent
      we.preventDefault()
      bumpChrome()
      const delta = we.deltaY > 0 ? -0.05 : 0.05
      const video = videoRef.current
      const current = video?.volume ?? volume
      const next = Math.min(1, Math.max(0, current + delta))
      applyVolume(next, { unmute: delta > 0 })
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [volume, muted, layout, isTile, isPip])

  useEffect(() => {
    bumpChrome()
    return () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current)
      if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
    }
  }, [layout, item.id])

  if (isTile) {
    return (
      <div
        ref={shellRef}
        className={`player-shell player-shell-tile ${isPrimary ? 'is-primary' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${item.title}${isPrimary ? ' (audio selected)' : ' — click for audio'}`}
        aria-pressed={isPrimary}
        onClick={() => onSpotlight?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSpotlight?.()
          }
        }}
      >
        <header className="player-bar tile-chrome">
          <div className="player-meta">
            <h2>{hasPlaylist ? activePlaylistItem.title : item.title}</h2>
            {isPrimary ? (
              <span className="tile-audio-badge">Audio</span>
            ) : (
              <span className="tile-audio-hint">Click for audio</span>
            )}
          </div>
          <div className="player-controls" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="ghost-btn control-btn" onClick={togglePause}>
              {paused ? 'Play' : 'Pause'}
            </button>
            <button type="button" className="ghost-btn control-btn" onClick={onClose} title="Remove">
              ×
            </button>
          </div>
        </header>
        <div className="player-stage">
          <video ref={videoRef} className="player-video" muted={effectiveMuted} autoPlay playsInline />
          {error && (
            <div className="player-error tile-error">
              <p>{error}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={shellRef}
      className={`player-shell ${isPip ? 'player-shell-pip' : ''} ${chromeVisible || isPip ? 'chrome-visible' : 'chrome-hidden'}`}
      role="dialog"
      aria-label={`Playing ${item.title}`}
      onMouseMove={isPip ? undefined : bumpChrome}
      onMouseEnter={isPip ? undefined : bumpChrome}
    >
      <header className={`player-bar player-chrome ${isPip ? 'pip-chrome' : ''}`}>
        <button type="button" className="ghost-btn player-back-btn" onClick={onClose}>
          {isPip ? '×' : '← Back'}
        </button>
        <div className="player-meta">
          <h2>{hasPlaylist ? activePlaylistItem.title : item.title}</h2>
          {hasPlaylist && !isPip && (
            <div className="player-episode-block">
              <button
                type="button"
                className={`player-episode-chip${playlistOpen ? ' is-open' : ''}`}
                onClick={togglePlaylist}
                aria-expanded={playlistOpen}
                aria-controls="player-episode-list"
                title="View all episodes"
              >
                Episode {playlistIndex + 1} of {playlist.length}
              </button>
              {playlistOpen && (
                <div
                  id="player-episode-list"
                  className="player-playlist"
                  role="listbox"
                  aria-label="Episodes"
                >
                  <ol>
                    {playlist.map((entry, index) => (
                      <li key={`${entry.fileName ?? entry.url}-${index}`}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === playlistIndex}
                          className={index === playlistIndex ? 'is-active' : ''}
                          disabled={episodeLoading}
                          onClick={() => void selectPlaylistItem(index)}
                        >
                          <span>{index + 1}</span>
                          {entry.title || `Episode ${index + 1}`}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
          {!isPip && (
            <p className="player-meta-status">
              <span>
                {error ?? status}
                {!error && engineLabel ? ` · ${engineLabel}` : ''}
                {!error ? ` · ${muted ? 'Muted' : `${Math.round(volume * 100)}%`}` : ''}
                {!error && subsStatus === 'loading' ? ' · Loading subtitles…' : ''}
                {!error && subsStatus === 'ready' ? ` · Subs ${subsEnabled ? 'on' : 'off'}` : ''}
                {awaitingAdd ? ' · Multi-view: pick another channel' : ''}
              </span>
            </p>
          )}
        </div>

        <div className="player-controls" onClick={(e) => e.stopPropagation()}>
          {isPip && (
            <>
              <button
                type="button"
                className="ghost-btn control-btn"
                onClick={togglePause}
                title={paused ? 'Play' : 'Pause'}
              >
                {paused ? 'Play' : 'Pause'}
              </button>
              {onExpand && (
                <button type="button" className="ghost-btn control-btn" onClick={onExpand}>
                  Expand
                </button>
              )}
            </>
          )}
          {!isPip && resumeOffer != null && (
            <button
              type="button"
              className="ghost-btn control-btn player-resume-btn"
              onClick={seekToResumeOffer}
              title="Jump back to where you left off"
            >
              Resume {formatClock(resumeOffer)}
            </button>
          )}
          {!isPip && isVodCategory(item.category) && (
            <button
              type="button"
              className="ghost-btn control-btn"
              onClick={restartEpisode}
              disabled={episodeLoading}
              title="Clear saved progress and start this episode from the beginning"
            >
              Restart
            </button>
          )}
          {!isPip && (
            <>
              {hasPlaylist && (
                <>
                  <button
                    type="button"
                    className="ghost-btn control-btn player-episode-nav"
                    disabled={playlistIndex === 0 || episodeLoading}
                    onClick={() => void moveInPlaylist(-1)}
                    title="Previous episode"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="ghost-btn control-btn player-episode-nav"
                    disabled={playlistIndex === playlist.length - 1 || episodeLoading}
                    onClick={() => void moveInPlaylist(1)}
                    title="Next episode"
                  >
                    Next
                  </button>
                </>
              )}
              <button type="button" className="ghost-btn control-btn" onClick={togglePause} title="Space / K">
                {paused ? 'Play' : 'Pause'}
              </button>
              <button type="button" className="ghost-btn control-btn" onClick={toggleMute} title="M">
                {muted || volume === 0 ? 'Unmute' : 'Mute'}
              </button>
              <label className="volume-control" title="Scroll on video or drag">
                <span className="sr-only">Volume</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((muted ? 0 : volume) * 100)}
                  onChange={(e) => {
                    const next = Number(e.target.value) / 100
                    applyVolume(next, { unmute: next > 0 })
                    bumpChrome()
                  }}
                />
              </label>
              {(subtitleUrl || subsStatus !== 'idle') && (
                <button
                  type="button"
                  className={`ghost-btn control-btn${subsEnabled && subsStatus === 'ready' ? ' is-armed' : ''}`}
                  onClick={toggleSubtitles}
                  disabled={subsStatus === 'missing'}
                  title={
                    subsStatus === 'loading'
                      ? 'Loading subtitles…'
                      : subsStatus === 'missing'
                        ? 'No subtitles found for this stream'
                        : subsEnabled
                          ? 'Hide subtitles'
                          : 'Show subtitles'
                  }
                >
                  {subsStatus === 'loading' ? 'Subs…' : subsStatus === 'missing' ? 'No Subs' : subsEnabled ? 'Subs On' : 'Subs Off'}
                </button>
              )}
              {!inMultiview && (
                <button
                  type="button"
                  className={`ghost-btn control-btn${awaitingAdd ? ' is-armed' : ''}`}
                  onClick={toggleMultiviewAdd}
                  title={
                    awaitingAdd
                      ? 'Cancel — next channel will replace this one'
                      : 'Add the next channel to multi-view instead of replacing'
                  }
                >
                  {awaitingAdd ? 'Pick channel…' : 'Multi-view'}
                </button>
              )}
              <button type="button" className="ghost-btn control-btn" onClick={toggleFullscreen} title="F">
                Full
              </button>
            </>
          )}
          {error && !isPip && (
            <button type="button" className="ghost-btn" onClick={() => setRetryTick((n) => n + 1)}>
              Retry
            </button>
          )}
        </div>
      </header>

      <div className="player-stage">
        <video
          ref={videoRef}
          className="player-video"
          controls={!isPip}
          controlsList="nofullscreen nodownload noremoteplayback"
          disablePictureInPicture
          autoPlay
          playsInline
          onDoubleClick={isPip ? undefined : toggleFullscreen}
        />
        {subsEnabled && subtitleLine && !isPip && (
          <div className="player-subtitles" aria-live="polite">
            {subtitleLine.split('\n').map((line, index) => (
              <span key={`${index}-${line}`}>{line}</span>
            ))}
          </div>
        )}
        {skipTarget && !isPip && !error && (
          <button
            type="button"
            className="player-skip-intro"
            onClick={(e) => {
              e.stopPropagation()
              skipAnimeInterval(skipTarget)
            }}
          >
            {skipButtonLabel(skipTarget)}
          </button>
        )}
        {isPip && paused && (
          <button
            type="button"
            className="pip-play-overlay"
            aria-label="Play"
            title="Play"
            onClick={(e) => {
              e.stopPropagation()
              togglePause()
            }}
          >
            ▶
          </button>
        )}
        {hint && !isPip && <div className="player-hint">{hint}</div>}
        {error && !isPip && (
          <div className="player-error">
            <p>{error}</p>
            <p className="player-error-hint">
              Status may show online while the stream still fails (DRM, expired token, or CDN block).
              Try another channel, use Web browser for YouTube / 1SpotMedia, or Refresh the playlist source.
            </p>
          </div>
        )}
        {!isPip && !error && (epg.now || epg.next) && (
          <div className="player-epg-strip player-chrome">
            {epg.now && (
              <>
                <strong>Now</strong> {epg.now.title}
              </>
            )}
            {epg.now && epg.next ? ' · ' : ''}
            {epg.next && (
              <>
                <strong>Next</strong> {epg.next.title}
              </>
            )}
          </div>
        )}
        {!isPip && !error && (
          <p className="player-hotkeys player-chrome">
            Scroll = volume · Space/K pause · M mute · ↑↓ volume · ←→ seek · F fullscreen · Esc back
            {awaitingAdd ? ' · Multi-view armed' : ''}
          </p>
        )}
      </div>
    </div>
  )
}
