import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import { PlaybackLoadingScreen } from './PlaybackLoadingScreen'
import { VolumeSlider } from './VolumeSlider'
import { SeekSkipOverlay } from './SeekSkipOverlay'
import { isHlsUrl, isMpegTsUrl } from '../lib/iptv'
import { androidHlsConfig } from '../lib/hlsAndroid'
import {
  enterOsFullscreen,
  exitOsFullscreen,
  getFullscreenOwner,
  syncFullscreenOwnerFromOs,
  webSurfaceOwnsFullscreen,
} from '../lib/fullscreenSession'
import { nativeFetchText } from '../lib/nativeHttp'
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
  animeSearchTitle,
  resolveAnimeSkipIntervals,
  skipButtonLabel,
  type AnimeSkipInterval,
} from '../lib/animeSkip'
import { recordUserSeekJump, getLearnedSkipInterval } from '../lib/skipLearning'
import { recordPlaybackHealth } from '../lib/streamLearning'
import {
  activeSubtitleText,
  isJunkSubtitleText,
  parseSubtitleCues,
  type SubtitleCue,
} from '../lib/subtitles'
import { getPerformanceKnobs } from '../lib/deviceProfile'
import { hasRealDebridToken } from '../lib/debridSettings'
import {
  cleanShowDisplayTitle,
  fetchYtsRuntimeSeconds,
  isCinetaroCatalogItem,
  isDebridHttpPlayUrl,
  isM2BoxCatalogItem,
  isNetMirrorCatalogItem,
  isTmdbTvCatalogItem,
  isYmoviesCatalogItem,
  parseEpisodeKey,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { resolveM2BoxPlay } from '../lib/m2box'
import {
  lookupRivestreamTmdbId,
  rivestreamTmdbIdFromItem,
  shouldPreferRivestreamJapaneseAudio,
} from '../lib/rivestream'
import { resolveMovyPlay, MOVY_PLAY_REFERER, probeMovyHlsUrl } from '../lib/movy'
import {
  ATLANTIC_PLAY_REFERER,
  isMovyStreamUrl,
  resolveAtlanticPlay,
} from '../lib/atlanticHls'
import { isWyzieAvailable, resolveWyzieSubtitle } from '../lib/wyzie'
import {
  estimateSubtitleDelay,
  isSubtitleAutoSyncAvailable,
} from '../lib/subtitleAutoSync'
import {
  nyaaTorrentCandidates,
  resolveNyaaEpisodePlay,
  resolveNyaaSubtitleSidecar,
  shouldTryNyaaForItem,
} from '../lib/nyaa'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import {
  getViewingQuality,
  resolveRequestedQuality,
  viewingQualityLabel,
} from '../lib/viewingQuality'
import {
  clearWatchNext,
  getWatchNext,
  subscribeWatchNext,
  takeWatchNext,
  type WatchNextEntry,
} from '../lib/watchNext'
import { isAndroidShell } from '../lib/androidFullscreen'
import {
  androidCastAvailable,
  androidCastGetState,
  androidCastMedia,
  androidCastStop,
  androidOpenScreenCastSettings,
  castModeForPlayback,
  isAndroidCastHost,
  isCastableMediaUrl,
  onAndroidCastState,
} from '../lib/androidCast'
import {
  isAndroidTorrentAvailable,
  isTorrentPlaybackAvailable,
  torrentEnsureDownloading,
  torrentStop,
  torrentStream,
} from '../lib/torrentBridge'
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

/**
 * Consistent autoplay: try unmuted first, then muted→unmute (browser policy).
 * Returns whether playback is running (or a play() promise was started).
 */
async function ensureVideoAutoplay(
  video: HTMLVideoElement,
  options?: { preferMuted?: boolean },
): Promise<boolean> {
  if (!video) return false
  if (!video.paused && !video.ended) return true
  const preferMuted = Boolean(options?.preferMuted)
  const tryPlay = async (muted: boolean) => {
    const wasMuted = video.muted
    if (muted) video.muted = true
    try {
      await video.play()
      if (!preferMuted && muted && !wasMuted) {
        // Unmute after playback is allowed.
        video.muted = false
      }
      return true
    } catch {
      if (muted) video.muted = wasMuted
      return false
    }
  }
  if (!preferMuted && (await tryPlay(false))) return true
  if (await tryPlay(true)) return true
  return false
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

function torrentStallMessage(): string {
  if (isAndroidTorrentAvailable()) {
    return 'Playback stalled — not enough torrent data yet. Tap Retry, wait for more peers, or try another quality.'
  }
  return 'Playback stalled — not enough torrent data yet, or this file won’t remux. Try Retry or another quality.'
}

function playerErrorHint(error: string, url: string | undefined): string {
  if (/no peers|no reachable seeds|swarm may be dead|unavailable/i.test(error)) {
    return 'This swarm looks dead or empty. Open Episodes and pick another release, or try a different quality.'
  }
  if (/taking too long|still starting|still buffering|not enough torrent|buffer ran dry/i.test(error)) {
    if (isAndroidTorrentAvailable()) {
      return 'Peers may be slow or the download needs more data. Tap Retry, wait a moment, or try another episode or quality.'
    }
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
const VOLUME_MIGRATE_KEY = 'jiyu.player.volume.unity'
const MUTE_KEY = 'jiyu.player.muted'
/** In-app volume ceiling (native <video> max). At 100%, loudness matches the OS mixer. */
const VOLUME_MAX = 1
const VOLUME_STEP = 0.05
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
  // Signed progressive MP4 (e.g. M2Box CDN) — skip HLS/TS probes.
  if (/\.mp4(\?|#|$)/i.test(url) && !hls && !ts) {
    return ['native']
  }

  // Android WebView often plays HLS more reliably via MSE/hls.js than native m3u8.
  // Prefer hls first; native remains a fallback for Safari-style WebViews.
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
    // One-time reset: scroll-wheel volume was easy to leave far below 100%, so
    // Jiyu sounded quieter than other apps at the same Windows level.
    if (localStorage.getItem(VOLUME_MIGRATE_KEY) !== '1') {
      localStorage.setItem(VOLUME_MIGRATE_KEY, '1')
      localStorage.setItem(VOLUME_KEY, '1')
      return 1
    }
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw == null) return 1
    const n = Number(raw)
    // Older builds could store >1 for soft-boost — clamp to native max.
    return Number.isFinite(n) ? Math.min(VOLUME_MAX, Math.max(0, n)) : 1
  } catch {
    return 1
  }
}

function formatVolumeLabel(level: number, isMuted: boolean): string {
  if (isMuted) return 'Muted'
  const pct = Math.round(level * 100)
  return pct >= 100 ? `Volume ${pct}% · system` : `Volume ${pct}%`
}

function loadSavedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Bump when audio-path logic changes so Fast Refresh remounts <video>
 * even if React state is preserved (unsticks stolen-element silence).
 */
const AUDIO_PIPELINE_REV = 10

export function Player({
  item,
  onClose,
  onExpand,
  onSpotlight,
  layout = 'full',
  isPrimary = true,
}: PlayerProps) {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [watchNext, setWatchNextState] = useState<WatchNextEntry | null>(() => getWatchNext())
  const watchNextRef = useRef<WatchNextEntry | null>(watchNext)
  watchNextRef.current = watchNext

  useEffect(() => subscribeWatchNext(setWatchNextState), [])

  useEffect(() => {
    const queued = getWatchNext()
    if (queued && queued.id === item.id) clearWatchNext()
  }, [item.id])

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
  const [castAvailable, setCastAvailable] = useState(false)
  const [casting, setCasting] = useState(false)
  const [castDevice, setCastDevice] = useState('')
  const [chromeVisible, setChromeVisible] = useState(true)
  const [osFullScreen, setOsFullScreen] = useState(false)
  const osFullScreenRef = useRef(false)
  const [fittedVideo, setFittedVideo] = useState<{ width: number; height: number } | null>(null)
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
  /** Bump to re-fetch / force sidecar .srt extract (Subs button). */
  const [subsFetchTick, setSubsFetchTick] = useState(0)
  const subsEnabledRef = useRef(true)
  subsEnabledRef.current = subsEnabled
  /** Positive = delay subs (later); negative = show earlier. Fixes out-of-sync softsubs. */
  const [subtitleDelaySec, setSubtitleDelaySec] = useState(0)
  const subtitleDelayRef = useRef(0)
  const [autoSyncRunning, setAutoSyncRunning] = useState(false)
  const movySubsSidecarRef = useRef('')
  /** After Wyzie free-plan ad dump, skip Wyzie and prefer Nyaa softsubs. */
  const skipWyzieSubsRef = useRef(false)
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
  /** Movy → Atlantic mid-playback stall fallback (TMDB meta captured when Movy resolves). */
  const hlsFallbackMetaRef = useRef<{
    tmdbId: string
    mediaType: 'movie' | 'tv'
    season?: number
    episode?: number
    title: string
    tried: boolean
    busy: boolean
  } | null>(null)
  const tryHlsFallbackRef = useRef<(resumeAt: number) => Promise<boolean>>(async () => false)
  /** Prefer over item.httpReferrer so Android/desktop HLS loaders get Movy/Atlantic Referer. */
  const activePlaybackReferrerRef = useRef(item.httpReferrer || '')
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
  // Playback effect must not close over stale volume — buffer→playing was jumping to 100%.
  const volumeRef = useRef(volume)
  const effectiveMutedRef = useRef(effectiveMuted)
  const isPrimaryRef = useRef(isPrimary)
  volumeRef.current = volume
  effectiveMutedRef.current = effectiveMuted
  isPrimaryRef.current = isPrimary
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

  useEffect(() => {
    if (item.httpReferrer) activePlaybackReferrerRef.current = item.httpReferrer
  }, [item.httpReferrer])

  // Arm Atlantic fallback when Player opens on an already-resolved Movy URL (ShowPage path).
  useEffect(() => {
    const url = activePlaylistItem.url || item.url || ''
    const lookslikeMovy =
      isMovyStreamUrl(url) ||
      item.httpReferrer === MOVY_PLAY_REFERER ||
      /movy\.sx/i.test(String(item.httpReferrer || ''))
    const lookslikeAtlantic =
      /totallyacdn|cdn\.hls\.lol|stream\.hls\.lol|transcode\.cfd|atlantic\.st/i.test(url) ||
      item.httpReferrer === ATLANTIC_PLAY_REFERER ||
      /atlantic/i.test(String(item.tags?.join(' ') || ''))
    if (!lookslikeMovy && !lookslikeAtlantic) return
    const tmdbId = rivestreamTmdbIdFromItem(item)
    if (!tmdbId) return
    const epKey = playlistEpisodeKey(activePlaylistItem) || parseEpisodeKey(item.title) || ''
    const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(epKey)
    const season = seMatch ? Number(seMatch[1]) : 1
    const episode = seMatch ? Number(seMatch[2]) : playlistIndex + 1
    const existing = hlsFallbackMetaRef.current
    if (
      existing &&
      existing.tmdbId === tmdbId &&
      existing.season === season &&
      existing.episode === episode
    ) {
      if (lookslikeAtlantic) existing.tried = true
      return
    }
    hlsFallbackMetaRef.current = {
      tmdbId,
      mediaType: 'tv',
      season,
      episode,
      title: cleanShowDisplayTitle(item.title) || item.title,
      tried: lookslikeAtlantic,
      busy: false,
    }
    if (!activePlaybackReferrerRef.current) {
      activePlaybackReferrerRef.current =
        item.httpReferrer ||
        (lookslikeAtlantic ? ATLANTIC_PLAY_REFERER : MOVY_PLAY_REFERER)
    }
  }, [item, activePlaylistItem, playlistIndex])

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
  const subtitleUrl = activePlaylistItem.subtitleUrl ?? item.subtitleUrl
  const subtitleKind = activePlaylistItem.subtitleKind ?? item.subtitleKind
  // Companion files and embedded softsubs both get a Subs control once we have a URL.
  const showSubsLoading = subsStatus === 'loading' && Boolean(subtitleUrl)
  const showSubsControls = Boolean(subtitleUrl)
  const videoMountKey = `v${AUDIO_PIPELINE_REV}-${item.id}-${activePlaylistItem.url ?? ''}`

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
      } else {
        const titleKey = parseEpisodeKey(item.title) || parseEpisodeKey(saved?.episodeTitle || '')
        const byKey = titleKey
          ? list.findIndex(
              (entry) =>
                (entry.episodeKey && entry.episodeKey === titleKey) ||
                parseEpisodeKey(entry.title) === titleKey,
            )
          : -1
        if (byKey >= 0) {
          nextIndex = byKey
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

  useEffect(() => {
    if (!isAndroidCastHost() || isPip || isTile) {
      setCastAvailable(false)
      return
    }
    let alive = true
    void androidCastAvailable().then((ok) => {
      if (alive) setCastAvailable(ok)
    })
    void androidCastGetState().then((state) => {
      if (!alive) return
      setCasting(Boolean(state.casting))
      setCastDevice(String(state.deviceName || ''))
    })
    const off = onAndroidCastState((state) => {
      setCasting(Boolean(state.casting))
      setCastDevice(String(state.deviceName || ''))
    })
    return () => {
      alive = false
      off()
    }
  }, [isPip, isTile, item.id])

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
    if (isTile || isPip) {
      setSkipIntervals([])
      setSkipTarget(null)
      return
    }

    // Series: only habit-learned intros (no AniSkip / default guess).
    if (item.category === 'series') {
      const learned = getLearnedSkipInterval(animeSearchTitle(item.title))
      setSkipIntervals(learned ? [learned] : [])
      setSkipTarget(null)
      return
    }

    if (item.category !== 'anime') {
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

  // On-device stream reliability: sustained play, stalls, fatal errors.
  useEffect(() => {
    if (isTile) return
    const video = videoRef.current
    if (!video) return
    const key = activePlaylistItem.url || item.url || item.source || item.id
    if (!key) return

    let started = false
    let sustained = false
    let waitingSince = 0
    let stallTimer = 0
    let sustainedTimer = 0

    const onPlaying = () => {
      if (!started) {
        started = true
        recordPlaybackHealth(key, 'started')
      }
      waitingSince = 0
      if (stallTimer) {
        window.clearTimeout(stallTimer)
        stallTimer = 0
      }
      if (!sustained && !sustainedTimer) {
        sustainedTimer = window.setTimeout(() => {
          sustainedTimer = 0
          if (!sustained && !video.paused && !video.ended) {
            sustained = true
            recordPlaybackHealth(key, 'sustained')
          }
        }, 30_000)
      }
    }

    const onWaiting = () => {
      if (!started || video.ended) return
      waitingSince = Date.now()
      if (stallTimer) window.clearTimeout(stallTimer)
      stallTimer = window.setTimeout(() => {
        stallTimer = 0
        if (waitingSince && Date.now() - waitingSince >= 2000 && !video.paused) {
          recordPlaybackHealth(key, 'stall')
        }
      }, 2200)
    }

    const onError = () => {
      recordPlaybackHealth(key, 'fatal')
    }

    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('error', onError)
      if (stallTimer) window.clearTimeout(stallTimer)
      if (sustainedTimer) window.clearTimeout(sustainedTimer)
    }
  }, [
    isTile,
    item.id,
    item.url,
    item.source,
    activePlaylistItem.url,
    retryTick,
  ])

  // Habit-based intro skip: learn forward seeks in the first ~5 minutes (series/anime).
  useEffect(() => {
    if (isTile || isPip) return
    if (item.category !== 'anime' && item.category !== 'series') return
    const video = videoRef.current
    if (!video) return

    const showKey = animeSearchTitle(item.title, activePlaylistItem.title || item.title)
    let seekFrom: number | null = null

    const onSeeking = () => {
      seekFrom = effectivePlayhead(video)
    }
    const onSeeked = () => {
      if (seekFrom == null) return
      const to = effectivePlayhead(video)
      const from = seekFrom
      seekFrom = null
      const learned = recordUserSeekJump(showKey, from, to)
      if (learned && item.category === 'series') {
        const interval = getLearnedSkipInterval(showKey)
        if (interval) setSkipIntervals([interval])
      }
    }

    video.addEventListener('seeking', onSeeking)
    video.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('seeked', onSeeked)
    }
  }, [
    isTile,
    isPip,
    item.category,
    item.id,
    item.title,
    activePlaylistItem.title,
    retryTick,
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
    try {
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
        // Playback may use transport "direct" (remux/HLS URL) — keep torrent/show
        // identity so Continue → resume can rebuild the episode playlist.
        transport:
          item.torrentUri || item.sourceKind === 'torrent' ? 'torrent' : item.transport,
        sourceKind:
          item.sourceKind ||
          (item.torrentUri || item.transport === 'torrent' ? 'torrent' : undefined),
        source: item.source,
      },
      { allowUnknownDuration: true, playbackUrl },
    )
    } catch (err) {
      console.warn('Continue watching progress save failed:', err)
    }
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
      const fallBackToStart = (message: string) => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('canplay', onReady)
        video.removeEventListener('error', onResumeError)
        setTimelineOffsetSeconds(0)
        setResumeOffer(target)
        setError(null)
        video.src = baseUrl
        video.load()
        void video.play().catch(() => undefined)
        setStatus('Starting from the beginning…')
        flash(message)
      }
      const failTimer = window.setTimeout(() => {
        fallBackToStart('Resume not buffered yet — started from the beginning')
      }, 22_000)
      const onReady = () => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('canplay', onReady)
        video.removeEventListener('error', onResumeError)
        setResumeOffer(null)
        setError(null)
        setStatus('Ready')
        flash(`Resumed at ${formatClock(target)}`)
        void video.play().catch(() => undefined)
      }
      const onResumeError = () => {
        fallBackToStart('Resume point not ready yet — playing from the start')
      }
      video.addEventListener('loadeddata', onReady)
      video.addEventListener('canplay', onReady)
      video.addEventListener('error', onResumeError)
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
    // Keep existing cues visible during a manual re-fetch so toggle doesn't blank the screen.
    if (subsFetchTick === 0 || subtitleCues.length === 0) {
      setSubtitleCues([])
      setSubtitleLine('')
    }

    if (!subtitleUrl) {
      setSubsStatus('idle')
      return
    }

    setSubsStatus((prev) => (prev === 'ready' && subtitleCues.length > 0 ? prev : 'loading'))
    const startedAt = Date.now()
    // Keep refreshing for a long time — progressive extract fills cues as the
    // torrent downloads; stopping early makes subs vanish mid-episode.
    const maxWaitMs = 3 * 60 * 60 * 1000
    let latestCount = 0
    let lastCueEnd = 0
    const sidecar = subtitleKind === 'file' || /^https?:\/\//i.test(subtitleUrl)
    const remoteSidecar =
      sidecar && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(subtitleUrl)

    async function loadSubtitles() {
      // Companion .srt: poll immediately. Embedded: wait for remux to claim the swarm.
      const remux = isRemuxPlaybackUrl(activePlaylistItem.url || item.url || '')
      const gateMs = sidecar ? 200 : remux ? 20_000 : 800
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
        await new Promise((resolve) => window.setTimeout(resolve, 200))
      }
      if (cancelled) return

      let forceOnce = subsFetchTick > 0
      while (!cancelled && Date.now() - startedAt < maxWaitMs) {
        try {
          const sep = subtitleUrl!.includes('?') ? '&' : '?'
          const force = forceOnce ? '&force=1' : ''
          forceOnce = false
          let text = ''
          let ok = false
          let extractDone = false
          let httpStatus = 0
          let httpBody = ''

          // Remote softsubs (Rive VTT/SRT): go through the native/Electron bridge first
          // so CORS / missing Referer cannot silently leave Subs Off forever.
          if (remoteSidecar) {
            try {
              const remote = await nativeFetchText(subtitleUrl!, {
                quiet: true,
                headers: {
                  Accept: 'text/vtt,text/plain,application/x-subrip,*/*',
                  Referer: 'https://rivestream.ru/',
                  Origin: 'https://rivestream.ru',
                },
              })
              if (remote.ok && remote.content) {
                text = remote.content
                ok = true
                extractDone = true
                httpStatus = remote.status || 200
              } else {
                httpStatus = remote.status || 0
                httpBody = remote.error || ''
              }
            } catch {
              /* fall through to window.fetch */
            }
          }

          if (!ok) {
            try {
              const response = await fetch(`${subtitleUrl}${sep}t=${Date.now()}${force}`)
              httpStatus = response.status
              if (response.ok) {
                text = await response.text()
                ok = true
                extractDone = response.headers.get('X-Jiyu-Subs-Done') === '1'
              } else {
                httpBody = await response.text().catch(() => '')
              }
            } catch {
              /* CORS / network */
            }
          }
          if (ok) {
            const cues = parseSubtitleCues(text)
            // Wyzie free-plan ad dump — drop and let Nyaa / next source try.
            if (sidecar && cues.length === 0 && isJunkSubtitleText(text)) {
              if (!cancelled) {
                setSubtitleCues([])
                setSubsStatus('missing')
                skipWyzieSubsRef.current = true
                movySubsSidecarRef.current = ''
                setLocalPlaylist((prev) => {
                  const base = prev ?? item.playlist ?? []
                  return base.map((row, i) =>
                    i === playlistIndex
                      ? { ...row, subtitleUrl: undefined, subtitleKind: undefined }
                      : row,
                  )
                })
                flash('Skipping ad subtitles…')
              }
              break
            }
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
                lastCueEnd = cues.reduce((max, cue) => Math.max(max, cue.end), 0)
                if (!cancelled) {
                  setSubtitleCues(cues)
                  setSubsStatus('ready')
                }
              }
            }
            const playhead = videoRef.current ? absolutePlayhead(videoRef.current) : 0
            const mediaDuration = Number(videoRef.current?.duration) || 0
            // Cues ending well before the title runtime means extract stalled mid-file.
            const cuesLookShort =
              !sidecar &&
              mediaDuration > 120 &&
              lastCueEnd > 0 &&
              lastCueEnd < mediaDuration * 0.85

            // Sidecar files are complete once we have cues + done (or any cues).
            if (sidecar && latestCount > 0 && (extractDone || latestCount > 20)) {
              break
            }

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
          } else if (latestCount === 0 && httpStatus === 404) {
            if (/no subtitle track/i.test(httpBody)) {
              // Probe finished: this release has no softsubs — stop the loading spinner.
              break
            }
            if (/not ready|timed out|read failed|could not read/i.test(httpBody)) {
              await new Promise((resolve) => window.setTimeout(resolve, sidecar ? 800 : 5000))
              continue
            }
          }
        } catch {
          /* retry while torrent pieces / ffmpeg catch up */
        }
        // Keep polling even after "done" if cues look short for a long title —
        // progressive extract often resumes after an early EOF.
        await new Promise((resolve) => window.setTimeout(resolve, sidecar ? 700 : 2000))
      }
      if (!cancelled && latestCount === 0) setSubsStatus('missing')
    }

    void loadSubtitles()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subtitleCues only used to avoid blanking on manual refetch
  }, [subtitleUrl, subtitleKind, playlistIndex, subsFetchTick])

  /** Movy / Atlantic HLS often has no captions — Wyzie first, then Nyaa softsubs. */
  useEffect(() => {
    if (subtitleUrl) return
    const isMovyPlay =
      item.tags?.some((t) => /^movy$/i.test(String(t))) ||
      item.httpReferrer === MOVY_PLAY_REFERER ||
      /movy\.sx/i.test(String(item.httpReferrer || ''))
    const isAtlanticPlay =
      item.tags?.some((t) => /^atlantic$/i.test(String(t))) ||
      item.httpReferrer === ATLANTIC_PLAY_REFERER ||
      /atlantic|totallyacdn|hls\.lol/i.test(
        String(item.httpReferrer || activePlaybackReferrerRef.current || ''),
      )
    if (!isMovyPlay && !isAtlanticPlay && !rivestreamTmdbIdFromItem(item)) return

    const tmdbId = rivestreamTmdbIdFromItem(item)
    const canWyzie = Boolean(tmdbId && isWyzieAvailable() && !skipWyzieSubsRef.current)
    const canNyaa =
      isTorrentPlaybackAvailable() &&
      (shouldTryNyaaForItem(item) ||
        item.category === 'series' ||
        item.category === 'kids' ||
        Boolean(item.rivestreamTmdbId) ||
        Boolean(tmdbId))
    if (!canWyzie && !canNyaa) return

    const epKey = playlistEpisodeKey(activePlaylistItem) || ''
    const sidecarKey = `${item.id}|${playlistIndex}|${epKey}`
    if (movySubsSidecarRef.current === sidecarKey) return
    movySubsSidecarRef.current = sidecarKey

    const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(epKey)
    const season = seMatch ? Number(seMatch[1]) : 1
    const episode = seMatch ? Number(seMatch[2]) : playlistIndex + 1
    const showName = cleanShowDisplayTitle(item.title) || item.title

    let settled = false
    let cancelled = false

    const applySubs = (url: string, kind?: 'file' | 'embedded', label = 'Subtitles ready') => {
      if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
      setLocalPlaylist((prev) => {
        const base = prev ?? item.playlist ?? []
        return base.map((row, i) =>
          i === playlistIndex
            ? {
                ...row,
                subtitleUrl: url,
                subtitleKind: kind,
              }
            : row,
        )
      })
      setSubsFetchTick((n) => n + 1)
      flash(label)
    }

    ;(async () => {
      try {
        if (canWyzie && tmdbId) {
          flash('Finding subtitles…')
          const wyzie = await resolveWyzieSubtitle({ tmdbId, season, episode })
          if (cancelled) return
          if (wyzie.ok) {
            settled = true
            applySubs(wyzie.subtitleUrl, wyzie.subtitleKind, 'Subtitles ready (Wyzie)')
            return
          }
        }
        if (!canNyaa) {
          settled = true
          if (!cancelled && movySubsSidecarRef.current === sidecarKey) {
            flash('No subtitles for this episode')
          }
          return
        }
        flash('Finding subtitles from Nyaa…')
        const subs = await resolveNyaaSubtitleSidecar({ showTitle: showName, season, episode })
        settled = true
        if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
        if (!subs?.subtitleUrl) {
          flash('No subtitles for this episode')
          return
        }
        applySubs(subs.subtitleUrl, subs.subtitleKind, 'Subtitles ready')
      } catch {
        settled = true
        if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
        flash('No subtitles for this episode')
      }
    })()

    return () => {
      cancelled = true
      if (!settled && movySubsSidecarRef.current === sidecarKey) {
        movySubsSidecarRef.current = ''
      }
    }
  }, [subtitleUrl, item, playlistIndex, activePlaylistItem])

  useEffect(() => {
    // Each episode/release can have its own sync; don't carry delay across titles.
    subtitleDelayRef.current = 0
    setSubtitleDelaySec(0)
  }, [subtitleUrl, playlistIndex])

  useEffect(() => {
    skipWyzieSubsRef.current = false
  }, [playlistIndex, item.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const syncCue = () => {
      if (!subsEnabledRef.current || subtitleCues.length === 0) {
        setSubtitleLine('')
        return
      }
      // Remux resume uses ffmpeg -ss, so video.currentTime is relative — add offset.
      // Subtract delay so positive delay pushes cues later (VLC-style).
      // absolutePlayhead tracks the title clock so cues stay locked to audio.
      setSubtitleLine(
        activeSubtitleText(
          subtitleCues,
          absolutePlayhead(video) - subtitleDelayRef.current,
        ),
      )
    }

    let raf = 0
    const tick = () => {
      syncCue()
      if (!video.paused && !video.ended) {
        raf = window.requestAnimationFrame(tick)
      }
    }

    const onPlay = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(tick)
    }
    const onPause = () => {
      window.cancelAnimationFrame(raf)
      syncCue()
    }

    syncCue()
    if (!video.paused) raf = window.requestAnimationFrame(tick)
    video.addEventListener('play', onPlay)
    video.addEventListener('playing', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', syncCue)
    video.addEventListener('timeupdate', syncCue)
    return () => {
      window.cancelAnimationFrame(raf)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', syncCue)
      video.removeEventListener('timeupdate', syncCue)
    }
  }, [
    subtitleCues,
    subsEnabled,
    activePlaylistItem.url,
    playlistIndex,
    timelineOffset,
    subtitleDelaySec,
    videoMountKey,
  ])

  function toggleSubtitles() {
    bumpChrome()
    // Not ready yet — kick a forced .srt fetch and leave subs enabled for when they arrive.
    if (subsStatus === 'loading' || subsStatus === 'idle' || subsStatus === 'missing') {
      if (!subtitleUrl) {
        flash('No subtitles on this release')
        return
      }
      setSubsEnabled(true)
      setSubsStatus('loading')
      setSubsFetchTick((n) => n + 1)
      flash(subsStatus === 'missing' ? 'Retrying subtitles…' : 'Fetching subtitles…')
      return
    }
    // Ready — real on/off toggle.
    setSubsEnabled((on) => {
      const next = !on
      flash(next ? 'Subtitles on' : 'Subtitles off')
      return next
    })
  }

  function nudgeSubtitleDelay(delta: number) {
    const next = Math.round((subtitleDelayRef.current + delta) * 10) / 10
    const clamped = Math.max(-15, Math.min(15, next))
    subtitleDelayRef.current = clamped
    setSubtitleDelaySec(clamped)
    bumpChrome()
  }

  async function runAutoSubtitleSync() {
    if (autoSyncRunning) return
    if (!isSubtitleAutoSyncAvailable()) {
      flash('Auto sync is desktop-only for now')
      return
    }
    const video = videoRef.current
    if (!video || subtitleCues.length === 0 || subsStatus !== 'ready') {
      flash('Load subtitles first')
      return
    }
    setAutoSyncRunning(true)
    bumpChrome()
    try {
      const result = await estimateSubtitleDelay({
        video,
        cues: subtitleCues,
        absoluteTime: () => absolutePlayhead(video),
        seekToAbsolute,
        onProgress: (message) => flash(message),
      })
      if (!result.ok) {
        flash(result.error)
        return
      }
      subtitleDelayRef.current = result.delaySec
      setSubtitleDelaySec(result.delaySec)
      if (!subsEnabled) setSubsEnabled(true)
      flash(
        result.delaySec === 0
          ? `Auto sync ±0s (${result.samples} samples)`
          : `Auto sync ${result.delaySec > 0 ? '+' : ''}${result.delaySec.toFixed(1)}s`,
      )
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Auto sync failed')
    } finally {
      setAutoSyncRunning(false)
      bumpChrome()
    }
  }

  /** Mid-playback Movy stall → Atlantic/Cinecat HLS (Aphrodite/totallyacdn). */
  tryHlsFallbackRef.current = async (resumeAt: number) => {
    const meta = hlsFallbackMetaRef.current
    if (!meta || meta.tried || meta.busy) return false
    meta.busy = true
    try {
      setError(null)
      setStatus('Stream stalled — switching source…')
      const alt = await resolveAtlanticPlay({
        tmdbId: meta.tmdbId,
        mediaType: meta.mediaType,
        season: meta.season,
        episode: meta.episode,
        title: meta.title,
      })
      if (!alt.ok) {
        meta.busy = false
        return false
      }
      meta.tried = true
      activePlaybackReferrerRef.current = alt.referer || ATLANTIC_PLAY_REFERER
      if (window.signalDesktop?.setPlaybackHeaders) {
        void window.signalDesktop.setPlaybackHeaders({
          url: alt.url,
          referrer: alt.referer || ATLANTIC_PLAY_REFERER,
        })
      }
      if (resumeAt >= 5 && isVodCategory(item.category)) {
        upsertContinueEntry(
          {
            id: item.id,
            title: item.title,
            poster: item.poster,
            category: item.category,
            playlistIndex,
            episodeTitle: hasPlaylist ? activePlaylistItem.title : undefined,
            currentTime: resumeAt,
            duration: 0,
            runtimeSeconds: item.runtimeSeconds,
            torrentUri: item.torrentUri,
            detailUrl: item.detailUrl,
            playUrl: item.detailUrl || item.torrentUri,
            source: item.source,
          },
          { allowUnknownDuration: true, playbackUrl: alt.url },
        )
        resumePendingRef.current = true
      }
      setLocalPlaylist((prev) => {
        const base = prev ?? item.playlist ?? []
        if (base.length === 0) {
          return [
            {
              title: activePlaylistItem.title || item.title,
              url: alt.url,
              episodeKey: activePlaylistItem.episodeKey,
              subtitleUrl: activePlaylistItem.subtitleUrl,
              subtitleKind: activePlaylistItem.subtitleKind,
            },
          ]
        }
        return base.map((row, i) => (i === playlistIndex ? { ...row, url: alt.url } : row))
      })
      setStatus(`Playing · ${alt.provider}`)
      return true
    } catch {
      if (hlsFallbackMetaRef.current) hlsFallbackMetaRef.current.busy = false
      return false
    }
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
    const isRivestreamShow =
      isTmdbTvCatalogItem(item) ||
      isNetMirrorCatalogItem(item) ||
      isYmoviesCatalogItem(item) ||
      isCinetaroCatalogItem(item) ||
      Boolean(item.rivestreamTmdbId) ||
      Boolean(item.tags?.some((t) => /^rivestream$/i.test(t)))
    // Don't run Torrentio on Rive/TMDB kids & series — empty sibling URLs were
    // mis-handled as "needs a torrent" → "No torrent link for this episode".
    const useTorrentio =
      TORRENTIO_TV_TRIAL &&
      !isRivestreamShow &&
      !isM2BoxCatalogItem(item) &&
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
    const needsM2Box =
      isM2BoxCatalogItem(item) &&
      (options?.force ||
        !entry.url ||
        !/^https?:\/\//i.test(entry.url) ||
        /hakunaymatata\.com|aoneroom\.com/i.test(entry.url))
    // If the playlist already carries Nyaa/torrent magnets, use those — don't
    // bounce back into Rive (which often only has a dead embed shell).
    const needsRivestream =
      isRivestreamShow &&
      !entry.torrentUri &&
      (options?.force || !entry.url || !/^https?:\/\//i.test(entry.url))

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
        setStatus('Fetching sources…')
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
        setStatus('Fetching sources…')
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

    if (needsM2Box) {
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus('Loading episode…')
      setError(null)
      try {
        const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(episodeKey)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        const resolved = await resolveM2BoxPlay(item.detailUrl || item.url, {
          subjectId: item.m2boxSubjectId,
          season,
          episode,
        })
        if (episodeFailGenRef.current !== failGen) return
        if (!resolved.ok || !resolved.url) {
          failOnEpisode(resolved.ok === false ? resolved.error : 'Could not resolve M2Box stream')
          return
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: resolved.url,
            referrer: resolved.referer,
          })
        }
        setLocalPlaylist((prev) => {
          const base = prev ?? item.playlist ?? []
          return base.map((row, i) =>
            i === index
              ? {
                  ...row,
                  url: resolved.url,
                  episodeKey: row.episodeKey || episodeKey || undefined,
                }
              : row,
          )
        })
        setEpisodeLoading(false)
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not load M2Box episode')
        return
      }
    } else if (needsRivestream) {
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus('Opening Movy…')
      setError(null)
      try {
        const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(episodeKey)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        const showName = cleanShowDisplayTitle(item.title) || item.title
        let nyaaHandled = false

        const tryPlayFromNyaa = async (): Promise<'played' | 'failed' | 'skip'> => {
          if (!isTorrentPlaybackAvailable()) return 'skip'
          if (!shouldTryNyaaForItem(item)) return 'skip'
          setStatus('Searching for episode…')
          const nyaa = await resolveNyaaEpisodePlay({
            showTitle: showName,
            season,
            episode,
          })
          if (episodeFailGenRef.current !== failGen) return 'failed'
          if (!nyaa.ok) return 'skip'
          const candidates = nyaaTorrentCandidates(nyaa.choice)
          if (candidates.length === 0) return 'skip'
          let result: TorrentStreamResult | null = null
          let usedUri = candidates[0]
          let lastError = 'Could not start torrent'
          for (let i = 0; i < candidates.length; i++) {
            const uri = candidates[i]
            usedUri = uri
            setStatus(
              candidates.length > 1
                ? `Loading torrent… (${i + 1}/${candidates.length})`
                : 'Starting torrent…',
            )
            try {
              const attempt = await withTimeout(
                torrentStream(uri, { keepOthers: inMultiview }),
                TORRENT_CANDIDATE_TIMEOUT_MS,
                'Release took too long to start — trying another source.',
              )
              if (attempt.ok && attempt.url) {
                result = attempt
                break
              }
              lastError = attempt.error || lastError
            } catch (err) {
              lastError = err instanceof Error ? err.message : lastError
            }
          }
          if (episodeFailGenRef.current !== failGen) return 'failed'
          if (!result?.ok || !result.url) {
            failOnEpisode(lastError)
            return 'failed'
          }
          setLocalPlaylist(
            nyaa.episodes.map((ep, i) =>
              i === nyaa.playIndex
                ? {
                    title: ep.title,
                    url: result!.url!,
                    torrentUri: usedUri,
                    torrentAlternates: ep.alternates,
                    episodeKey: ep.key,
                    subtitleUrl: result!.subtitleUrl ?? result!.playlist?.[0]?.subtitleUrl,
                    subtitleKind: result!.subtitleKind ?? result!.playlist?.[0]?.subtitleKind,
                    fileName: result!.fileName,
                  }
                : {
                    title: ep.title,
                    url: '',
                    torrentUri: ep.torrentUri,
                    torrentAlternates: ep.alternates,
                    episodeKey: ep.key,
                  },
            ),
          )
          index = nyaa.playIndex
          return 'played'
        }

        let tmdbId = rivestreamTmdbIdFromItem(item)
        if (!tmdbId && isYmoviesCatalogItem(item)) {
          setStatus('Looking up show…')
          tmdbId = (await lookupRivestreamTmdbId(item.title)) || ''
        }
        if (!tmdbId) {
          const nyaa = await tryPlayFromNyaa()
          if (nyaa === 'failed') return
          if (nyaa === 'skip') {
            failOnEpisode('No TMDB ID for this show')
            return
          }
          nyaaHandled = true
        } else if (!nyaaHandled) {
          const yearMatch = /\b(19|20)\d{2}\b/.exec(String(item.description || item.title || ''))
          const movy = await withTimeout(
            resolveMovyPlay({
              tmdbId,
              title: showName,
              mediaType: 'tv',
              season,
              episode,
              year: yearMatch?.[0],
            }),
            12_000,
            'Movy lookup timed out.',
          )
          if (episodeFailGenRef.current !== failGen) return
          if (movy.ok) {
            const usedAtlantic = movy.backend === 'atlantic'
            hlsFallbackMetaRef.current = {
              tmdbId,
              mediaType: 'tv',
              season,
              episode,
              title: showName,
              tried: usedAtlantic,
              busy: false,
            }
            activePlaybackReferrerRef.current = movy.referer || MOVY_PLAY_REFERER
            if (usedAtlantic) setStatus('Playing · atlantic')
            let subtitleUrl = movy.subtitleUrl
            let subtitleKind = movy.subtitleKind
            if (!subtitleUrl && isWyzieAvailable()) {
              try {
                const wyzie = await resolveWyzieSubtitle({ tmdbId, season, episode })
                if (episodeFailGenRef.current !== failGen) return
                if (wyzie.ok) {
                  subtitleUrl = wyzie.subtitleUrl
                  subtitleKind = wyzie.subtitleKind
                }
              } catch {
                /* play without captions */
              }
            }
            if (window.signalDesktop?.setPlaybackHeaders) {
              void window.signalDesktop.setPlaybackHeaders({
                url: movy.url,
                referrer: movy.referer || MOVY_PLAY_REFERER,
              })
            }
            setLocalPlaylist((prev) => {
              const base = prev ?? item.playlist ?? []
              return base.map((row, i) =>
                i === index
                  ? {
                      ...row,
                      url: movy.url,
                      episodeKey: row.episodeKey || episodeKey || undefined,
                      subtitleUrl,
                      subtitleKind,
                    }
                  : row,
              )
            })
          } else {
            // resolveMovyPlay already exhausted Movy + Atlantic — try Atlantic once more
            // here so resolve-time fallback stays visible at the call site, then Nyaa.
            setStatus('Trying alternate HLS…')
            let atlanticOk = false
            try {
              const alt = await resolveAtlanticPlay({
                tmdbId,
                mediaType: 'tv',
                season,
                episode,
                title: showName,
              })
              if (episodeFailGenRef.current !== failGen) return
              if (alt.ok) {
                atlanticOk = true
                hlsFallbackMetaRef.current = {
                  tmdbId,
                  mediaType: 'tv',
                  season,
                  episode,
                  title: showName,
                  tried: true,
                  busy: false,
                }
                activePlaybackReferrerRef.current = alt.referer || ATLANTIC_PLAY_REFERER
                if (window.signalDesktop?.setPlaybackHeaders) {
                  void window.signalDesktop.setPlaybackHeaders({
                    url: alt.url,
                    referrer: alt.referer || ATLANTIC_PLAY_REFERER,
                  })
                }
                let subtitleUrl: string | undefined
                let subtitleKind: 'file' | 'embedded' | undefined
                if (isWyzieAvailable()) {
                  try {
                    const wyzie = await resolveWyzieSubtitle({ tmdbId, season, episode })
                    if (episodeFailGenRef.current !== failGen) return
                    if (wyzie.ok) {
                      subtitleUrl = wyzie.subtitleUrl
                      subtitleKind = wyzie.subtitleKind
                    }
                  } catch {
                    /* play without captions */
                  }
                }
                setLocalPlaylist((prev) => {
                  const base = prev ?? item.playlist ?? []
                  return base.map((row, i) =>
                    i === index
                      ? {
                          ...row,
                          url: alt.url,
                          episodeKey: row.episodeKey || episodeKey || undefined,
                          subtitleUrl,
                          subtitleKind,
                        }
                      : row,
                  )
                })
                setStatus('Playing · atlantic')
              }
            } catch {
              /* fall through to Nyaa */
            }
            if (atlanticOk) {
              /* playlist updated */
            } else {
              const nyaa = await tryPlayFromNyaa()
              if (nyaa === 'failed') return
              if (nyaa === 'skip') {
                failOnEpisode(movy.error || 'No stream for this episode')
                return
              }
              nyaaHandled = true
            }
          }
        }
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not load episode')
        return
      }
      setEpisodeLoading(false)
    } else if (needsTorrent) {
      if (!isTorrentPlaybackAvailable()) {
        failOnEpisode('Torrent playback needs the Jiyu desktop app or Android torrent engine.')
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
              torrentStream(uri, {
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
                if (hash) await torrentStop(hash)
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
            setStatus('Fetching sources…')
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
          await torrentStop(prevHash)
        } else if (!prevHash && !inMultiview && prevUri && !isDebridHttpPlayUrl(usedUri)) {
          await torrentStop()
        } else if (!inMultiview && isDebridHttpPlayUrl(usedUri) && prevHash) {
          await torrentStop(prevHash)
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
    // Keep chrome up while loading / episode list / PiP — Android was hiding
    // controls while still on "Loading HLS…" so Play was unreachable.
    const loadingChrome =
      !mediaReady ||
      episodeLoading ||
      /^(Connecting|Loading|Opening|Finding|Fetching|Starting|Seeking|Trying|Press play|Buffering|Stream stalled)/i.test(
        status,
      )
    if (playlistOpenRef.current || isPip || loadingChrome) return
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS)
  }

  function toggleChromeOnTap(e: React.PointerEvent) {
    if (isPip || error) return
    // Always allow revealing chrome while loading so Pause/Play stay reachable.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea, .player-controls, .player-bar, .player-bottom-bar, .seek-skip-btn')) return
    setChromeVisible((visible) => {
      if (visible) {
        if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
        const loadingChrome =
          !mediaReady ||
          episodeLoading ||
          /^(Connecting|Loading|Opening|Finding|Fetching|Starting|Seeking|Trying|Press play|Buffering|Stream stalled)/i.test(
            status,
          )
        if (loadingChrome) return true
        return false
      }
      bumpChrome()
      return true
    })
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

  async function handleCast() {
    const playUrl = activePlaylistItem.url || item.url || videoRef.current?.currentSrc || ''
    const mode = castModeForPlayback(item, playUrl)
    if (mode === 'none') {
      flash('Cast unavailable')
      return
    }
    if (mode === 'mirror') {
      flash('No media URL — open screen cast to mirror')
      try {
        await androidOpenScreenCastSettings()
      } catch {
        flash('Could not open Cast settings')
      }
      return
    }
    if (casting) {
      try {
        await androidCastStop()
        setCasting(false)
        setCastDevice('')
        flash('Cast stopped')
        const video = videoRef.current
        if (video) void ensureVideoAutoplay(video)
      } catch {
        flash('Could not stop Cast')
      }
      return
    }
    if (!isCastableMediaUrl(playUrl)) {
      flash('Cast unavailable for this stream')
      return
    }
    const video = videoRef.current
    const absolute =
      (video && Number.isFinite(video.currentTime) ? video.currentTime : 0) +
      timelineOffsetRef.current
    // Remux pipes are not byte-seekable on the TV — bake the offset into the URL.
    const castUrl = isRemuxPlaybackUrl(playUrl)
      ? withResumeOffset(playUrl, absolute, { exact: true })
      : playUrl
    const position = isRemuxPlaybackUrl(playUrl) ? 0 : Math.max(0, absolute)
    try {
      flash('Looking for TVs…')
      const state = await androidCastMedia({
        url: castUrl,
        title: displayTitle || item.title || 'Jiyu',
        subtitle: activePlaylistItem.title || '',
        imageUrl: item.poster,
        position,
      })
      if (state.casting) {
        setCasting(true)
        setCastDevice(String(state.deviceName || ''))
        if (video && !video.paused) {
          video.pause()
          setPaused(true)
        }
        flash(state.deviceName ? `Casting to ${state.deviceName}` : 'Casting')
      } else {
        flash('Cast cancelled')
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Cast failed')
    }
  }

  /** Native element volume 0–100%. At 100%, output follows the Windows mixer only. */
  function applyVolumeToElement(
    level: number,
    isMuted: boolean,
    primaryAudio: boolean = isPrimary,
  ) {
    const video = videoRef.current
    if (!video) return
    // Snap full to exactly 1 so we never leave a 0.999 attenuator on the bus.
    const next = level >= 0.995 ? 1 : Math.min(VOLUME_MAX, Math.max(0, level))
    video.volume = next
    video.muted = isMuted || !primaryAudio
  }

  function applyVolume(next: number, options?: { unmute?: boolean }) {
    const clamped = Math.min(VOLUME_MAX, Math.max(0, next))
    setVolume(clamped)
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped))
    } catch {
      /* ignore */
    }
    let nextMuted = muted
    if (options?.unmute && muted) {
      nextMuted = false
      setMuted(false)
      try {
        localStorage.setItem(MUTE_KEY, '0')
      } catch {
        /* ignore */
      }
    }
    applyVolumeToElement(clamped, nextMuted)
    flash(formatVolumeLabel(clamped, nextMuted && !options?.unmute))
  }

  function toggleMute() {
    const next = !muted
    setMuted(next)
    try {
      localStorage.setItem(MUTE_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
    applyVolumeToElement(volume, next)
    flash(formatVolumeLabel(volume, next))
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
    if (!video) return
    const url = activePlaylistItem.url
    const notice = seconds < 0 ? `Back ${Math.abs(seconds)}s` : `Forward ${seconds}s`

    // Torrent remux pipes aren't byte-seekable — jump via ffmpeg -ss when needed.
    // Android WebView ignores currentTime on that pipe, so a buffered seek looks
    // like the button did nothing. Always reopen the remux at the new time there.
    if (isRemuxPlaybackUrl(url)) {
      const target = Math.max(0, effectivePlayhead(video) + seconds)
      const trusted = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
      const capped =
        isTrustedDuration(trusted) ? Math.min(target, Math.max(0, trusted - 0.5)) : target
      const relative = capped - timelineOffsetRef.current
      const canSeekInBuffer =
        !isAndroidTorrentAvailable() &&
        relative >= 0 &&
        Number.isFinite(video.duration) &&
        video.duration !== Infinity &&
        isTimeBuffered(video, relative)
      if (canSeekInBuffer) {
        video.currentTime = Math.min(video.duration, Math.max(0, relative))
        watchClockRef.current = { lastTs: 0, accrued: capped }
        flash(notice)
        bumpChrome()
        return
      }
      setStatus('Seeking…')
      setTimelineOffsetSeconds(capped)
      watchClockRef.current = { lastTs: 0, accrued: capped }
      resumeKeyRef.current = `${item.id}:${playlistIndex}:seek`
      resumePendingRef.current = false
      const next = capped < 5 ? stripResumeOffset(url) : withResumeOffset(url, capped, { exact: true })
      try {
        const parsed = new URL(next)
        parsed.searchParams.set('r', String(Date.now()))
        video.src = parsed.toString()
      } catch {
        video.src = next
      }
      video.load()
      void video.play().catch(() => undefined)
      flash(notice)
      bumpChrome()
      return
    }

    if (!Number.isFinite(video.duration) || video.duration === Infinity) {
      flash('Live — seek unavailable')
      return
    }
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds))
    flash(notice)
    bumpChrome()
  }

  function seekToAbsolute(absoluteSeconds: number) {
    const video = videoRef.current
    if (!video) return
    const url = activePlaylistItem.url
    const trusted = item.runtimeSeconds || getContinueEntry(item.id)?.runtimeSeconds || 0
    const maxDur =
      isTrustedDuration(trusted) && trusted > 0
        ? trusted
        : playbackClock.duration > 0
          ? playbackClock.duration
          : Number.isFinite(video.duration) && video.duration !== Infinity
            ? video.duration + timelineOffsetRef.current
            : 0
    let target = Math.max(0, absoluteSeconds)
    if (maxDur > 0) target = Math.min(target, Math.max(0, maxDur - 0.25))

    if (isRemuxPlaybackUrl(url)) {
      const relative = target - timelineOffsetRef.current
      const canSeekInBuffer =
        !isAndroidTorrentAvailable() &&
        relative >= 0 &&
        Number.isFinite(video.duration) &&
        video.duration !== Infinity &&
        isTimeBuffered(video, relative)
      if (canSeekInBuffer) {
        video.currentTime = Math.min(video.duration, Math.max(0, relative))
        watchClockRef.current = { lastTs: 0, accrued: target }
        setPlaybackClock((prev) => ({ ...prev, current: target }))
        bumpChrome()
        return
      }
      setStatus('Seeking…')
      setTimelineOffsetSeconds(target)
      watchClockRef.current = { lastTs: 0, accrued: target }
      resumeKeyRef.current = `${item.id}:${playlistIndex}:seek`
      resumePendingRef.current = false
      const next =
        target < 5 ? stripResumeOffset(url) : withResumeOffset(url, target, { exact: true })
      try {
        const parsed = new URL(next)
        parsed.searchParams.set('r', String(Date.now()))
        video.src = parsed.toString()
      } catch {
        video.src = next
      }
      video.load()
      void video.play().catch(() => undefined)
      setPlaybackClock((prev) => ({ ...prev, current: target }))
      bumpChrome()
      return
    }

    if (!Number.isFinite(video.duration) || video.duration === Infinity) {
      flash('Live — seek unavailable')
      return
    }
    const relative = Math.max(0, target - timelineOffsetRef.current)
    video.currentTime = Math.min(video.duration, Math.max(0, relative))
    watchClockRef.current = { lastTs: 0, accrued: target }
    setPlaybackClock((prev) => ({ ...prev, current: target }))
    bumpChrome()
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
    // Web embed owns OS fullscreen — don't steal/clear it from the native player.
    if (webSurfaceOwnsFullscreen() && getFullscreenOwner() === 'web') {
      flash('Web player is fullscreen')
      return
    }
    const leaving = Boolean(document.fullscreenElement) || osFullScreenRef.current

    if (leaving) {
      osFullScreenRef.current = false
      setOsFullScreen(false)
      void exitOsFullscreen({ onlyIfOwner: 'native', force: true })
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
      flash('Exit fullscreen')
      return
    }

    osFullScreenRef.current = true
    setOsFullScreen(true)
    void enterOsFullscreen('native')
    // Android WebView Fullscreen API crops/zooms the video — CSS + immersive bars only.
    if (!isAndroidShell()) {
      void stage.requestFullscreen().catch(() => undefined)
    }
    flash('Fullscreen')
  }

  useEffect(() => {
    if (isPip) {
      setFittedVideo(null)
      return
    }
    const video = videoRef.current
    const stage = video?.parentElement
    if (!video || !stage) return
    let frame = 0
    const fit = () => {
      const box = stage.getBoundingClientRect()
      const mediaW = video.videoWidth
      const mediaH = video.videoHeight
      if (box.width < 8 || box.height < 8 || mediaW < 8 || mediaH < 8) {
        setFittedVideo(null)
        return
      }
      const scale = Math.min(box.width / mediaW, box.height / mediaH)
      const width = Math.max(1, Math.floor(mediaW * scale))
      const height = Math.max(1, Math.floor(mediaH * scale))
      setFittedVideo((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      )
    }
    fit()
    video.addEventListener('loadedmetadata', fit)
    video.addEventListener('resize', fit)
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(stage)
    window.addEventListener('orientationchange', fit)
    return () => {
      cancelAnimationFrame(frame)
      video.removeEventListener('loadedmetadata', fit)
      video.removeEventListener('resize', fit)
      observer.disconnect()
      window.removeEventListener('orientationchange', fit)
    }
  }, [isPip, isTile, osFullScreen, videoMountKey, mediaReady])

  useEffect(() => {
    if (isPip && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
    // Native PiP must not clear OS fullscreen while the in-app browser owns the
    // watch surface (embed Full / auto-FS). That race pauses Rivestream embeds.
    if (isPip && osFullScreenRef.current) {
      if (webSurfaceOwnsFullscreen() || getFullscreenOwner() === 'web') return
      osFullScreenRef.current = false
      setOsFullScreen(false)
      void exitOsFullscreen({ onlyIfOwner: 'native', force: false })
    }
  }, [isPip])

  useEffect(() => {
    const stop = window.signalDesktop?.onFullScreenChange?.((state) => {
      const next = Boolean(state?.fullScreen)
      // Ignore OS FS owned by the web embed — don't mirror it into native state.
      if (getFullscreenOwner() === 'web' || (next && webSurfaceOwnsFullscreen())) {
        syncFullscreenOwnerFromOs(next, 'web')
        if (!next && osFullScreenRef.current) {
          osFullScreenRef.current = false
          setOsFullScreen(false)
        }
        return
      }
      syncFullscreenOwnerFromOs(next, 'native')
      osFullScreenRef.current = next
      setOsFullScreen(next)
      if (!next && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined)
      }
    })
    return () => stop?.()
  }, [])

  useEffect(() => {
    if (isTile || isPip) return
    const video = videoRef.current
    const shell = shellRef.current
    if (!video || !shell) return
    let bouncingFromVideo = false

    const keepSubsInFullscreen = () => {
      // Native <video> fullscreen drops our overlay subs — bounce to the shell.
      if (document.fullscreenElement === video) {
        bouncingFromVideo = true
        void document
          .exitFullscreen()
          .then(() => {
            void enterOsFullscreen('native')
            osFullScreenRef.current = true
            setOsFullScreen(true)
            // Android: CSS immersive only — WebView requestFullscreen zooms/crops.
            if (isAndroidShell()) return undefined
            return shell.requestFullscreen()
          })
          .catch(() => undefined)
          .finally(() => {
            bouncingFromVideo = false
          })
        return
      }
      // User pressed Esc / exited HTML fullscreen — drop OS fullscreen too,
      // but never yank Full from a web embed that owns the session.
      if (
        !document.fullscreenElement &&
        osFullScreenRef.current &&
        !bouncingFromVideo &&
        getFullscreenOwner() !== 'web' &&
        !webSurfaceOwnsFullscreen()
      ) {
        osFullScreenRef.current = false
        setOsFullScreen(false)
        void exitOsFullscreen({ onlyIfOwner: 'native', force: true })
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
    applyVolumeToElement(volume, effectiveMuted, isPrimary)
  }, [item, retryTick, volume, effectiveMuted, isPrimary])

  useEffect(() => {
    applyVolumeToElement(volume, effectiveMuted, isPrimary)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount when video identity changes
  }, [videoMountKey])

  useEffect(() => {
    const media = videoRef.current
    if (!media) return
    if (!activePlaylistItem?.url) return
    const video = media

    let cancelled = false
    let hls: Hls | null = null
    let tsPlayer: ReturnType<typeof mpegts.createPlayer> | null = null

    const applyHlsQuality = () => {
      if (!hls || hls.levels.length === 0) return
      const levelsSnap = hls.levels
      const preference = getViewingQuality()
      const isHevcLevel = (level: (typeof levelsSnap)[number]) =>
        /hev1|hvc1|h265|hevc/i.test(String(level.codecs || level.videoCodec || ''))
      // Electron paints black for HEVC — prefer AVC when both exist.
      const avcLevels = levelsSnap
        .map((level, index) => ({ index, height: level.height || 0, hevc: isHevcLevel(level) }))
        .filter((level) => !level.hevc)
      const pool = (avcLevels.length > 0 ? avcLevels : levelsSnap.map((level, index) => ({
        index,
        height: level.height || 0,
        hevc: isHevcLevel(level),
      }))).filter((level) => level.height > 0)
      const levels = [...pool].sort((a, b) => a.height - b.height)
      if (levels.length === 0) {
        // No height metadata — still avoid locking onto a HEVC track when AVC exists.
        if (avcLevels.length > 0) {
          hls.autoLevelCapping = Math.max(...avcLevels.map((l) => l.index))
          if (preference !== 'auto') hls.currentLevel = avcLevels[avcLevels.length - 1].index
          else hls.currentLevel = -1
        }
        return
      }
      // Auto: ABR capped by internet speed + device; fixed prefs lock the level.
      const capHeight = Math.min(
        resolveRequestedQuality(preference),
        getPerformanceKnobs().maxQuality,
      )
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
    let paintWatchTimer = 0
    let audioOnlyHealAttempts = 0
    function clearPaintWatch() {
      if (paintWatchTimer) {
        window.clearInterval(paintWatchTimer)
        paintWatchTimer = 0
      }
    }
    function markMediaReadyIfPainted() {
      const el = videoRef.current
      if (!el || cancelled) return false
      const hasFrame = el.videoWidth > 0 && el.videoHeight > 0
      // Live IPTV can paint while videoWidth is briefly 0, or report frames
      // without a useful width — don't leave the opaque full-player overlay up
      // (PiP hides that overlay, which is why picture only appeared there).
      const playingWithData =
        !el.paused &&
        el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        (el.currentTime > 0.2 || (el.played?.length ?? 0) > 0)
      // Frame painted but still paused (autoplay rejected) — retry once.
      if (hasFrame && el.paused && !el.ended) {
        void ensureVideoAutoplay(el).then((ok) => {
          if (!ok) setStatus('Press play')
        })
      }
      if (hasFrame || playingWithData) {
        setMediaReady(true)
        clearPaintWatch()
        return true
      }
      return false
    }
    /** Audio can start before the first decoded frame — keep polling so the
     * opaque loading overlay doesn't sit forever over a working picture.
     * If audio advances with videoWidth still 0, try another HLS level (HEVC). */
    function startPaintWatch() {
      if (paintWatchTimer || cancelled) return
      const startedAt = Date.now()
      paintWatchTimer = window.setInterval(() => {
        if (cancelled) {
          clearPaintWatch()
          return
        }
        if (markMediaReadyIfPainted()) return
        const el = videoRef.current
        if (!el) return
        const audioOnly =
          !el.paused &&
          el.currentTime > 0.4 &&
          el.videoWidth === 0 &&
          el.videoHeight === 0 &&
          Date.now() - startedAt > 3500
        if (!audioOnly) {
          // Playing with data but no dimensions yet — still clear the cover.
          if (
            !el.paused &&
            el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            Date.now() - startedAt > 900
          ) {
            setMediaReady(true)
            clearPaintWatch()
            return
          }
          if (Date.now() - startedAt > 20_000) clearPaintWatch()
          return
        }
        if (hls && hls.levels.length > 1 && audioOnlyHealAttempts < hls.levels.length) {
          audioOnlyHealAttempts += 1
          const healLevels = hls.levels
          const isHevc = (level: (typeof healLevels)[number]) =>
            /hev1|hvc1|h265|hevc/i.test(String(level.codecs || level.videoCodec || ''))
          const next = healLevels.findIndex(
            (level, index) => index !== hls!.currentLevel && !isHevc(level),
          )
          const fallback = next >= 0 ? next : (hls.currentLevel + 1) % healLevels.length
          setStatus('Audio only — trying another quality…')
          try {
            hls.currentLevel = fallback
            void el.play().catch(() => undefined)
          } catch {
            /* ignore */
          }
          return
        }
        // Truly no picture — drop the overlay so chrome/status stay usable.
        setMediaReady(true)
        setStatus('Playing (audio only — video codec unsupported)')
        clearPaintWatch()
      }, 400)
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
      if (!hash || !isTorrentPlaybackAvailable()) return
      const playhead = effectivePlayhead(video)
      const reported =
        Number.isFinite(video.duration) && video.duration !== Infinity && video.duration > 0
          ? video.duration + timelineOffsetRef.current
          : 0
      const trusted = trustedRuntimeSeconds(playhead, reported, activePlaylistItem.url)
      // Ask for pieces ahead of the lead target so remux rarely runs dry.
      const lead = getPerformanceKnobs().remuxLeadSeconds
      void torrentEnsureDownloading(
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
      applyVolumeToElement(volumeRef.current, effectiveMutedRef.current, isPrimaryRef.current)
    }

    const onPlaying = () => {
      if (!cancelled) {
        // Do not clear Movy stall / freeze watches here — brief playing blips
        // between empty buffer windows were resetting the Atlantic fallback forever.
        clearPausePrefetch()
        clearLeadBufferResume()
        leadBufferPauseRef.current = false
        setError(null)
        setStatus('Playing')
        setPaused(false)
        applyVolumeToElement(volumeRef.current, effectiveMutedRef.current, isPrimaryRef.current)
        // Only dismiss the loading screen once frames are actually painting.
        // loadeddata alone was leaving a black stage with no title overlay.
        // `playing` can also fire before videoWidth is known — keep watching.
        if (!markMediaReadyIfPainted()) startPaintWatch()
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
      bumpChrome()
      // Remux can spin forever when peers stall — surface a recoverable error.
      // Movy HLS can also stall forever — switch to Atlantic/Cinecat after a soft wait.
      const playUrl = activePlaylistItem.url
      const isLocal = isEphemeralLocalStreamUrl(playUrl)
      const meta = hlsFallbackMetaRef.current
      const canAtlantic =
        Boolean(meta) &&
        !meta!.tried &&
        !meta!.busy &&
        (isMovyStreamUrl(playUrl) || meta!.tmdbId.length > 0)
      if (!isLocal && !canAtlantic) return
      const now = Date.now()
      if (!waitingSince) waitingSince = now
      if (!waitingOrigin) waitingOrigin = now
      if (stallTimer != null) return
      // Soft limit: no meaningful buffer growth. Hard cap: never sit here forever
      // because tiny fragment arrivals kept resetting the soft timer.
      const perf = getPerformanceKnobs()
      const stallLimitMs = canAtlantic
        ? 12_000
        : isRemuxPlaybackUrl(activePlaylistItem.url)
          ? perf.remuxStallMs
          : perf.localStallMs
      const hardCapMs = canAtlantic
        ? 20_000
        : Math.max(stallLimitMs * 2, 120_000)
      let lastBufferedEnd = 0
      let bufferedAtOrigin = -1
      let lastMovingPlayhead = -1
      stallTimer = window.setInterval(() => {
        if (cancelled || !waitingSince || !waitingOrigin) return
        const videoEl = videoRef.current
        if (!videoEl) return
        const t = videoEl.currentTime
        const playheadMoving =
          lastMovingPlayhead >= 0 && t > lastMovingPlayhead + 0.2
        if (playheadMoving) lastMovingPlayhead = t
        else if (lastMovingPlayhead < 0) lastMovingPlayhead = t
        // Only clear when the playhead is actually advancing — HAVE_FUTURE_DATA
        // alone was true during frozen Movy stalls (tiny buffer, no progress).
        if (
          !videoEl.paused &&
          videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
          playheadMoving
        ) {
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
        // For Movy/Atlantic fallback, buffer growth without playhead move does NOT reset soft stall.
        if (bufferedEnd > lastBufferedEnd + 0.35) {
          lastBufferedEnd = bufferedEnd
          if (!canAtlantic) {
            waitingSince = Date.now()
            setError(null)
            setStatus('Buffering…')
          }
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
        if (hardStalled && !almostNoLead && !softStalled && !canAtlantic) return
        clearStallWatch()
        // Prefer Atlantic HLS before rotating torrent magnets.
        if (canAtlantic) {
          const resumeAt = videoEl.currentTime || 0
          setStatus('Stream stalled — switching source…')
          bumpChrome()
          void tryHlsFallbackRef.current(resumeAt).then((ok) => {
            if (cancelled) return
            if (ok) return
            if (isLocal) {
              const hasAlt = (activePlaylistItem.torrentAlternates?.length || 0) > 0
              if (hasAlt) {
                setError(null)
                setStatus('Fetching sources…')
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
              return
            }
            setError('Stream stalled — alternate source unavailable. Tap Retry.')
            setStatus('Buffering…')
          })
          return
        }
        const hasAlt = (activePlaylistItem.torrentAlternates?.length || 0) > 0
        if (hasAlt) {
          setError(null)
          setStatus('Fetching sources…')
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

    // Playhead freeze watchdog — Movy often stalls without reliable `waiting` events
    // (frozen frame, readyState still HAVE_*). Switch to Atlantic after ~12s.
    let freezeLastTime = -1
    let freezeSince = 0
    let freezeTimer: number | null = null
    const clearFreezeWatch = () => {
      freezeLastTime = -1
      freezeSince = 0
      if (freezeTimer != null) {
        window.clearInterval(freezeTimer)
        freezeTimer = null
      }
    }
    const armFreezeWatch = () => {
      if (freezeTimer != null) return
      freezeTimer = window.setInterval(() => {
        if (cancelled) return
        const meta = hlsFallbackMetaRef.current
        const playUrl = activePlaylistItem.url
        const canAtlantic =
          Boolean(meta) &&
          !meta!.tried &&
          !meta!.busy &&
          (isMovyStreamUrl(playUrl) || meta!.tmdbId.length > 0)
        if (!canAtlantic) return
        const el = videoRef.current
        if (!el || el.paused || el.ended) {
          freezeLastTime = -1
          freezeSince = 0
          return
        }
        const t = el.currentTime
        if (freezeLastTime < 0) {
          freezeLastTime = t
          freezeSince = Date.now()
          return
        }
        if (t > freezeLastTime + 0.2) {
          freezeLastTime = t
          freezeSince = Date.now()
          return
        }
        if (Date.now() - freezeSince < 12_000) return
        clearFreezeWatch()
        clearStallWatch()
        setStatus('Stream stalled — switching source…')
        bumpChrome()
        void tryHlsFallbackRef.current(t).then((ok) => {
          if (cancelled || ok) return
          setError('Stream stalled — alternate source unavailable. Tap Retry.')
          setStatus('Buffering…')
        })
      }, 1000)
    }
    armFreezeWatch()
    let remuxRelays = 0
    let lastRelayPlayhead = 0
    let lastResumeAt = -1
    let lastResumeAtMs = 0
    let remuxContinueBusy = false
    let remuxDeferTimer = 0
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

      if (playhead >= lastRelayPlayhead + 25) remuxRelays = 0
      // Re-ended almost immediately at the same spot after a relay → wait for pieces.
      const stuckAfterRelay = remuxRelays > 0 && playhead <= lastRelayPlayhead + 12
      let resumeAt = Math.max(5, Math.floor(playhead) - 1)
      if (isTrustedDuration(trusted)) {
        resumeAt = Math.min(resumeAt, Math.floor(trusted * 0.9))
      }
      const now = Date.now()
      const sameSeekRecently =
        lastResumeAt >= 0 &&
        Math.abs(resumeAt - lastResumeAt) <= 12 &&
        now - lastResumeAtMs < 45_000
      if (stuckAfterRelay || sameSeekRecently) {
        // Reloading the same t= looks like the movie "restarted" and starves the swarm.
        console.info('[player] remux continue deferred', {
          reason,
          resumeAt,
          playhead: Math.floor(playhead),
          stuckAfterRelay,
          sameSeekRecently,
        })
        kickTorrentPrefetch()
        setStatus('Waiting for more download…')
        flash('Waiting for more torrent data…')
        remuxContinueBusy = true
        if (remuxDeferTimer) window.clearTimeout(remuxDeferTimer)
        remuxDeferTimer = window.setTimeout(() => {
          remuxDeferTimer = 0
          remuxContinueBusy = false
        }, 12_000)
        return true
      }
      if (remuxRelays >= MAX_REMUX_RELAYS) {
        setError(
          'Playback stopped mid-title — torrent buffer ran dry. Tap Retry, wait for more peers, or Restart.',
        )
        setStatus('Stopped')
        return true
      }

      remuxRelays += 1
      lastRelayPlayhead = playhead
      lastResumeAt = resumeAt
      lastResumeAtMs = now
      remuxContinueBusy = true
      saveContinueProgress()
      setTimelineOffsetSeconds(resumeAt)
      watchClockRef.current = { lastTs: 0, accrued: resumeAt }
      setStatus(reason === 'lead' ? 'Buffering ahead…' : 'Continuing stream…')
      flash(reason === 'lead' ? 'Building buffer ahead…' : 'Continuing past buffer…')
      setError(null)
      setPaused(false)
      console.info('[player] remux continue', { reason, resumeAt, remuxRelays })
      const baseUrl = stripResumeOffset(playbackUrl)
      const continueUrl = withResumeOffset(baseUrl, resumeAt)
      const onContinueError = () => {
        video.removeEventListener('error', onContinueError)
        // Mid-title remux 503 / empty pipe — do NOT restart from t=0 (feels like
        // the movie "keeps restarting"). Hold position, keep downloading, retry.
        remuxContinueBusy = false
        setResumeOffer(Math.max(resumeAt, playhead))
        resumePendingRef.current = false
        kickTorrentPrefetch()
        setPaused(true)
        setStatus('Waiting for more download…')
        flash('Torrent gap — waiting, then continuing from here')
        if (remuxDeferTimer) window.clearTimeout(remuxDeferTimer)
        remuxDeferTimer = window.setTimeout(() => {
          remuxDeferTimer = 0
          if (cancelled) return
          remuxContinueBusy = false
          // Retry the same seek once pieces have had time to arrive.
          void continueRemuxPastGap('retry')
        }, 14_000)
      }
      video.addEventListener('error', onContinueError)
      video.src = continueUrl
      video.load()
      void video.play().then(
        () => {
          video.removeEventListener('error', onContinueError)
          remuxContinueBusy = false
          setStatus('Playing')
        },
        () => {
          video.removeEventListener('error', onContinueError)
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

      if (cancelled || !nearEnd) return

      if (playlistIndex < playlist.length - 1) {
        // Re-resolve torrent URLs — don't just bump the index onto a dead remux link.
        void selectPlaylistItemRef.current(playlistIndex + 1)
        return
      }

      // Title / last episode finished — start the one-slot Up next queue.
      const queued = watchNextRef.current
      if (!queued || queued.id === item.id) return
      const next = takeWatchNext()
      if (!next) return
      flash(`Up next: ${next.title}`)
      window.setTimeout(() => {
        navigate(next.href, { replace: true })
      }, 400)
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
    video.addEventListener('loadeddata', markMediaReadyIfPainted)
    video.addEventListener('resize', markMediaReadyIfPainted)
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
        if (
          window.signalDesktop?.setPlaybackHeaders &&
          (item.httpUserAgent || item.httpReferrer)
        ) {
          void window.signalDesktop.setPlaybackHeaders({
            url: activePlaylistItem.url || item.url,
            userAgent: item.httpUserAgent,
            referrer: item.httpReferrer,
          })
        }
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
          // If a mid-title remux resume failed, keep the resume offer — never
          // auto-jump back to t=0 (that feels like the title "keeps restarting").
          if (resumeAttempt > 0 && resumeAt >= 5) {
            resumeAttempt = 0
            setResumeOffer(resumeAt)
            resumePendingRef.current = false
            resumeKeyRef.current = null
            setStatus('Resume point not ready — tap Resume when more is downloaded')
            flash('Torrent still buffering at resume point')
            settled = true
            window.clearTimeout(loadTimer)
            cleanup()
            setError(null)
            resolve()
            return
          }
          settled = true
          window.clearTimeout(loadTimer)
          cleanup()
          const remux = isRemuxPlaybackUrl(activePlaylistItem.url)
          reject(
            new Error(
              remux
                ? torrentStallMessage()
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
          void ensureVideoAutoplay(video).then((ok) => {
            if (!ok) setStatus('Press play')
          })
          finishOk()
        }

        const onResumeReady = () => {
          if (settled) return
          flash(`Resumed at ${formatClock(resumeAt)}`)
          void ensureVideoAutoplay(video).then((ok) => {
            if (!ok) setStatus('Press play')
          })
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
        void ensureVideoAutoplay(video)
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
        const isLiveSports =
          item.category === 'sports' ||
          item.sourceKind === 'iptv' ||
          item.tags?.some((t) =>
            /^(iptv|local|live|live-now|ppv\.st|streamed|always-live)$/i.test(t),
          )
        const isIptv =
          item.sourceKind === 'iptv' ||
          item.tags?.some((t) => /^iptv$/i.test(t)) ||
          item.tags?.some((t) => /^local$/i.test(t))
        const liveMode = isLiveSports || isIptv
        const playbackHeaders = {
          url: activePlaylistItem.url || item.url,
          userAgent: item.httpUserAgent,
          referrer: activePlaybackReferrerRef.current || item.httpReferrer,
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders(playbackHeaders)
        }
        hls = new Hls({
          enableWorker: perf.enableMediaWorkers,
          // Low-latency mode fights unstable public IPTV / sports feeds.
          lowLatencyMode: liveMode ? perf.liveHlsLowLatency : perf.hlsLowLatency,
          maxBufferLength: liveMode
            ? Math.max(perf.liveHlsMaxBufferLength, perf.hlsMaxBufferLength, 36)
            : perf.hlsMaxBufferLength,
          maxMaxBufferLength: liveMode
            ? Math.max(perf.liveHlsMaxBufferLength + 24, 72)
            : undefined,
          // Stay several segments behind the edge so jitter doesn't empty the buffer.
          liveSyncDurationCount: liveMode ? perf.liveHlsSyncSegments : undefined,
          liveMaxLatencyDurationCount: liveMode
            ? Math.max(perf.liveHlsSyncSegments + 4, 10)
            : undefined,
          fragLoadingTimeOut: liveMode ? 20_000 : 15_000,
          manifestLoadingTimeOut: liveMode ? 15_000 : 10_000,
          levelLoadingTimeOut: liveMode ? 15_000 : 10_000,
          fragLoadingMaxRetry: liveMode ? 8 : 6,
          manifestLoadingMaxRetry: liveMode ? 6 : 5,
          levelLoadingMaxRetry: liveMode ? 6 : 5,
          fragLoadingRetryDelay: liveMode ? 800 : 1000,
          xhrSetup(xhr) {
            xhr.withCredentials = false
            const referrer = playbackHeaders.referrer
            const ua = playbackHeaders.userAgent
            if (referrer) {
              try {
                xhr.setRequestHeader('Referer', referrer)
              } catch {
                /* some browsers block Referer header */
              }
            }
            if (ua) {
              try {
                xhr.setRequestHeader('User-Agent', ua)
              } catch {
                /* ignore */
              }
            }
          },
          // Android: CapacitorHttp loader so Referer reaches CDNs (XHR cannot set it).
          ...androidHlsConfig(
            {},
            {
              referrer: playbackHeaders.referrer,
              userAgent: playbackHeaders.userAgent,
            },
          ),
        })
        let recoveries = 0
        let settled = false
        // Movy can hang forever on "Loading HLS…" after a mid-episode stall —
        // fail fast so Atlantic / next engine can take over.
        const meta = hlsFallbackMetaRef.current
        const canAtlanticSoon =
          Boolean(meta) &&
          !meta!.tried &&
          (isMovyStreamUrl(activePlaylistItem.url) || meta!.tmdbId.length > 0)
        const hlsLoadBudgetMs = canAtlanticSoon ? 8_000 : liveMode ? 55_000 : 28_000
        const loadTimer = window.setTimeout(() => {
          if (settled || cancelled) return
          settled = true
          try {
            hls?.destroy()
          } catch {
            /* ignore */
          }
          hls = null
          reject(new Error('HLS load timed out — stream stalled.'))
        }, hlsLoadBudgetMs)
        hls.loadSource(activePlaylistItem.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled || settled) return
          settled = true
          window.clearTimeout(loadTimer)
          applyHlsQuality()
          // Prefer English audio groups when the HLS master lists multiple tracks.
          try {
            const tracks = hls?.audioTracks || []
            if (tracks.length > 1 && !shouldPreferRivestreamJapaneseAudio(item)) {
              const scored = tracks.map((t, index) => {
                const blob = `${t.name || ''} ${t.lang || ''} ${t.groupId || ''}`.toLowerCase()
                let score = 0
                if (/english|\beng\b|\ben-?us\b|\ben\b/.test(blob)) score += 20
                if (
                  /hindi|\bhin\b|arabic|spanish|french|german|portuguese|russian|turkish|tamil|telugu|urdu|korean|chinese|japanese|\bjp\b|\bja\b/.test(
                    blob,
                  )
                ) {
                  score -= 25
                }
                return { index, score }
              })
              scored.sort((a, b) => b.score - a.score)
              const best = scored[0]
              if (best && best.score >= 0 && hls) hls.audioTrack = best.index
            }
          } catch {
            /* ignore */
          }
          setStatus('Ready')
          const saved = getContinueEntry(item.id)
          if (saved && saved.playlistIndex === playlistIndex && saved.currentTime >= 5) {
            setResumeOffer(saved.currentTime)
            resumePendingRef.current = false
          }
          void ensureVideoAutoplay(video).then((ok) => {
            if (!ok) setStatus('Press play')
          })
          resolve()
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal || settled) return
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
          settled = true
          window.clearTimeout(loadTimer)
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
        const perf = getPerformanceKnobs()
        // Stash absorbs jitter on public sports TS; latency chasing emptied the
        // buffer and stalled while other apps on the same network kept playing.
        tsPlayer = mpegts.createPlayer(
          { type: 'mse', isLive: true, url: activePlaylistItem.url },
          {
            enableWorker: perf.enableMediaWorkers,
            enableStashBuffer: perf.mpegTsEnableStashBuffer,
            stashInitialSize: perf.mpegTsStashInitialSize,
            liveBufferLatencyChasing: perf.mpegTsLiveLatencyChasing,
            liveBufferLatencyMaxLatency: perf.mpegTsLiveLatencyMaxLatency,
            liveBufferLatencyMinRemain: Math.min(2, perf.mpegTsLiveLatencyMaxLatency / 3),
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
      // Dead Movy CDN (400 "Please wait file process.") — switch before loading HLS.
      {
        const playUrl = activePlaylistItem.url
        const meta = hlsFallbackMetaRef.current
        const canAtlantic =
          Boolean(meta) &&
          !meta!.tried &&
          !meta!.busy &&
          (isMovyStreamUrl(playUrl) || meta!.tmdbId.length > 0)
        if (canAtlantic && isMovyStreamUrl(playUrl)) {
          setStatus('Checking stream…')
          const alive = await probeMovyHlsUrl(
            playUrl,
            activePlaybackReferrerRef.current || MOVY_PLAY_REFERER,
          )
          if (cancelled) return
          if (!alive) {
            const resumeAt = video.currentTime || getContinueEntry(item.id)?.currentTime || 0
            setStatus('Stream unavailable — switching source…')
            const switched = await tryHlsFallbackRef.current(resumeAt)
            if (cancelled || switched) return
          }
        }
      }

      const engines = pickEngines(activePlaylistItem.url)
      let lastError = 'Playback failed.'
      let hlsError: string | null = null
      for (const engine of engines) {
        if (cancelled) return
        cleanupPlayers()
        try {
          await runners[engine]()
          if (!cancelled) setError(null)
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          lastError = message
          if (engine === 'hls') hlsError = message
        }
      }
      // Native fallback noise ("Native playback failed…") hides the real HLS failure
      // for Aphrodite/totallyacdn — keep the HLS reason when we have one.
      if (
        hlsError &&
        /native playback failed/i.test(lastError) &&
        isHlsUrl(activePlaylistItem.url)
      ) {
        lastError = hlsError
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
        const tmdbId = rivestreamTmdbIdFromItem(item)
        const epKey =
          playlistEpisodeKey(activePlaylistItem) ||
          parseEpisodeKey(item.title) ||
          ''
        const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(epKey)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : playlistIndex + 1
        const showName = cleanShowDisplayTitle(item.title) || item.title
        const playUrl = activePlaylistItem.url || item.url || ''
        const meta = hlsFallbackMetaRef.current
        const onMovy =
          isMovyStreamUrl(playUrl) ||
          item.httpReferrer === MOVY_PLAY_REFERER ||
          /movy/i.test(String(item.tags?.join(' ') || ''))
        const onAtlantic =
          /totallyacdn|cdn\.hls\.lol|stream\.hls\.lol|transcode\.cfd|atlantic\.st/i.test(playUrl) ||
          item.httpReferrer === ATLANTIC_PLAY_REFERER ||
          Boolean(meta?.tried)

        // Buffering / HLS load fail while already on Movy → Atlantic only.
        // Do NOT bounce back to "Trying Movy…" (that re-probes the dead CDN).
        if (tmdbId && onMovy && !onAtlantic) {
          setError(null)
          setStatus('Trying alternate HLS…')
          flash('Trying alternate HLS…')
          if (!meta) {
            hlsFallbackMetaRef.current = {
              tmdbId,
              mediaType: 'tv',
              season,
              episode,
              title: showName,
              tried: false,
              busy: false,
            }
          }
          const resumeAt = video.currentTime || 0
          const switched = await tryHlsFallbackRef.current(resumeAt)
          if (cancelled || switched) return
        }

        // Fresh resolve (no Movy/Atlantic URL yet) — Movy then Atlantic inside resolveMovyPlay.
        const isRivestreamPlay =
          isTmdbTvCatalogItem(item) ||
          Boolean(item.rivestreamTmdbId) ||
          Boolean(item.tags?.some((t) => /^rivestream$/i.test(t)))
        if (isRivestreamPlay && tmdbId && !onMovy && !onAtlantic) {
          const yearMatch = /\b(19|20)\d{2}\b/.exec(String(item.description || item.title || ''))
          setError(null)
          setStatus('Trying Movy…')
          flash('Trying Movy…')
          try {
            const movy = await withTimeout(
              resolveMovyPlay({
                tmdbId,
                title: showName,
                mediaType: 'tv',
                season,
                episode,
                year: yearMatch?.[0],
              }),
              12_000,
              'Movy lookup timed out.',
            )
            if (cancelled) return
            if (movy.ok) {
              const usedAtlantic = movy.backend === 'atlantic'
              hlsFallbackMetaRef.current = {
                tmdbId,
                mediaType: 'tv',
                season,
                episode,
                title: showName,
                tried: usedAtlantic,
                busy: false,
              }
              activePlaybackReferrerRef.current = movy.referer || MOVY_PLAY_REFERER
              let subtitleUrl = movy.subtitleUrl
              let subtitleKind = movy.subtitleKind
              if (!subtitleUrl && isWyzieAvailable()) {
                try {
                  const wyzie = await resolveWyzieSubtitle({ tmdbId, season, episode })
                  if (cancelled) return
                  if (wyzie.ok) {
                    subtitleUrl = wyzie.subtitleUrl
                    subtitleKind = wyzie.subtitleKind
                  }
                } catch {
                  /* play without captions */
                }
              }
              if (window.signalDesktop?.setPlaybackHeaders) {
                void window.signalDesktop.setPlaybackHeaders({
                  url: movy.url,
                  referrer: movy.referer || MOVY_PLAY_REFERER,
                })
              }
              setLocalPlaylist((prev) => {
                const base = prev ?? item.playlist ?? []
                return base.map((row, i) =>
                  i === playlistIndex
                    ? {
                        ...row,
                        url: movy.url,
                        episodeKey: row.episodeKey || epKey || undefined,
                        subtitleUrl,
                        subtitleKind,
                      }
                    : row,
                )
              })
              return
            }
            setStatus('Trying alternate HLS…')
            flash('Trying alternate HLS…')
            const alt = await resolveAtlanticPlay({
              tmdbId,
              mediaType: 'tv',
              season,
              episode,
              title: showName,
            })
            if (cancelled) return
            if (alt.ok) {
              hlsFallbackMetaRef.current = {
                tmdbId,
                mediaType: 'tv',
                season,
                episode,
                title: showName,
                tried: true,
                busy: false,
              }
              activePlaybackReferrerRef.current = alt.referer || ATLANTIC_PLAY_REFERER
              if (window.signalDesktop?.setPlaybackHeaders) {
                void window.signalDesktop.setPlaybackHeaders({
                  url: alt.url,
                  referrer: alt.referer || ATLANTIC_PLAY_REFERER,
                })
              }
              setLocalPlaylist((prev) => {
                const base = prev ?? item.playlist ?? []
                return base.map((row, i) =>
                  i === playlistIndex
                    ? {
                        ...row,
                        url: alt.url,
                        episodeKey: row.episodeKey || epKey || undefined,
                      }
                    : row,
                )
              })
              return
            }
          } catch {
            /* fall through to torrent alts / error */
          }
          if (cancelled) return
        }

        // Fatal load on Movy → Atlantic (if arming lagged behind the URL).
        {
          const liveMeta = hlsFallbackMetaRef.current
          const playingMovy =
            isMovyStreamUrl(activePlaylistItem.url) ||
            (Boolean(liveMeta) && !liveMeta!.tried)
          if (playingMovy && liveMeta && !liveMeta.tried) {
            const resumeAt = video.currentTime || 0
            const switched = await tryHlsFallbackRef.current(resumeAt)
            if (cancelled) return
            if (switched) return
          }
        }
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
          setError(torrentStallMessage())
        } else {
          setError(lastError)
        }
      }
    })()

    return () => {
      cancelled = true
      clearStallWatch()
      clearFreezeWatch()
      clearPausePrefetch()
      clearPlayPrefetch()
      clearLeadBufferResume()
      clearPaintWatch()
      if (remuxDeferTimer) window.clearTimeout(remuxDeferTimer)
      remuxDeferTimer = 0
      remuxContinueBusy = false
      leadBufferPauseRef.current = false
      saveContinueProgress()
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('loadeddata', markMediaReadyIfPainted)
      video.removeEventListener('resize', markMediaReadyIfPainted)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('timeupdate', onRemuxGuard)
      window.removeEventListener('jiyu:viewing-quality', onViewingQuality)
      cleanupPlayers()
    }
  }, [
    item.id,
    item.url,
    activePlaylistItem.url,
    playlistIndex,
    playlist.length,
    retryTick,
    videoMountKey,
  ])

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
          if (document.fullscreenElement || osFullScreenRef.current) {
            e.preventDefault()
            // Don't steal Esc from a web embed that owns OS fullscreen.
            if (getFullscreenOwner() === 'web' || webSurfaceOwnsFullscreen()) break
            if (osFullScreenRef.current) {
              osFullScreenRef.current = false
              setOsFullScreen(false)
              void exitOsFullscreen({ onlyIfOwner: 'native', force: true })
            }
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
          } else {
            onClose()
          }
          break
        case 'F11':
          e.preventDefault()
          toggleFullscreen()
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
          applyVolume(volume + VOLUME_STEP, { unmute: true })
          break
        case 'ArrowDown':
          e.preventDefault()
          applyVolume(volume - VOLUME_STEP)
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
      // Require Shift so normal scroll/trackpad gestures don't quietly lower
      // in-app volume below the Windows mixer level.
      if (!we.shiftKey) return
      we.preventDefault()
      bumpChrome()
      const delta = we.deltaY > 0 ? -VOLUME_STEP : VOLUME_STEP
      applyVolume(volume + delta, { unmute: delta > 0 })
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
          <video
            key={videoMountKey}
            ref={videoRef}
            className="player-video"
            crossOrigin="anonymous"
            autoPlay
            playsInline
            style={
              fittedVideo
                ? {
                    width: fittedVideo.width,
                    height: fittedVideo.height,
                    maxWidth: '100%',
                    maxHeight: '100%',
                  }
                : undefined
            }
          />
          {error && (
            <div className="player-error tile-error">
              <p>{error}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  const loadingChrome =
    !mediaReady ||
    episodeLoading ||
    /^(Connecting|Loading|Opening|Finding|Fetching|Starting|Seeking|Trying|Press play)/i.test(
      status,
    )

  return (
    <div
      ref={shellRef}
      className={`player-shell ${isPip ? 'player-shell-pip' : ''} ${osFullScreen ? 'is-os-fullscreen' : ''} ${chromeVisible || isPip || loadingChrome ? 'chrome-visible' : 'chrome-hidden'}`}
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
          {!isPip && (error || !isAndroidShell()) && (
            <p className={`player-meta-status${error ? ' is-error' : ''}`}>
              <span>
                {error ?? status}
                {!error && engineLabel ? ` · ${engineLabel}` : ''}
                {!error
                  ? ` · ${muted ? 'Muted' : `Vol ${Math.round(volume * 100)}%`}`
                  : ''}
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
          {watchNext && !isPip && watchNext.id !== item.id && (
            <div className="player-watch-next" title={`Up next: ${watchNext.title}`}>
              <span className="player-watch-next-label">Up next</span>
              <span className="player-watch-next-title">{watchNext.title}</span>
              <button
                type="button"
                className="ghost-btn player-watch-next-clear"
                onClick={() => clearWatchNext()}
                title="Clear up next"
              >
                ×
              </button>
            </div>
          )}
        </div>

        <div className="player-controls player-controls-top" onClick={(e) => e.stopPropagation()}>
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
          {!isPip && hasPlaylist && (
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
          {!isPip && !inMultiview && (
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
          {!isPip &&
            castAvailable &&
            castModeForPlayback(item, activePlaylistItem.url || item.url) !== 'none' && (
              <button
                type="button"
                className={`ghost-btn control-btn${casting ? ' is-armed' : ''}`}
                onClick={() => void handleCast()}
                title={
                  casting
                    ? castDevice
                      ? `Stop casting to ${castDevice}`
                      : 'Stop casting'
                    : castModeForPlayback(item, activePlaylistItem.url || item.url) === 'mirror'
                      ? 'No media URL — open screen cast to mirror the phone'
                      : 'Cast this stream to a TV'
                }
              >
                {casting ? (castDevice ? `Cast · ${castDevice}` : 'Casting') : 'Cast'}
              </button>
            )}
          {!isPip && (
            <button type="button" className="ghost-btn control-btn" onClick={toggleFullscreen} title="F">
              Full
            </button>
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

        {!isPip && (
        <div
          className={`player-bottom-bar player-chrome${chromeVisible || !mediaReady ? ' is-visible' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <div className="player-controls player-controls-bottom">
            <button type="button" className="ghost-btn control-btn" onClick={togglePause} title="Space / K">
              {paused ? 'Play' : 'Pause'}
            </button>
            <button type="button" className="ghost-btn control-btn" onClick={toggleMute} title="M">
              {muted || volume === 0 ? 'Unmute' : 'Mute'}
            </button>
            <label className="volume-control" title="Click or drag · 100% = system volume">
              <span className="sr-only">Volume</span>
              <VolumeSlider
                value={Math.round((muted ? 0 : volume) * 100)}
                onChange={(pct) => {
                  applyVolume(pct / 100, { unmute: pct > 0 })
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
                  title={
                    showSubsLoading
                      ? 'Click to fetch subtitles now'
                      : subsStatus === 'missing'
                        ? 'Retry loading subtitles'
                        : subsEnabled
                          ? 'Hide subtitles (C)'
                          : 'Show subtitles (C)'
                  }
                >
                  {showSubsLoading
                    ? 'Subs…'
                    : subsStatus === 'missing'
                      ? 'Retry Subs'
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
                    {isSubtitleAutoSyncAvailable() && (
                      <button
                        type="button"
                        className={`ghost-btn control-btn sub-sync-btn${autoSyncRunning ? ' is-armed' : ''}`}
                        disabled={autoSyncRunning}
                        onClick={() => void runAutoSubtitleSync()}
                        title="Experimental: estimate sync from speech near a few cues (desktop)"
                      >
                        {autoSyncRunning ? 'Auto…' : 'Auto'}
                      </button>
                    )}
                  </span>
                )}
              </>
            )}
            {(playbackClock.duration > 0 || playbackClock.current > 0) && (
              <div className="player-clock player-clock-inline" title="Position in the full title">
                <span>{formatClock(playbackClock.current)}</span>
                <span className="player-clock-sep">/</span>
                <span>
                  {playbackClock.duration > 0 ? formatClock(playbackClock.duration) : '—:—'}
                </span>
              </div>
            )}
          </div>
          {playbackClock.duration > 0 && (
            <label className="player-seek" title="Seek">
              <span className="sr-only">Seek</span>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.floor(playbackClock.duration))}
                step={1}
                value={Math.min(
                  Math.max(0, Math.floor(playbackClock.current)),
                  Math.max(1, Math.floor(playbackClock.duration)),
                )}
                onChange={(e) => {
                  seekToAbsolute(Number(e.target.value) || 0)
                }}
                onPointerDown={() => bumpChrome()}
              />
            </label>
          )}
        </div>
      )}

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

      <div className="player-stage" onPointerUp={isPip ? undefined : toggleChromeOnTap}>
        <video
          key={videoMountKey}
          ref={videoRef}
          className={`player-video${isRemuxPlaybackUrl(activePlaylistItem.url) ? ' is-remux' : ''}`}
          crossOrigin="anonymous"
          controls={false}
          controlsList="nofullscreen nodownload noremoteplayback"
          disablePictureInPicture
          autoPlay
          playsInline
          onDoubleClick={isPip ? undefined : toggleFullscreen}
          style={
            fittedVideo
              ? {
                  width: fittedVideo.width,
                  height: fittedVideo.height,
                  maxWidth: '100%',
                  maxHeight: '100%',
                }
              : undefined
          }
        />
        {!isPip && !error && !mediaReady && (
          <PlaybackLoadingScreen
            title={displayTitle}
            status={
              episodeLoading
                ? 'Loading episode…'
                : status && status !== 'Playing' && status !== 'Ready'
                  ? status
                  : 'Starting playback…'
            }
            variant="stage"
          />
        )}
        {subsEnabled && subtitleLine && (
          <div
            className={`player-subtitles${fittedVideo && !isPip ? ' is-picture-anchored' : ''}`}
            style={
              fittedVideo && !isPip
                ? ({ ['--picture-h' as string]: `${fittedVideo.height}px` } as CSSProperties)
                : undefined
            }
            aria-live="polite"
          >
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
        {!isPip && !isTile && (
          <SeekSkipOverlay
            visible={chromeVisible && mediaReady && !error}
            onBack={() => seekBy(-10)}
            onForward={() => seekBy(10)}
          />
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
            Shift+scroll volume · Space/K pause · M mute · ↑↓ volume · ←→ / hover ±10s · F fullscreen ·
            Esc back
            {awaitingAdd ? ' · Multi-view armed' : ''}
          </p>
        )}
      </div>
    </div>
  )
}
