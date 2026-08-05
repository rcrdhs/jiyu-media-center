import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import { PlaybackLoadingScreen } from './PlaybackLoadingScreen'
import { isHlsUrl, isMpegTsUrl } from '../lib/iptv'
import {
  formatClock,
  getContinueEntry,
  isEpisodeComplete,
  isLikelyPartialDuration,
  isRemuxFalseEnd,
  isTrustedDuration,
  isVodCategory,
  normalizeContinuePlayhead,
  removeContinueEntry,
  repairContinueWithRuntime,
  resolveTrustedRuntimeSeconds,
  upsertContinueEntry,
  FORCE_SAVE_CONTINUE_EVENT,
} from '../lib/continueWatching'
import {
  activeSkipInterval,
  resolveAnimeSkipIntervals,
  skipButtonLabel,
  type AnimeSkipInterval,
} from '../lib/animeSkip'
import { activeSubtitleText, parseSubtitleCues, type SubtitleCue } from '../lib/subtitles'
import { getPerformanceKnobs } from '../lib/deviceProfile'
import { hasRealDebridToken } from '../lib/debridSettings'
import {
  cleanShowDisplayTitle,
  fetchYtsRuntimeSeconds,
  isDebridHttpPlayUrl,
  parseEpisodeKey,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import { getViewingQuality, viewingQualityLabel } from '../lib/viewingQuality'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

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

function playerErrorHint(error: string, url: string | undefined): string {
  if (/no peers|no reachable seeds|swarm may be dead|unavailable/i.test(error)) {
    return 'This swarm looks dead or empty. Open Episodes and pick another release, or try a different quality.'
  }
  if (/taking too long|still starting|still buffering|not enough torrent|buffer ran dry/i.test(error)) {
    return 'Peers may be slow or the remux needs more data. Tap Retry, wait a moment, or try another episode or quality.'
  }
  if (isEphemeralLocalStreamUrl(url)) {
    return 'Torrent playback stalled. Tap Retry, wait for more peers, or try another episode or quality.'
  }
  return 'Status may show online while the stream still fails (DRM, expired token, or CDN block). Try another channel, use Web browser for YouTube / 1SpotMedia, or Refresh the playlist source.'
}

/** SxxExx (or similar) for a playlist row — not the 1-based list slot. */
function playlistEpisodeKey(entry: StreamPlaylistItem | undefined): string | null {
  if (!entry) return null
  return (
    entry.episodeKey ||
    parseEpisodeKey(entry.title || '') ||
    parseEpisodeKey(entry.fileName || '') ||
    null
  )
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
/** Failed torrent loads on one episode before auto-skipping to the next. */
const EPISODE_FAILS_BEFORE_SKIP = 3
/** Don't sit forever on magnet #1 when an alternate exists. */
const TORRENT_CANDIDATE_TIMEOUT_MS = 28_000
const DEAD_SWARM_RE =
  /no peers|no reachable seeds|swarm may be dead|unavailable|taking too long|timed? ?out|took too long/i

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(label))
    }, ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}
function pickEngines(url: string): Engine[] {
  const engines: Engine[] = []
  const hls = isHlsUrl(url)
  const ts = isMpegTsUrl(url)

  // Local torrent streams (webtorrent HTTP server) are plain progressive video
  if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(url) && !hls && !ts) {
    return ['native']
  }
  // Real-Debrid / Torrentio resolve links are progressive HTTP — skip HLS/TS probes.
  if (isDebridHttpPlayUrl(url) && !hls && !ts) {
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
  /** Hide black stage until the first frame / playing event. */
  const [mediaReady, setMediaReady] = useState(false)
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
  /** UI episode while Next/Prev resolves — playlistIndex only advances after a stream URL exists. */
  const [loadingPlaylistIndex, setLoadingPlaylistIndex] = useState<number | null>(null)
  const [subsEnabled, setSubsEnabled] = useState(true)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [subtitleLine, setSubtitleLine] = useState('')
  const [subsStatus, setSubsStatus] = useState<'idle' | 'loading' | 'ready' | 'missing'>('idle')
  /** Positive = delay subs (later); negative = show earlier. Fixes out-of-sync softsubs. */
  const [subtitleDelaySec, setSubtitleDelaySec] = useState(0)
  const subtitleDelayRef = useRef(0)
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
  /** Absolute title clock (remux video.currentTime is only the current fragment). */
  const [playbackClock, setPlaybackClock] = useState({ current: 0, duration: 0 })
  const [skipIntervals, setSkipIntervals] = useState<AnimeSkipInterval[]>([])
  const [skipTarget, setSkipTarget] = useState<AnimeSkipInterval | null>(null)
  const skipDismissedRef = useRef<string | null>(null)
  /** True while we paused to rebuild the remux lead buffer (not a user pause). */
  const leadBufferPauseRef = useRef(false)
  /** After the user hits Play, don't auto-pause again for a few seconds. */
  const leadBufferGraceUntilRef = useRef(0)
  const selectPlaylistItemRef = useRef<
    (index: number, options?: { force?: boolean; rotateTorrent?: boolean }) => Promise<void>
  >(async () => {})
  const episodeFailRef = useRef({ index: -1, fails: 0 })
  const episodeFailTimerRef = useRef(0)
  const episodeFailGenRef = useRef(0)
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
        : [
            {
              title: item.title,
              url: item.url,
              fileName: item.description,
              subtitleUrl: item.subtitleUrl,
              subtitleKind: item.subtitleKind,
            },
          ]
  const activePlaylistItem = playlist[Math.min(playlistIndex, playlist.length - 1)] ?? {
    title: item.title,
    url: item.url,
    subtitleUrl: item.subtitleUrl,
    subtitleKind: item.subtitleKind,
  }
  const uiPlaylistIndex =
    loadingPlaylistIndex != null && loadingPlaylistIndex >= 0 && loadingPlaylistIndex < playlist.length
      ? loadingPlaylistIndex
      : playlistIndex
  const uiPlaylistItem = playlist[uiPlaylistIndex] ?? activePlaylistItem
  const uiEpisodeKey = playlistEpisodeKey(uiPlaylistItem)
  /** Chrome / loading label — never a raw scene release filename. */
  const displayTitle = (() => {
    const seeded = item.title?.trim() || ''
    const show = (
      cleanShowDisplayTitle(seeded) ||
      cleanShowDisplayTitle(uiPlaylistItem.title || '') ||
      seeded
    )
      .replace(/\s*·\s*S\d{1,2}E\d{1,3}\s*$/i, '')
      .replace(/\s*·\s*$/g, '')
      .trim()
    if (show && uiEpisodeKey) return `${show} · ${uiEpisodeKey}`
    return show || seeded || 'Loading…'
  })()
  const episodesChipLabel = uiEpisodeKey
    ? `Episodes · ${uiEpisodeKey} · ${uiPlaylistIndex + 1}/${playlist.length}`
    : `Episodes · ${uiPlaylistIndex + 1}/${playlist.length}`
  const hasPlaylist = playlist.length > 1
  // Prefer the active episode's subs only — never fall back to episode 1's URL.
  const subtitleUrl = hasPlaylist
    ? activePlaylistItem.subtitleUrl
    : (activePlaylistItem.subtitleUrl ?? item.subtitleUrl)
  const subtitleKind = hasPlaylist
    ? activePlaylistItem.subtitleKind
    : (activePlaylistItem.subtitleKind ?? item.subtitleKind)
  // Companion files and embedded softsubs both get a Subs control once we have a URL.
  const showSubsLoading = subsStatus === 'loading' && Boolean(subtitleUrl)
  const showSubsControls = Boolean(subtitleUrl) && subsStatus !== 'missing'

  // Only re-bootstrap the episode list when a new play session starts.
  // Do not depend on runtimeSeconds — that used to snap Next back to episode 1.
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
      // Prefer the playlist row that already has the active stream URL (the
      // episode that was just started). Resume only when that row is unclear.
      const byUrl = list.findIndex((entry) => entry.url && entry.url === item.url)
      if (byUrl >= 0) {
        nextIndex = byUrl
      } else if (saved && saved.currentTime >= 5) {
        if (saved.episodeTitle) {
          const byTitle = list.findIndex((entry) => entry.title === saved.episodeTitle)
          if (byTitle >= 0) nextIndex = byTitle
          else nextIndex = Math.min(Math.max(0, saved.playlistIndex), maxIndex)
        } else {
          nextIndex = Math.min(Math.max(0, saved.playlistIndex), maxIndex)
        }
      }
    }
    setPlaylistIndex(nextIndex)
    // Start collapsed — user expands Episodes when they want the strip.
    setPlaylistOpen(false)
    playlistOpenRef.current = false
    setSubsEnabled(true)
    setEpisodeLoading(false)
    setLoadingPlaylistIndex(null)
    episodeFailRef.current = { index: -1, fails: 0 }
    episodeFailGenRef.current += 1
    if (episodeFailTimerRef.current) {
      window.clearTimeout(episodeFailTimerRef.current)
      episodeFailTimerRef.current = 0
    }
    resumeKeyRef.current = null
    timelineOffsetRef.current = 0
    setTimelineOffset(0)
    const runtimeHint = item.runtimeSeconds || saved?.runtimeSeconds || 0
    const repaired =
      saved && isTrustedDuration(runtimeHint)
        ? repairContinueWithRuntime(item.id, runtimeHint)
        : saved
    const resumeAt =
      repaired && repaired.playlistIndex === nextIndex && repaired.currentTime >= 5
        ? repaired.currentTime
        : null
    resumePendingRef.current = Boolean(resumeAt)
    watchClockRef.current = {
      lastTs: 0,
      accrued: resumeAt || 0,
    }
    setResumeOffer(resumeAt)
    setSkipIntervals([])
    setSkipTarget(null)
    skipDismissedRef.current = null
  }, [item.id, item.url])

  // When ffprobe/YTS runtime arrives (or is fetched), fold a bloated Resume (e.g. 2:49 → ~1:05).
  useEffect(() => {
    if (isTile) return
    let cancelled = false

    async function repairResume(runtime: number) {
      if (!isTrustedDuration(runtime) || cancelled) return
      const before = getContinueEntry(item.id)?.currentTime || 0
      const repaired = repairContinueWithRuntime(item.id, runtime)
      if (!repaired || repaired.currentTime < 5) {
        setResumeOffer(null)
        return
      }
      setResumeOffer(repaired.currentTime)
      if (watchClockRef.current.accrued > repaired.currentTime) {
        watchClockRef.current.accrued = repaired.currentTime
      }
      if (before - repaired.currentTime > 30) {
        flash(`Resume adjusted to ${formatClock(repaired.currentTime)}`)
      }
    }

    const known = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
    if (isTrustedDuration(known)) {
      void repairResume(known)
      return
    }

    const saved = getContinueEntry(item.id)
    const bloated = Boolean(saved && saved.currentTime > 90 * 60)
    if (!bloated) return
    const detail = item.detailUrl || saved?.detailUrl
    void fetchYtsRuntimeSeconds(detail).then((runtime) => {
      if (runtime) void repairResume(runtime)
    })

    return () => {
      cancelled = true
    }
  }, [isTile, item.id, item.runtimeSeconds, item.detailUrl])

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

  function effectivePlayhead(video: HTMLVideoElement): number {
    const absolute = absolutePlayhead(video)
    // Accrued wall-clock is only a gap-fill for brief remux glitches — never a
    // runaway past the media timeline (that produced Resume 2:49 on 1h45 films).
    const accrued = watchClockRef.current.accrued
    const blended = Math.max(absolute, Math.min(accrued, absolute + 45))
    const trusted = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
    if (isTrustedDuration(trusted)) {
      return Math.min(blended, trusted)
    }
    return blended
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
      // Cap accrued so stalled remux near a false EOF can't inflate forever.
      if (watchClockRef.current.accrued > absolute + 45) {
        watchClockRef.current.accrued = absolute + 45
      }
      const trusted = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
      if (isTrustedDuration(trusted) && watchClockRef.current.accrued > trusted) {
        watchClockRef.current.accrued = trusted
      }
    } else {
      watchClockRef.current.lastTs = 0
    }
  }

  function trustedRuntimeSeconds(
    playhead: number,
    reportedAbsolute: number,
    playbackUrl: string,
  ): number {
    const saved = getContinueEntry(item.id)
    return resolveTrustedRuntimeSeconds({
      runtimeSeconds: item.runtimeSeconds ?? saved?.runtimeSeconds,
      savedDuration: saved?.duration,
      reportedDuration: reportedAbsolute,
      playbackUrl,
      currentTime: playhead,
    })
  }

  function updatePlaybackClock(video: HTMLVideoElement) {
    const playbackUrl = activePlaylistItem.url || item.url || video.currentSrc
    const playhead = absolutePlayhead(video)
    const reported =
      Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
        ? video.duration + timelineOffsetRef.current
        : 0
    const trusted = trustedRuntimeSeconds(playhead, reported, playbackUrl)
    // Prefer full title length; never show a remux stub (e.g. 0:07) as the total.
    const duration =
      trusted ||
      (reported > playhead + 90 && !isLikelyPartialDuration(reported, playhead, { playbackUrl })
        ? reported
        : 0)
    setPlaybackClock((prev) =>
      Math.abs(prev.current - playhead) < 0.2 && prev.duration === duration
        ? prev
        : { current: playhead, duration },
    )
  }

  function bufferedLeadSeconds(video: HTMLVideoElement): number {
    try {
      if (!video.buffered.length) return 0
      const t = video.currentTime
      let end = 0
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (t >= video.buffered.start(i) - 0.1 && t <= video.buffered.end(i) + 0.1) {
          end = Math.max(end, video.buffered.end(i))
        }
      }
      if (end <= 0 && video.buffered.length > 0) {
        end = video.buffered.end(video.buffered.length - 1)
      }
      return Math.max(0, end - t)
    } catch {
      return 0
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
    const reportedAbsolute =
      reportedDuration > 0 ? reportedDuration + timelineOffsetRef.current : 0
    const currentTime = effectivePlayhead(video)
    if (restartGuardRef.current) {
      // Drop stale mid-episode ticks until the restarted stream is actually at the start.
      if (currentTime >= 5) return
      restartGuardRef.current = false
      return
    }
    const saved = getContinueEntry(item.id)
    const playbackUrl = activePlaylistItem.url || item.url || video.currentSrc
    const trusted = trustedRuntimeSeconds(currentTime, reportedAbsolute, playbackUrl)
    // Prefer authoritative runtime; never persist a remux buffer stub as "duration".
    let knownDuration = trusted
    if (!knownDuration) {
      knownDuration =
        reportedAbsolute >= 5 * 60
          ? reportedAbsolute
          : saved?.duration && saved.duration >= 5 * 60
            ? saved.duration
            : reportedAbsolute > 0
              ? reportedAbsolute
              : saved?.duration || 0
      if (
        isLikelyPartialDuration(knownDuration, currentTime, {
          assumeProgressive: true,
          playbackUrl,
        })
      ) {
        knownDuration = 0
      }
    }

    // Don't clobber a real resume point with ~0 while seek/remux restart is still pending.
    if (
      resumePendingRef.current &&
      saved &&
      currentTime + 10 < saved.currentTime
    ) {
      return
    }

    // Natural end clears — but remux often fires `ended` at a false buffer end.
    // With trusted runtime, only finish at ~95% of that length.
    const falseRemuxEnd =
      video.ended &&
      isRemuxFalseEnd(currentTime, reportedAbsolute || knownDuration, playbackUrl, trusted)
    const reallyDone =
      trusted > 0
        ? isEpisodeComplete(currentTime, trusted, { authoritative: true })
        : (video.ended && !falseRemuxEnd) ||
          (knownDuration > 0 &&
            isEpisodeComplete(currentTime, knownDuration, { playbackUrl }))
    if (reallyDone) {
      void import('../lib/watchHistory').then(({ recordWatchHistory }) => {
        recordWatchHistory({
          id: item.id,
          title: item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex,
          episodeTitle: hasPlaylist ? activePlaylistItem.title : undefined,
          currentTime,
          duration: trusted || knownDuration,
          runtimeSeconds: trusted || item.runtimeSeconds || saved?.runtimeSeconds,
          finished: true,
          torrentUri: item.torrentUri,
          detailUrl: item.detailUrl,
          playUrl: item.detailUrl || item.torrentUri,
          source: item.source,
        })
      })
      removeContinueEntry(item.id)
      return
    }
    if (falseRemuxEnd && !trusted) knownDuration = 0

    upsertContinueEntry(
      {
        id: item.id,
        title: item.title,
        poster: item.poster,
        category: item.category,
        playlistIndex,
        episodeTitle: hasPlaylist ? activePlaylistItem.title : undefined,
        currentTime,
        duration: trusted || knownDuration,
        runtimeSeconds: trusted || item.runtimeSeconds || saved?.runtimeSeconds,
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
      { allowUnknownDuration: true, playbackUrl },
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
    let target = resumeOffer
    if (!video || target == null || target < 5) return
    const runtimeHint = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
    if (isTrustedDuration(runtimeHint)) {
      const normalized = normalizeContinuePlayhead(target, runtimeHint)
      if (normalized.finished) {
        setResumeOffer(null)
        removeContinueEntry(item.id)
        flash('That resume point was past the end of the title')
        return
      }
      target = normalized.currentTime
      if (normalized.repaired) {
        setResumeOffer(target)
        repairContinueWithRuntime(item.id, runtimeHint)
      }
    }
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

    async function loadSubtitles() {
      // Wait for remux to claim the swarm first — early sub polls used to restart
      // ffmpeg extract on every 404 and starve slow SubsPlease peers.
      const remux = isRemuxPlaybackUrl(activePlaylistItem.url || item.url || '')
      const gateMs = remux ? 20_000 : 800
      const gateDeadline = Date.now() + gateMs
      while (!cancelled && Date.now() < gateDeadline) {
        const video = videoRef.current
        if (
          video &&
          !video.error &&
          (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime > 0.2)
        ) {
          break
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400))
      }
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
            const mediaDuration = Number(videoRef.current?.duration) || 0
            // Cues ending well before the title runtime means extract stalled mid-file.
            const cuesLookShort =
              mediaDuration > 120 && lastCueEnd > 0 && lastCueEnd < mediaDuration * 0.85

            // Only stop polling once extract is finished AND we're not about to run past
            // the last cue (progressive jobs sometimes flip "done" too early).
            if (extractDone && latestCount > 0 && playhead < lastCueEnd - 90 && !cuesLookShort) {
              await new Promise((resolve) => window.setTimeout(resolve, 5000))
              continue
            }
            if (
              extractDone &&
              latestCount > 0 &&
              lastCueEnd > 0 &&
              playhead >= lastCueEnd - 5 &&
              !cuesLookShort
            ) {
              break
            }

            // If playback is catching up to the last known cue, poll faster.
            if (lastCueEnd > 0 && playhead > lastCueEnd - 45) {
              await new Promise((resolve) => window.setTimeout(resolve, 800))
              continue
            }
          } else if (latestCount === 0 && response.status === 404) {
            const message = await response.text().catch(() => '')
            if (/no subtitle track/i.test(message)) {
              // Probe finished: this release has no softsubs — stop the loading spinner.
              break
            }
            if (/not ready|timed out|read failed|could not read/i.test(message)) {
              // Slow poll while remux owns the swarm.
              await new Promise((resolve) => window.setTimeout(resolve, 5000))
              continue
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
    // Each episode/release can have its own sync; don't carry delay across titles.
    subtitleDelayRef.current = 0
    setSubtitleDelaySec(0)
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
      // Subtract delay so positive delay pushes cues later (VLC-style).
      setSubtitleLine(
        activeSubtitleText(
          subtitleCues,
          absolutePlayhead(video) - subtitleDelayRef.current,
        ),
      )
    }

    syncCue()
    video.addEventListener('timeupdate', syncCue)
    video.addEventListener('seeked', syncCue)
    return () => {
      video.removeEventListener('timeupdate', syncCue)
      video.removeEventListener('seeked', syncCue)
    }
  }, [
    subtitleCues,
    subsEnabled,
    activePlaylistItem.url,
    playlistIndex,
    timelineOffset,
    subtitleDelaySec,
  ])

  function toggleSubtitles() {
    setSubsEnabled((on) => !on)
    bumpChrome()
  }

  function nudgeSubtitleDelay(delta: number) {
    const next = Math.round((subtitleDelayRef.current + delta) * 10) / 10
    const clamped = Math.max(-15, Math.min(15, next))
    subtitleDelayRef.current = clamped
    setSubtitleDelaySec(clamped)
    bumpChrome()
  }

  async function selectPlaylistItem(
    index: number,
    options?: { force?: boolean; rotateTorrent?: boolean },
  ) {
    if (index < 0 || index >= playlist.length || episodeLoading) return
    if (index === playlistIndex && !options?.force) return
    const entry = playlist[index]
    const episodeKey = playlistEpisodeKey(entry) || ''
    let baseCandidates = [entry.torrentUri, ...(entry.torrentAlternates || [])].filter(
      (uri, i, arr): uri is string => Boolean(uri) && arr.indexOf(uri) === i,
    )
    // Mid-playback stall: skip the dead release and try the next alternate first.
    if (options?.rotateTorrent && baseCandidates.length > 1) {
      baseCandidates = [...baseCandidates.slice(1), baseCandidates[0]!]
    }
    const useTorrentio =
      TORRENTIO_TV_TRIAL &&
      (item.category === 'series' || item.category === 'kids') &&
      /^S\d{1,2}E\d{1,3}$/i.test(episodeKey)
    // Always re-resolve torrent episodes. Sibling entries often still hold a
    // 127.0.0.1 remux URL from earlier, but torrentStop() kills that swarm —
    // reusing it shows "Native playback failed".
    const needsTorrent =
      (baseCandidates.length > 0 || useTorrentio) &&
      (options?.force ||
        !entry.url ||
        !/^https?:\/\//i.test(entry.url) ||
        isEphemeralLocalStreamUrl(entry.url))

    // Show the target episode in chrome immediately.
    setLoadingPlaylistIndex(index)
    if (episodeFailTimerRef.current) {
      window.clearTimeout(episodeFailTimerRef.current)
      episodeFailTimerRef.current = 0
    }
    const failGen = ++episodeFailGenRef.current

    const clearVideoSource = () => {
      const video = videoRef.current
      if (!video) return
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        /* ignore */
      }
    }

    const failOnEpisode = (message: string) => {
      setEpisodeLoading(false)
      setMediaReady(false)
      setLoadingPlaylistIndex(null)
      // Stay on the episode the user chose (don't snap back to episode 1).
      setPlaylistIndex(index)
      clearVideoSource()

      const dead = DEAD_SWARM_RE.test(message)
      if (!dead) {
        episodeFailRef.current = { index: -1, fails: 0 }
        setError(message)
        setStatus(message)
        return
      }

      const fails =
        episodeFailRef.current.index === index ? episodeFailRef.current.fails + 1 : 1
      episodeFailRef.current = { index, fails }

      if (fails < EPISODE_FAILS_BEFORE_SKIP) {
        setError(null)
        setStatus(`No peers — retrying (${fails}/${EPISODE_FAILS_BEFORE_SKIP})…`)
        episodeFailTimerRef.current = window.setTimeout(() => {
          if (episodeFailGenRef.current !== failGen) return
          void selectPlaylistItemRef.current(index, { force: true })
        }, 700)
        return
      }

      const next = index + 1
      if (next < playlist.length) {
        episodeFailRef.current = { index: -1, fails: 0 }
        const nextKey =
          playlistEpisodeKey(playlist[next]) || `episode ${next + 1}`
        setError(null)
        setStatus(`No peers — skipping to ${nextKey}…`)
        flash(`Skipping dead episode → ${nextKey}`)
        episodeFailTimerRef.current = window.setTimeout(() => {
          if (episodeFailGenRef.current !== failGen) return
          void selectPlaylistItemRef.current(next)
        }, 650)
        return
      }

      setError(message)
      setStatus(message)
    }

    if (needsTorrent) {
      if (!window.signalDesktop?.torrentStream) {
        failOnEpisode('Playback needs the Jiyu desktop app.')
        return
      }
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus(
        useTorrentio && hasRealDebridToken()
          ? 'Checking debrid streams…'
          : useTorrentio
            ? 'Checking more sources…'
            : 'Loading episode…',
      )
      setError(null)
      try {
        let candidates = baseCandidates
        if (useTorrentio) {
          const showName =
            cleanShowDisplayTitle(item.title) ||
            cleanShowDisplayTitle(entry.title) ||
            item.title
          const epChoice: EpisodeChoice = {
            key: episodeKey,
            title: entry.title,
            torrentUri: entry.torrentUri || baseCandidates[0] || '',
            quality: 0,
            alternates: entry.torrentAlternates,
          }
          candidates = await torrentUrisForEpisodeWithTorrentio(epChoice, showName, {
            enabled: true,
          })
          if (episodeFailGenRef.current !== failGen) return
        }
        if (candidates.length === 0) {
          failOnEpisode('No torrent link for this episode')
          return
        }

        // Episode switches: drop other swarms so a stuck prior release can't starve
        // this one. Multi-view keeps siblings alive via keepOthers.
        let result: TorrentStreamResult | null = null
        let usedUri = candidates[0]
        let lastError = 'Could not start episode'
        for (let i = 0; i < candidates.length; i++) {
          const uri = candidates[i]
          usedUri = uri
          if (isDebridHttpPlayUrl(uri)) {
            setStatus(
              candidates.length > 1
                ? `Starting debrid stream (${i + 1}/${candidates.length})…`
                : 'Starting debrid stream…',
            )
            result = { ok: true, url: uri }
            break
          }
          if (candidates.length > 1) {
            setStatus(`Loading episode… (${i + 1}/${candidates.length})`)
          } else {
            setStatus('Loading episode…')
          }
          let attempt: TorrentStreamResult
          try {
            attempt = await withTimeout(
              window.signalDesktop.torrentStream(uri, {
                keepOthers: inMultiview,
              }),
              TORRENT_CANDIDATE_TIMEOUT_MS,
              'Release took too long to start — trying another source.',
            )
          } catch (err) {
            lastError = err instanceof Error ? err.message : 'Could not start episode'
            if (i < candidates.length - 1) {
              setStatus(`Slow release — trying another (${i + 2}/${candidates.length})…`)
              try {
                const hash = /urn:btih:([a-z0-9]{32,40})/i.exec(uri)?.[1]
                if (hash) await window.signalDesktop.torrentStop?.(hash)
              } catch {
                /* ignore */
              }
              continue
            }
            break
          }
          if (attempt.ok && attempt.url) {
            result = attempt
            break
          }
          lastError = attempt.error || lastError
          if (i < candidates.length - 1 && DEAD_SWARM_RE.test(lastError)) {
            setStatus(`No peers — trying another release (${i + 2}/${candidates.length})…`)
            continue
          }
          if (i < candidates.length - 1) {
            setStatus(`Trying another release (${i + 2}/${candidates.length})…`)
            continue
          }
        }
        if (!result?.ok || !result.url) {
          failOnEpisode(lastError)
          return
        }
        if (episodeFailGenRef.current !== failGen) return
        setStatus('Starting playback…')

        const prevUri = activePlaylistItem.torrentUri || item.torrentUri || ''
        const prevHash = /urn:btih:([a-z0-9]{32,40})/i.exec(prevUri)?.[1]?.toLowerCase()
        const nextHash = /urn:btih:([a-z0-9]{32,40})/i.exec(usedUri)?.[1]?.toLowerCase()
        if (prevHash && prevHash !== nextHash) {
          await window.signalDesktop.torrentStop?.(prevHash)
        } else if (!prevHash && !inMultiview && prevUri && !isDebridHttpPlayUrl(usedUri)) {
          await window.signalDesktop.torrentStop?.()
        } else if (!inMultiview && isDebridHttpPlayUrl(usedUri) && prevHash) {
          await window.signalDesktop.torrentStop?.(prevHash)
        }

        setLocalPlaylist((prev) => {
          const base = prev ?? item.playlist ?? []
          return base.map((row, i) => {
            if (i === index) {
              return {
                ...row,
                url: result.url!,
                torrentUri: usedUri,
                torrentAlternates: candidates
                  .filter((cand) => cand !== usedUri)
                  .slice(0, 8),
                episodeKey: row.episodeKey || episodeKey || undefined,
                subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                fileName: result.fileName,
              }
            }
            // Invalidate dead local URLs after the swarm swap.
            if (isEphemeralLocalStreamUrl(row.url)) {
              return { ...row, url: '', subtitleUrl: undefined, subtitleKind: undefined }
            }
            return row
          })
        })
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not start episode')
        return
      }
      setEpisodeLoading(false)
    }

    // Success — clear dead-swarm retry state.
    episodeFailRef.current = { index: -1, fails: 0 }
    episodeFailGenRef.current += 1
    if (episodeFailTimerRef.current) {
      window.clearTimeout(episodeFailTimerRef.current)
      episodeFailTimerRef.current = 0
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
    setLoadingPlaylistIndex(null)
    setPlaylistOpenState(false)
    bumpChrome()
  }
  selectPlaylistItemRef.current = selectPlaylistItem

  function moveInPlaylist(delta: number) {
    void selectPlaylistItem(playlistIndex + delta)
  }

  function toggleMultiviewAdd() {
    if (awaitingAdd) {
      cancelMultiviewAdd()
      bumpChrome()
      return
    }
    armMultiviewAdd()
    flash('Multi-view: pick another channel')
    // Leave full player so shelves are reachable; PiP keeps the first stream.
    onClose()
  }

  function bumpChrome() {
    setChromeVisible(true)
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
    // Keep chrome up while the episode list is open, or until the first frame.
    if (playlistOpenRef.current || isPip || !mediaReady) return
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS)
  }

  function togglePlaylist() {
    const next = !playlistOpenRef.current
    setPlaylistOpenState(next)
    bumpChrome()
    if (next) {
      window.requestAnimationFrame(() => {
        document
          .querySelector('.player-episode-strip-item.is-active')
          ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
      })
    }
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
      // User wants playback — cancel lead-buffer auto-pause so we don't fight them.
      leadBufferPauseRef.current = false
      leadBufferGraceUntilRef.current = Date.now() + 8_000
      void video.play().then(
        () => {
          setPaused(false)
          setStatus('Playing')
          flash('Playing')
        },
        () => flash('Press play'),
      )
    } else {
      leadBufferPauseRef.current = false
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
    if (isPip && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
  }, [isPip])

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
      const levels = hls.levels
        .map((level, index) => ({ index, height: level.height || 0 }))
        .filter((level) => level.height > 0)
        .sort((a, b) => a.height - b.height)
      if (levels.length === 0) return
      // Auto: let HLS abr pick, but never above what this device should decode.
      const capHeight =
        preference === 'auto' ? getPerformanceKnobs().maxQuality : preference
      const selected =
        [...levels].reverse().find((level) => level.height <= capHeight) ?? levels[0]
      hls.autoLevelCapping = selected.index
      if (preference !== 'auto') {
        hls.currentLevel = selected.index
      } else {
        hls.currentLevel = -1
      }
      setEngineLabel(
        preference === 'auto'
          ? `hls · auto ≤${capHeight}p`
          : `hls · ${viewingQualityLabel(preference)}`,
      )
    }
    const onViewingQuality = () => applyHlsQuality()
    window.addEventListener('jiyu:viewing-quality', onViewingQuality)

    setError(null)
    setStatus('Connecting…')
    setEngineLabel('')
    setPaused(false)
    setMediaReady(false)

    let waitingSince = 0
    /** First moment this wait streak began — not reset by tiny buffer blips. */
    let waitingOrigin = 0
    let stallTimer: number | null = null
    let pausePrefetchTimer = 0
    let playPrefetchTimer = 0
    let leadBufferResumeTimer = 0
    const clearStallWatch = () => {
      waitingSince = 0
      waitingOrigin = 0
      if (stallTimer != null) {
        window.clearInterval(stallTimer)
        stallTimer = null
      }
    }
    function clearPausePrefetch() {
      if (pausePrefetchTimer) {
        window.clearInterval(pausePrefetchTimer)
        pausePrefetchTimer = 0
      }
    }
    function clearPlayPrefetch() {
      if (playPrefetchTimer) {
        window.clearInterval(playPrefetchTimer)
        playPrefetchTimer = 0
      }
    }
    function clearLeadBufferResume() {
      if (leadBufferResumeTimer) {
        window.clearInterval(leadBufferResumeTimer)
        leadBufferResumeTimer = 0
      }
    }
    function tryResumeAfterLeadBuffer() {
      if (cancelled || !leadBufferPauseRef.current) {
        clearLeadBufferResume()
        return
      }
      const el = videoRef.current
      if (!el) return
      const lead = bufferedLeadSeconds(el)
      // Resume as soon as there's a small playable cushion — don't wait for the
      // full remux lead target (that stranded playback until the user hit Play).
      if (lead < 1.25 && el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        kickTorrentPrefetch()
        return
      }
      leadBufferPauseRef.current = false
      clearLeadBufferResume()
      void el.play().then(
        () => {
          setPaused(false)
          setStatus('Playing')
        },
        () => {
          leadBufferPauseRef.current = true
          setStatus('Buffering…')
          startLeadBufferResume()
        },
      )
    }
    function startLeadBufferResume() {
      if (leadBufferResumeTimer) return
      kickTorrentPrefetch()
      leadBufferResumeTimer = window.setInterval(tryResumeAfterLeadBuffer, 400)
    }
    function kickTorrentPrefetch() {
      const hash = item.torrentInfoHash
      if (!hash || !window.signalDesktop?.torrentEnsureDownloading) return
      const playhead = effectivePlayhead(video)
      const reported =
        Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
          ? video.duration + timelineOffsetRef.current
          : 0
      const trusted = trustedRuntimeSeconds(playhead, reported, activePlaylistItem.url)
      // Ask for pieces ahead of the lead target so remux rarely runs dry.
      const lead = getPerformanceKnobs().remuxLeadSeconds
      void window.signalDesktop.torrentEnsureDownloading(
        hash,
        playhead + lead,
        trusted || undefined,
      )
    }

    const onPlay = () => {
      if (cancelled) return
      // Native controls / autoplay resume — give the buffer a moment before
      // the lead-buffer guard can pause again.
      if (leadBufferPauseRef.current) {
        leadBufferPauseRef.current = false
        leadBufferGraceUntilRef.current = Date.now() + 8_000
        clearLeadBufferResume()
      }
      setPaused(false)
    }

    const onPlaying = () => {
      if (!cancelled) {
        clearStallWatch()
        clearPausePrefetch()
        clearLeadBufferResume()
        leadBufferPauseRef.current = false
        setError(null)
        setStatus('Playing')
        setPaused(false)
        // Only dismiss the loading screen once frames are actually painting.
        // loadeddata alone was leaving a black stage with no title overlay.
        const el = videoRef.current
        if (el && el.videoWidth > 0) setMediaReady(true)
        // Keep torrent pieces ahead of the playhead while watching.
        kickTorrentPrefetch()
        clearPlayPrefetch()
        playPrefetchTimer = window.setInterval(
          kickTorrentPrefetch,
          getPerformanceKnobs().pausePrefetchMs,
        )
      }
    }
    const onWaiting = () => {
      if (cancelled) return
      setStatus('Buffering…')
      // Remux can spin forever when peers stall — surface a recoverable error.
      if (!isEphemeralLocalStreamUrl(activePlaylistItem.url)) return
      const now = Date.now()
      if (!waitingSince) waitingSince = now
      if (!waitingOrigin) waitingOrigin = now
      if (stallTimer != null) return
      // Soft limit: no meaningful buffer growth. Hard cap: never sit here for 15 minutes
      // because 0.25s blips kept resetting the soft timer.
      const perf = getPerformanceKnobs()
      const stallLimitMs = isRemuxPlaybackUrl(activePlaylistItem.url)
        ? perf.remuxStallMs
        : perf.localStallMs
      const hardCapMs = Math.max(stallLimitMs * 2, 120_000)
      let lastBufferedEnd = 0
      let bufferedAtOrigin = -1
      stallTimer = window.setInterval(() => {
        if (cancelled || !waitingSince || !waitingOrigin) return
        const videoEl = videoRef.current
        if (!videoEl) return
        if (!videoEl.paused && videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          clearStallWatch()
          setError(null)
          setStatus('Playing')
          return
        }
        let bufferedEnd = 0
        try {
          if (videoEl.buffered.length > 0) {
            bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1)
          }
        } catch {
          /* ignore */
        }
        if (bufferedAtOrigin < 0) bufferedAtOrigin = bufferedEnd
        // Swarm/remux still making progress — keep waiting, but don't erase the hard cap.
        if (bufferedEnd > lastBufferedEnd + 0.35) {
          lastBufferedEnd = bufferedEnd
          waitingSince = Date.now()
          setError(null)
          setStatus('Buffering…')
        }
        // Stuck on the last seconds of a false remux duration (e.g. 1:01:25 / 1:01:35).
        const duration = videoEl.duration
        if (
          isRemuxPlaybackUrl(activePlaylistItem.url) &&
          Number.isFinite(duration) &&
          duration > 0 &&
          videoEl.currentTime >= Math.max(0, duration - 3)
        ) {
          const playhead = effectivePlayhead(videoEl)
          const reported = remuxReportedAbsolute()
          const trusted = remuxTrustedRuntime(playhead, activePlaylistItem.url)
          if (isRemuxFalseEnd(playhead, reported, activePlaylistItem.url, trusted)) {
            clearStallWatch()
            if (continueRemuxPastGap('stall-eof')) return
          }
        }
        const softStalled = Date.now() - waitingSince >= stallLimitMs
        const hardStalled = Date.now() - waitingOrigin >= hardCapMs
        const almostNoLead = bufferedEnd - bufferedAtOrigin < 3
        if (!softStalled && !hardStalled) return
        if (hardStalled && !almostNoLead && !softStalled) return
        clearStallWatch()
        const hasAlt = (activePlaylistItem.torrentAlternates?.length || 0) > 0
        if (hasAlt) {
          setError(null)
          setStatus('Peers stalled — trying another release…')
          void selectPlaylistItemRef.current(playlistIndex, {
            force: true,
            rotateTorrent: true,
          })
          return
        }
        setError(
          isRemuxPlaybackUrl(activePlaylistItem.url)
            ? 'Still starting the stream — peers may be slow. Tap Resume if offered, or Retry / another quality.'
            : 'Still buffering after 45s — peers may be slow. Tap Retry, or try another episode/quality.',
        )
        setStatus('Buffering…')
      }, 1000)
    }
    let remuxRelays = 0
    let lastRelayPlayhead = 0
    let remuxContinueBusy = false
    const MAX_REMUX_RELAYS = 12

    function remuxReportedAbsolute() {
      return Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
        ? video.duration + timelineOffsetRef.current
        : 0
    }

    function remuxTrustedRuntime(playhead: number, playbackUrl: string) {
      return trustedRuntimeSeconds(playhead, remuxReportedAbsolute(), playbackUrl)
    }

    /** Restart remux from the current absolute playhead when the pipe dies early. */
    function continueRemuxPastGap(reason: string): boolean {
      if (cancelled || remuxContinueBusy) return false
      const playbackUrl = activePlaylistItem.url
      if (!isRemuxPlaybackUrl(playbackUrl)) return false
      // Use media timeline only — never the wall-clock accrued value.
      const playhead = absolutePlayhead(video)
      if (playhead < 5) return false
      const reported = remuxReportedAbsolute()
      const trusted = remuxTrustedRuntime(playhead, playbackUrl)
      if (!isRemuxFalseEnd(playhead, reported, playbackUrl, trusted)) return false
      if (isTrustedDuration(trusted) && playhead >= trusted * 0.92) return false

      if (playhead >= lastRelayPlayhead + 15) remuxRelays = 0
      // Re-ended almost immediately at the same spot after a relay → real EOF.
      const stuckAfterRelay = remuxRelays > 0 && playhead <= lastRelayPlayhead + 3
      if (stuckAfterRelay) return false
      if (remuxRelays >= MAX_REMUX_RELAYS) {
        setError(
          'Playback stopped mid-title — torrent buffer ran dry. Tap Retry, wait for more peers, or Restart.',
        )
        setStatus('Stopped')
        return true
      }

      remuxRelays += 1
      lastRelayPlayhead = playhead
      remuxContinueBusy = true
      saveContinueProgress()
      let resumeAt = Math.max(5, Math.floor(playhead) - 1)
      if (isTrustedDuration(trusted)) {
        resumeAt = Math.min(resumeAt, Math.floor(trusted * 0.9))
      }
      setTimelineOffsetSeconds(resumeAt)
      watchClockRef.current = { lastTs: 0, accrued: resumeAt }
      setStatus(reason === 'lead' ? 'Buffering ahead…' : 'Continuing stream…')
      flash(reason === 'lead' ? 'Building buffer ahead…' : 'Continuing past buffer…')
      setError(null)
      setPaused(false)
      console.info('[player] remux continue', { reason, resumeAt, remuxRelays })
      const baseUrl = stripResumeOffset(playbackUrl)
      video.src = withResumeOffset(baseUrl, resumeAt)
      video.load()
      void video.play().then(
        () => {
          remuxContinueBusy = false
          setStatus('Playing')
        },
        () => {
          remuxContinueBusy = false
          setStatus('Press play')
        },
      )
      return true
    }

    const onPause = () => {
      if (cancelled || remuxContinueBusy) return
      clearStallWatch()
      clearPlayPrefetch()
      // Our lead-buffer pause — don't treat as EOF / user pause.
      if (leadBufferPauseRef.current) {
        kickTorrentPrefetch()
        return
      }
      // Chromium often pauses at a false remux EOF without firing `ended`.
      const duration = video.duration
      const nearRelativeEnd =
        Number.isFinite(duration) &&
        duration > 0 &&
        (video.ended || video.currentTime >= Math.max(0, duration - 1.5))
      if (nearRelativeEnd) {
        const playhead = effectivePlayhead(video)
        const reported = remuxReportedAbsolute()
        const trusted = remuxTrustedRuntime(playhead, activePlaylistItem.url)
        if (
          isRemuxFalseEnd(playhead, reported, activePlaylistItem.url, trusted) &&
          continueRemuxPastGap('pause')
        ) {
          return
        }
      }
      setPaused(true)
      // Keep torrent pieces flowing while paused so resume isn't into a hole.
      kickTorrentPrefetch()
      clearPausePrefetch()
      pausePrefetchTimer = window.setInterval(
        kickTorrentPrefetch,
        getPerformanceKnobs().pausePrefetchMs,
      )
    }

    const onEnded = () => {
      // Torrent remux pipes often fire `ended` when the buffered fragment looks
      // like the full title or ffmpeg hits a download gap.
      if (continueRemuxPastGap('ended')) return

      const playhead = effectivePlayhead(video)
      const playbackUrl = activePlaylistItem.url
      const trusted = remuxTrustedRuntime(playhead, playbackUrl)
      saveContinueProgress()

      const nearEnd =
        isTrustedDuration(trusted) && playhead / trusted >= 0.9

      if (!cancelled && nearEnd && playlistIndex < playlist.length - 1) {
        // Re-resolve torrent URLs — don't just bump the index onto a dead remux link.
        void selectPlaylistItemRef.current(playlistIndex + 1)
      }
    }

    const onRemuxGuard = () => {
      if (cancelled || remuxContinueBusy) return
      const playbackUrl = activePlaylistItem.url
      if (!isRemuxPlaybackUrl(playbackUrl)) return
      updatePlaybackClock(video)

      const leadTarget = getPerformanceKnobs().remuxLeadSeconds
      const lead = bufferedLeadSeconds(video)
      const duration = video.duration
      const playhead = absolutePlayhead(video)
      const reported = remuxReportedAbsolute()
      const trusted = remuxTrustedRuntime(playhead, playbackUrl)
      const remuxLeft =
        Number.isFinite(duration) && duration > 0 ? duration - video.currentTime : 0

      // Prefetch pieces for the lead window — do NOT remux-restart early.
      // Restarting at remuxLeft<=10s looked like the episode "rewinding" on buffer.
      if (!video.paused && lead < leadTarget + 4) {
        kickTorrentPrefetch()
      }

      // Thin playable lead: pause briefly and rebuild — but only when critically
      // empty. A higher threshold caused a play→pause loop that needed manual Play.
      const inLeadGrace = Date.now() < leadBufferGraceUntilRef.current
      if (
        !inLeadGrace &&
        !video.paused &&
        !video.ended &&
        lead < 0.75 &&
        remuxLeft > 3 &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        leadBufferPauseRef.current = true
        kickTorrentPrefetch()
        video.pause()
        setStatus('Buffering…')
        // timeupdate stops while paused — poll to auto-resume.
        startLeadBufferResume()
        return
      }

      if (leadBufferPauseRef.current) {
        tryResumeAfterLeadBuffer()
      }

      if (!Number.isFinite(duration) || duration <= 0) return
      // Only relay at the true end of this remux fragment (not 10s early).
      if (video.currentTime < duration - 1.75) return
      if (isRemuxFalseEnd(playhead, reported, playbackUrl, trusted)) {
        continueRemuxPastGap('near-end')
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('timeupdate', onRemuxGuard)

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
          const remux = isRemuxPlaybackUrl(activePlaylistItem.url)
          reject(
            new Error(
              remux
                ? 'Playback stalled — not enough torrent data yet, or this file won’t remux. Try Retry or another quality.'
                : 'Native playback failed — stream offline, blocked, or unsupported.',
            ),
          )
        }

        const onReady = () => {
          if (settled) return
          cleanupReadyOnly()
          setStatus('Ready')
          // Always open at t=0. Offer Resume — never auto-seek mid-episode.
          if (resumeAt >= 5) {
            setResumeOffer(resumeAt)
            resumePendingRef.current = false
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
          reject(new Error('Stream took too long to start — try another source or quality.'))
        }

        // Remux on a slow torrent often needs >35s before the first fragment plays.
        const remux = isRemuxPlaybackUrl(activePlaylistItem.url)
        const loadBudgetMs = resumeAt >= 5 ? 28_000 : remux ? 75_000 : 35_000
        let loadTimer = window.setTimeout(onLoadTimeout, loadBudgetMs)

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
        const perf = getPerformanceKnobs()
        hls = new Hls({
          enableWorker: perf.enableMediaWorkers,
          lowLatencyMode: perf.hlsLowLatency,
          maxBufferLength: perf.hlsMaxBufferLength,
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
          const saved = getContinueEntry(item.id)
          if (saved && saved.playlistIndex === playlistIndex && saved.currentTime >= 5) {
            setResumeOffer(saved.currentTime)
            resumePendingRef.current = false
          }
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
            enableWorker: getPerformanceKnobs().enableMediaWorkers,
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
      if (!cancelled) {
        const hasAlt = (activePlaylistItem.torrentAlternates?.length || 0) > 0
        const slowStart = /took too long|timed? ?out|stalled|not enough torrent/i.test(lastError)
        if (hasAlt && slowStart) {
          setError(null)
          setStatus('Slow start — trying another release…')
          void selectPlaylistItemRef.current(playlistIndex, {
            force: true,
            rotateTorrent: true,
          })
          return
        }
        if (
          isEphemeralLocalStreamUrl(activePlaylistItem.url) &&
          /offline|blocked|unsupported/i.test(lastError)
        ) {
          setError(
            'Playback stalled — not enough torrent data yet, or this file won’t remux. Try Retry or another quality.',
          )
        } else {
          setError(lastError)
        }
      }
    })()

    return () => {
      cancelled = true
      clearStallWatch()
      clearPausePrefetch()
      clearPlayPrefetch()
      clearLeadBufferResume()
      leadBufferPauseRef.current = false
      saveContinueProgress()
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('timeupdate', onRemuxGuard)
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
      if (video) updatePlaybackClock(video)
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
          // Never auto-jump — always start at the beginning; Skip Intro is opt-in.
          setSkipTarget(active)
        } else {
          setSkipTarget(null)
        }
      }
    }
    const onPauseSave = () => persist()
    const onPageHide = () => persist()
    const onForceSave = () => persist()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    const onBeforeUnload = () => persist()

    const video = videoRef.current
    video?.addEventListener('timeupdate', onTimeUpdate)
    video?.addEventListener('pause', onPauseSave)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
    // Interval backup — timeupdate is unreliable on some remux streams, and the
    // video ref may not be ready on the first effect pass.
    const interval = window.setInterval(persist, 2500)

    return () => {
      persist()
      video?.removeEventListener('timeupdate', onTimeUpdate)
      video?.removeEventListener('pause', onPauseSave)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
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
          if (showSubsControls && subsStatus !== 'missing') {
            e.preventDefault()
            toggleSubtitles()
          }
          break
        case '[':
          if (showSubsControls && subsStatus === 'ready') {
            e.preventDefault()
            // Earlier — use when subs lag behind dialogue.
            nudgeSubtitleDelay(-0.5)
          }
          break
        case ']':
          if (showSubsControls && subsStatus === 'ready') {
            e.preventDefault()
            nudgeSubtitleDelay(0.5)
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
  }, [onClose, muted, volume, isTile, showSubsControls, subsStatus, subtitleDelaySec])

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
      className={`player-shell ${isPip ? 'player-shell-pip' : ''} ${chromeVisible || isPip || !mediaReady ? 'chrome-visible' : 'chrome-hidden'}`}
      role="dialog"
      aria-label={`Playing ${displayTitle}`}
      onMouseMove={isPip ? undefined : bumpChrome}
      onMouseEnter={isPip ? undefined : bumpChrome}
    >
      <header className={`player-bar player-chrome ${isPip ? 'pip-chrome' : ''}`}>
        <button type="button" className="ghost-btn player-back-btn" onClick={onClose}>
          {isPip ? '×' : '← Back'}
        </button>
        <div className="player-meta">
          <h2>{displayTitle}</h2>
          {!isPip && (
            <p className="player-meta-status">
              <span>
                {error ?? status}
                {!error && engineLabel ? ` · ${engineLabel}` : ''}
                {!error ? ` · ${muted ? 'Muted' : `Vol ${Math.round(volume * 100)}%`}` : ''}
                {!error && showSubsLoading ? ' · Loading subtitles…' : ''}
                {!error && subsStatus === 'missing' ? ' · No subs' : ''}
                {!error && subsStatus === 'ready'
                  ? ` · Subs ${subsEnabled ? 'on' : 'off'}${
                      subsEnabled && subtitleDelaySec !== 0
                        ? ` ${subtitleDelaySec > 0 ? '+' : ''}${subtitleDelaySec.toFixed(1)}s`
                        : ''
                    }`
                  : ''}
                {awaitingAdd ? ' · Multi-view: pick another channel' : ''}
              </span>
            </p>
          )}
          {hasPlaylist && !isPip && (
            <div className="player-episode-block">
              <button
                type="button"
                className={`player-episode-chip${playlistOpen ? ' is-open' : ''}`}
                onClick={togglePlaylist}
                aria-expanded={playlistOpen}
                aria-controls="player-episode-strip"
                title={playlistOpen ? 'Hide episodes' : 'Show episodes'}
              >
                {episodesChipLabel}
                <span aria-hidden>{playlistOpen ? ' ▴' : ' ▾'}</span>
              </button>
            </div>
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
              {showSubsControls && (
                <>
                  <button
                    type="button"
                    className={`ghost-btn control-btn${subsEnabled && subsStatus === 'ready' ? ' is-armed' : ''}`}
                    onClick={toggleSubtitles}
                    disabled={subsStatus === 'missing'}
                    title={
                      showSubsLoading
                        ? 'Detecting and loading the best subtitle track for this file…'
                        : subsStatus === 'missing'
                          ? 'No text subtitles on this release (image/PGS-only or none)'
                          : subsEnabled
                            ? 'Hide subtitles (C)'
                            : 'Show subtitles (C)'
                    }
                  >
                    {showSubsLoading
                      ? 'Subs…'
                      : subsStatus === 'missing'
                        ? 'No Subs'
                        : subsEnabled
                          ? 'Subs On'
                          : 'Subs Off'}
                  </button>
                  {subsStatus === 'ready' && subsEnabled && (
                    <span className="sub-sync-control" title="Subtitle sync — [ earlier, ] later">
                      <button
                        type="button"
                        className="ghost-btn control-btn sub-sync-btn"
                        onClick={() => nudgeSubtitleDelay(-0.5)}
                        title="Show subtitles earlier (subs behind) — ["
                      >
                        Subs −
                      </button>
                      <button
                        type="button"
                        className={`ghost-btn control-btn sub-sync-btn${subtitleDelaySec !== 0 ? ' is-armed' : ''}`}
                        onClick={() => {
                          subtitleDelayRef.current = 0
                          setSubtitleDelaySec(0)
                          bumpChrome()
                        }}
                        title="Click to reset sync offset"
                      >
                        {subtitleDelaySec === 0
                          ? '±0s'
                          : `${subtitleDelaySec > 0 ? '+' : ''}${subtitleDelaySec.toFixed(1)}s`}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn control-btn sub-sync-btn"
                        onClick={() => nudgeSubtitleDelay(0.5)}
                        title="Show subtitles later (subs ahead) — ]"
                      >
                        Subs +
                      </button>
                    </span>
                  )}
                </>
              )}
              {!inMultiview && (
                <button
                  type="button"
                  className={`ghost-btn control-btn${awaitingAdd ? ' is-armed' : ''}`}
                  onClick={toggleMultiviewAdd}
                  title={
                    awaitingAdd
                      ? 'Cancel — next channel will replace this one'
                      : item.transport === 'torrent' || item.sourceKind === 'torrent'
                        ? 'Add another stream beside this one (two torrents share bandwidth)'
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
            <button
              type="button"
              className="ghost-btn"
              disabled={episodeLoading}
              onClick={() => {
                const entry = playlist[playlistIndex]
                const canRetorrent = Boolean(entry?.torrentUri)
                if (canRetorrent) {
                  void selectPlaylistItem(playlistIndex, { force: true })
                  return
                }
                setRetryTick((n) => n + 1)
              }}
            >
              Retry
            </button>
          )}
        </div>
      </header>

      {hasPlaylist && playlistOpen && !isPip && (
        <div
          id="player-episode-strip"
          className="player-episode-strip"
          role="listbox"
          aria-label="Episodes"
        >
          <div className="player-episode-strip-scroll">
            {playlist.map((entry, index) => (
              <button
                key={`${entry.fileName ?? entry.torrentUri ?? entry.url}-${index}`}
                type="button"
                role="option"
                aria-selected={index === playlistIndex}
                className={`player-episode-strip-item${index === playlistIndex ? ' is-active' : ''}`}
                disabled={episodeLoading}
                title={entry.title || `Episode ${index + 1}`}
                onClick={() => void selectPlaylistItem(index)}
              >
                <span className="player-episode-strip-num">{index + 1}</span>
                <span className="player-episode-strip-title">
                  {entry.title || `Episode ${index + 1}`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="player-stage">
        <video
          ref={videoRef}
          className={`player-video${isRemuxPlaybackUrl(activePlaylistItem.url) ? ' is-remux' : ''}`}
          controls={!isPip}
          controlsList="nofullscreen nodownload noremoteplayback"
          disablePictureInPicture
          autoPlay
          playsInline
          onDoubleClick={isPip ? undefined : toggleFullscreen}
        />
        {!isPip && !error && (!mediaReady || episodeLoading) && (
          <PlaybackLoadingScreen
            title={displayTitle}
            status={
              status && status !== 'Playing' && status !== 'Ready'
                ? status
                : episodeLoading
                  ? 'Loading episode…'
                  : 'Starting playback…'
            }
            variant="stage"
          />
        )}
        {!isPip && (playbackClock.duration > 0 || playbackClock.current > 0) && (
          <div
            className="player-clock"
            title="Position in the full title (not the current remux fragment)"
          >
            <span>{formatClock(playbackClock.current)}</span>
            <span className="player-clock-sep">/</span>
            <span>
              {playbackClock.duration > 0 ? formatClock(playbackClock.duration) : '—:—'}
            </span>
          </div>
        )}
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
              {playerErrorHint(error, activePlaylistItem.url)}
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
