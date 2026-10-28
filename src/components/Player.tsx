import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { tizenHlsUrl } from '../lib/tizenRelay'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import { PlaybackLoadingScreen } from './PlaybackLoadingScreen'
import { VolumeSlider } from './VolumeSlider'
import { SeekSlider } from './SeekSlider'
import { SeekSkipOverlay } from './SeekSkipOverlay'
import { isHlsUrl, isMpegTsUrl } from '../lib/iptv'
import { androidHlsConfig } from '../lib/hlsAndroid'
import {
  claimFullscreenOwner,
  enterOsFullscreen,
  exitOsFullscreen,
  getFullscreenOwner,
  syncFullscreenOwnerFromOs,
  usesOsFullscreenOnly,
  webSurfaceFullscreenMounted,
  webSurfaceOwnsFullscreen,
} from '../lib/fullscreenSession'
import { androidSystemPipSettling } from '../lib/androidSystemPip'
import { nativeFetchText } from '../lib/nativeHttp'
import {
  formatClock,
  getContinueEntry,
  isEpisodeComplete,
  isLikelyPartialDuration,
  isLocalPlaybackUrl,
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
  forgetLastGoodPlay,
  getLastGoodPlay,
  inferPlayPipe,
  playReliabilityKey,
  preferredResolveBackend,
  rememberLastGoodPlay,
  rememberResolvedHlsPlay,
  type PlayPipe,
} from '../lib/playReliability'
import {
  activeSubtitleText,
  isJunkSubtitleText,
  parseSubtitleCues,
  type SubtitleCue,
} from '../lib/subtitles'
import { getPerformanceKnobs } from '../lib/deviceProfile'
import { isTizenTv } from '../lib/tvMode'
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
  resolveAnimeTmdbTvId,
  rivestreamTmdbIdFromItem,
  shouldPreferRivestreamJapaneseAudio,
} from '../lib/rivestream'
import {
  resolveMovyPlay,
  MOVY_PLAY_REFERER,
  probeMovyHlsUrl,
  getMovyPlaySession,
  rememberMovyPlaySession,
  type MovyAudioOption,
} from '../lib/movy'
import { BILIBILI_TV_PLAY_REFERER } from '../lib/bilibiliTv'
import { resolveDonghuaPlay } from '../lib/donghuaResolve'
import { biliSubtitleHeaders, isBiliSubtitleUrl } from '../lib/biliSubs'
import {
  ATLANTIC_PLAY_REFERER,
  isMovyStreamUrl,
  resolveAtlanticPlay,
} from '../lib/atlanticHls'
import { ensureEpisodeSoftSubtitles } from '../lib/softSubs'
import {
  SubtitleTranslationSession,
  detectCueLanguage,
  type TranslationSnapshot,
} from '../lib/subtitleTranslate'
import { loadTranslationAids } from '../lib/subtitleContext'
import {
  getAutoTranslateSubsPref,
  getPreferredSubtitleLanguage,
  normalizeLanguageCode,
  subtitleLanguageLabel,
} from '../lib/language'
import { subsLog } from '../lib/subsLog'
import {
  estimateSubtitleDelay,
  isSubtitleAutoSyncAvailable,
} from '../lib/subtitleAutoSync'
import {
  nyaaTorrentCandidates,
  resolveNyaaEpisodePlay,
  isNyaaSubtitleSidecarPending,
  markNyaaSubtitleSourceUnusable,
  onNyaaSubtitleSidecarSettled,
  releaseOtherNyaaSubtitleSidecars,
  resetNyaaSubtitleSidecarFailures,
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
  isDesktopTorrentAvailable,
  isTorrentPlaybackAvailable,
  torrentEnsureDownloading,
  torrentStop,
  torrentStream,
} from '../lib/torrentBridge'
import { maskUserFacingMessage } from '../lib/sourceMask'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'
import {
  type AnimeAudioMode,
  type AnimeDubInfo,
  animeDubDetailUrl,
  animeDubHasEpisode,
  effectiveAnimeAudioMode,
  findAnimeEnglishDub,
  getShowAnimeAudioMode,
  isAnimeDubRowTitle,
  isDualAudioReleaseName,
  remuxUrlIsDub,
  remuxUrlWithAudio,
  setShowAnimeAudioMode,
} from '../lib/animeAudio'

/** What the anime Sub / Dub button can switch for the current episode. */
type AnimeAudioChoice =
  | { kind: 'm2box'; info: AnimeDubInfo; index: number; season: number; episode: number }
  | { kind: 'hls'; en: number; ja: number }
  | { kind: 'remux' }

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

/** M2Box row whose own subject is the English dub ("Title [English]"). */
function isAnimeDubRowItem(item: Pick<StreamItem, 'title' | 'tags'>): boolean {
  return (
    isAnimeDubRowTitle(item.title) ||
    Boolean(item.tags?.some((t) => /^m2box-dub-row$/i.test(String(t))))
  )
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

/**
 * Background Nyaa subtitle retries: native torrent start may take up to 180s plus the
 * probe/extract, so keep looking for ~5 minutes before showing "No subtitles".
 */
/** Restart: how long saves stay paused waiting for the playhead to reach ~0. */
const RESTART_GUARD_MS = 30_000
/** Atlantic / Cinecat hosted HLS (same hosts the stall fallback recognises). */
const ATLANTIC_HLS_URL_RE = /totallyacdn|cdn\.hls\.lol|stream\.hls\.lol|transcode\.cfd|atlantic\.st/i

const SIDECAR_RETRY_WINDOW_MS = 5 * 60 * 1000
/** Android sidecars crawl on slow phone links (~50 KB/s): keep looking longer. */
const SIDECAR_RETRY_WINDOW_ANDROID_MS = 10 * 60 * 1000
/** Between background sidecar checks. A sidecar torrent settling wakes the wait early. */
const SIDECAR_RETRY_BACKOFF_DESKTOP_MS = [3_000, 4_000, 5_000]
const SIDECAR_RETRY_BACKOFF_ANDROID_MS = [10_000, 20_000, 30_000]
/**
 * With a translatable softsub already in hand, stop waiting for a still-starting Nyaa
 * release after this long (0-seeder releases otherwise hold subtitles back for minutes).
 */
const SIDECAR_WAIT_WITH_TRANSLATION_FALLBACK_MS = 45_000

/**
 * Episodes where Wyzie + OpenSubtitles already came back empty this session, so a
 * failed Nyaa release (URL dropped -> effect re-runs) goes straight to the next release.
 * Value = retry tick when recorded; a manual Subs retry (new tick) looks them up again.
 */
const softSubsMissByEpisode = new Map<string, number>()

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
    return 'Playback stalled — not enough source data yet. Tap Retry, wait a moment, or try another quality.'
  }
  return 'Playback stalled — not enough source data yet, or this file won’t remux. Try Retry or another quality.'
}

function playerErrorHint(error: string, url: string | undefined): string {
  if (/no peers|no reachable seeds|swarm may be dead|unavailable|no working sources/i.test(error)) {
    return 'This source looks empty. Open Episodes and pick another release, or try a different quality.'
  }
  if (
    /taking too long|still starting|still buffering|not enough (torrent|source)|buffer ran dry/i.test(
      error,
    )
  ) {
    if (isAndroidTorrentAvailable()) {
      return 'Sources may be slow or need more data. Tap Retry, wait a moment, or try another episode or quality.'
    }
    return 'Sources may be slow or the remux needs more data. Tap Retry, wait a moment, or try another episode or quality.'
  }
  if (isEphemeralLocalStreamUrl(url)) {
    return 'Playback stalled. Tap Retry, wait a moment, or try another episode or quality.'
  }
  return 'Status may show online while the stream still fails. Try another channel, use Web browser for live sites, or Refresh the playlist source.'
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

/** True while hls.js is mid-download on the main playlist — do not startLoad. */
function hlsHasInFlightMainFrag(hls: Hls | null | undefined): boolean {
  if (!hls) return false
  try {
    return Boolean(hls.inFlightFragments?.main?.frag)
  } catch {
    return false
  }
}

/**
 * Soft stall heal: never abort an in-flight fragment fetch. When Auto ABR is on,
 * tighten the ladder cap so the next segment can be 720p (etc.) instead of
 * freezing on 1080p. Only call startLoad when the pipeline is idle.
 */
function softHealHlsStall(
  hls: Hls,
  playhead: number,
  opts?: { allowAbrDownshift?: boolean; onAbrCap?: (height: number) => void; force?: boolean },
): 'in-flight' | 'abr-down' | 'start-load' {
  // force: playhead frozen / network came back - the in-flight flag can be stale
  // after an aborted request, so reset the loader like the skip-forward path does.
  if (opts?.force) {
    try {
      hls.stopLoad()
    } catch {
      /* ignore */
    }
  } else if (hlsHasInFlightMainFrag(hls)) return 'in-flight'
  if (opts?.allowAbrDownshift && hls.levels.length > 1) {
    try {
      const curIdx =
        hls.loadLevel >= 0 ? hls.loadLevel : hls.currentLevel >= 0 ? hls.currentLevel : -1
      const curHeight = curIdx >= 0 ? hls.levels[curIdx]?.height || 0 : 0
      const capIdx = hls.autoLevelCapping
      const capHeight =
        capIdx >= 0 && hls.levels[capIdx] ? hls.levels[capIdx]!.height || 0 : curHeight
      const ceiling = curHeight > 0 ? Math.min(curHeight, capHeight || curHeight) : capHeight
      let bestIdx = -1
      let bestH = -1
      for (let i = 0; i < hls.levels.length; i++) {
        const h = hls.levels[i]?.height || 0
        if (h > 0 && ceiling > 0 && h < ceiling && h > bestH) {
          bestH = h
          bestIdx = i
        }
      }
      if (bestIdx >= 0 && bestH > 0) {
        // Cap future loads — does not abort the fragment already on the wire.
        hls.autoLevelCapping = bestIdx
        if (getViewingQuality() === 'auto') hls.currentLevel = -1
        opts.onAbrCap?.(bestH)
        return 'abr-down'
      }
    } catch {
      /* fall through to startLoad */
    }
  }
  try {
    hls.startLoad(Number.isFinite(playhead) ? playhead : undefined)
  } catch {
    /* ignore */
  }
  return 'start-load'
}

function hlsTargetSegmentDurationSec(hls: Hls | null | undefined): number {
  if (!hls) return 6
  try {
    const details =
      hls.latestLevelDetails ||
      (hls.loadLevel >= 0 ? hls.levels[hls.loadLevel]?.details : null) ||
      hls.levels.find((l) => l.details)?.details
    const td = details?.targetduration
    if (typeof td === 'number' && Number.isFinite(td) && td > 0) {
      return Math.min(12, Math.max(2, td))
    }
  } catch {
    /* ignore */
  }
  return 6
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
/** Default softsub bump when cues run ahead of Movy/HLS anime (VLC-style +delay). */
const ANIME_SUB_DELAY_KEY = 'jiyu.player.animeSubDelaySec'
const DEFAULT_ANIME_SUB_DELAY_SEC = 0.5
/** In-app volume ceiling (native <video> max). At 100%, loudness matches the OS mixer. */
const VOLUME_MAX = 1
const VOLUME_STEP = 0.05
/** Hide controls after pointer idle once playback is underway. */
const CHROME_IDLE_MS = 2800
/** First auto-hide after the picture is up (and when entering fullscreen). */
const CHROME_START_HIDE_MS = 5_000
/** Statuses that mean the player is still starting — keep controls up. */
const CHROME_HOLD_RE =
  /^(Connecting|Loading|Opening|Finding|Fetching|Starting|Seeking|Trying|Press play)/i
/** Failed torrent loads on one episode before auto-skipping to the next. */
const EPISODE_FAILS_BEFORE_SKIP = 3
/** Don't sit forever on magnet #1 when an alternate exists. */
const TORRENT_CANDIDATE_TIMEOUT_MS = 28_000
const DEAD_SWARM_RE =
  /no peers|no reachable seeds|swarm may be dead|unavailable|taking too long|timed? ?out|took too long/i

function readAnimeSubtitleDelay(): number {
  try {
    const raw = localStorage.getItem(ANIME_SUB_DELAY_KEY)
    if (raw == null) return DEFAULT_ANIME_SUB_DELAY_SEC
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return DEFAULT_ANIME_SUB_DELAY_SEC
    return Math.max(-15, Math.min(15, n))
  } catch {
    return DEFAULT_ANIME_SUB_DELAY_SEC
  }
}

function writeAnimeSubtitleDelay(sec: number) {
  try {
    localStorage.setItem(ANIME_SUB_DELAY_KEY, String(sec))
  } catch {
    /* ignore */
  }
}

function initialSubtitleDelayForCategory(category?: string): number {
  return category === 'anime' ? readAnimeSubtitleDelay() : 0
}

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

/**
 * Samsung Tizen only: can script read this URL (CORS)? hls.js loads playlists
 * and segments with XHR, which most stream CDNs don't allow cross-origin; the
 * TV's own <video> HLS player is not bound by CORS. Only headers are needed.
 */
async function tizenCorsReadable(url: string): Promise<boolean> {
  if (!/^https?:/i.test(url)) return true
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = window.setTimeout(() => ctrl?.abort(), 5000)
  try {
    await fetch(url, { method: 'GET', credentials: 'omit', signal: ctrl?.signal })
    try {
      ctrl?.abort()
    } catch {
      /* ignore */
    }
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

/** Sports / IPTV / tagged live — drive HLS liveMode + mpegts live stash. */
function isLivePlaybackItem(item: StreamItem): boolean {
  if (item.category === 'sports') return true
  if (item.sourceKind === 'iptv') return true
  return Boolean(
    item.tags?.some((t) =>
      /^(iptv|local|live|live-now|ppv\.st|streamed|always-live)$/i.test(t),
    ),
  )
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

  const [error, setErrorRaw] = useState<string | null>(null)
  const [status, setStatusRaw] = useState('Connecting…')
  const setError = (value: string | null) =>
    setErrorRaw(value == null ? null : maskUserFacingMessage(value))
  const setStatus = (value: string) => setStatusRaw(maskUserFacingMessage(value))
  const [engineLabel, setEngineLabel] = useState('')
  /** Hide black stage until the first frame / playing event. */
  const [mediaReady, setMediaReady] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  /** Bump to remount the video element (explicit Retry only — never soft stalls). */
  const [hlsRemountNonce, setHlsRemountNonce] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(loadSavedMuted)
  const [volume, setVolume] = useState(loadSavedVolume)
  const [hint, setHintRaw] = useState<string | null>(null)
  const setHint = (value: string | null) =>
    setHintRaw(value == null ? null : maskUserFacingMessage(value))
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
  /** Prevent double auto-advance when both `ended` and near-end timeupdate fire. */
  const autoAdvanceLockRef = useRef(false)
  const [subsEnabled, setSubsEnabled] = useState(true)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [subtitleLine, setSubtitleLine] = useState('')
  const [subsStatus, setSubsStatus] = useState<'idle' | 'loading' | 'ready' | 'missing'>('idle')
  /** Bump to re-fetch / force sidecar .srt extract (Subs button). */
  const [subsFetchTick, setSubsFetchTick] = useState(0)
  const subsEnabledRef = useRef(true)
  subsEnabledRef.current = subsEnabled
  /** Anime Sub / Dub: switchable audio for this episode (null = no dub found, no button). */
  const [animeAudioChoice, setAnimeAudioChoice] = useState<AnimeAudioChoice | null>(null)
  const animeAudioChoiceRef = useRef<AnimeAudioChoice | null>(null)
  animeAudioChoiceRef.current = animeAudioChoice
  /** Audio currently playing for this anime episode. */
  const [animeAudioMode, setAnimeAudioMode] = useState<AnimeAudioMode>('sub')
  const animeAudioGenRef = useRef(0)
  const animeAudioBusyRef = useRef(false)
  /** Movy Audio menu (cities that list Hindi / English / Tamil... streams). */
  const [movyAudioOpen, setMovyAudioOpen] = useState(false)
  const [movyAudioBusy, setMovyAudioBusy] = useState(false)
  const movyAudioBusyRef = useRef(false)
  const activeUrlRef = useRef('')
  /** Mid-episode Sub / Dub switch on an mp4 / remux source: reopen here, not at 0. */
  const audioSwitchResumeRef = useRef(0)
  const animeShowTitle = cleanShowDisplayTitle(item.title) || item.title
  /** Positive = delay subs (later); negative = show earlier. Fixes out-of-sync softsubs. */
  const [subtitleDelaySec, setSubtitleDelaySec] = useState(0)
  const subtitleDelayRef = useRef(0)
  const [autoSyncRunning, setAutoSyncRunning] = useState(false)
  const movySubsSidecarRef = useRef('')
  /**
   * Nyaa sidecar search state while no subtitle URL is attached:
   * 'searching' = background retries running (show "Looking for subtitles…"),
   * 'retryable' = gave up for now (tap Subs to search again).
   */
  const [subsSearch, setSubsSearch] = useState<'off' | 'searching' | 'retryable'>('off')
  /** Wakes the sidecar retry sleep early (manual retry / cleanup). */
  const sidecarWakeRef = useRef<(() => void) | null>(null)
  /** Bumped by a manual retry to re-run the whole subtitle search for this episode. */
  const [sidecarRetryTick, setSidecarRetryTick] = useState(0)
  /** Last retry tick that already cleared the failed-release state. */
  const sidecarResetTickRef = useRef(0)
  /** After Wyzie free-plan ad dump, skip Wyzie and prefer Nyaa softsubs. */
  const skipWyzieSubsRef = useRef(false)
  /** True once the current subtitle source is fully loaded (sidecar read / extract done). */
  const subsExtractDoneRef = useRef(false)
  /** In-app subtitle translation for the current track (null = not translating). */
  const translationRef = useRef<SubtitleTranslationSession | null>(null)
  const [translationSnap, setTranslationSnap] = useState<TranslationSnapshot | null>(null)
  /** Show translated vs original cue text while a translation exists. */
  const [translateMode, setTranslateMode] = useState<'translated' | 'original'>('translated')
  /** Track language when it differs from the preferred one and auto-translate did not run. */
  const [translateOffer, setTranslateOffer] = useState<string | null>(null)
  /** Session key the user asked to translate on demand (Translate button). */
  const translateManualKeyRef = useRef('')
  const [translateRequestTick, setTranslateRequestTick] = useState(0)
  /** Detected track language for the current subtitle URL (cached once confident). */
  const detectedSubLangRef = useRef<{ url: string; lang: string } | null>(null)
  const translationStatusRef = useRef<TranslationSnapshot['status'] | null>(null)
  /** Cue array that belonged to the previous subtitle URL (kept on screen while the new one loads). */
  const staleTranslateCuesRef = useRef<SubtitleCue[] | null>(null)
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
  /** When the restart guard gives up and saving resumes (keeps the old resume point). */
  const restartGuardUntilRef = useRef(0)
  /** Furthest absolute playhead this session — a < 60s session is a quick bail for recommendations. */
  const sessionFurthestRef = useRef(0)
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
    (
      index: number,
      options?: {
        force?: boolean
        rotateTorrent?: boolean
        rotateSource?: boolean
        /** Same-episode Restart: clear stall/auto-seek targets and always remount. */
        fromRestart?: boolean
      },
    ) => Promise<void>
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
  /** Active hls.js instance — used to nudge startLoad after Resume seeks. */
  const hlsInstanceRef = useRef<Hls | null>(null)
  /** Cap mid-episode HLS remounts so a dead CDN can't reload-loop forever. */
  const hlsStallRemountRef = useRef({ key: '', count: 0, playStableSince: 0 })
  /** After Movy→Atlantic stall switch, seek once to this absolute time when ready. */
  const autoSeekResumeOnceRef = useRef(0)
  /**
   * While HLS recover/remount resets video.currentTime to 0, keep showing this
   * playhead on the seek bar so a soft stall doesn't look like a restart.
   */
  const stallHoldPlayheadRef = useRef(0)
  /**
   * Absolute media time for an in-flight HLS/native seek. Rapid ±10 taps must
   * stack from this (not stale video.currentTime) or the second Back re-seeks
   * to the same spot and leaves the stream buffering mid-episode.
   */
  const pendingNativeSeekRef = useRef<number | null>(null)
  const pendingNativeSeekGenRef = useRef(0)
  const pendingNativeSeekClearTimerRef = useRef(0)
  const pendingNativeSeekHandlerRef = useRef<(() => void) | null>(null)
  /** Block stall remount / Atlantic swap while a user scrub is settling. */
  const seekGuardUntilRef = useRef(0)
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
              subtitleLanguage: item.subtitleLanguage,
              subtitleNeedsTranslation: item.subtitleNeedsTranslation,
            },
          ]
  const activePlaylistItem = playlist[Math.min(playlistIndex, playlist.length - 1)] ?? {
    title: item.title,
    url: item.url,
    subtitleUrl: item.subtitleUrl,
    subtitleKind: item.subtitleKind,
    subtitleLanguage: item.subtitleLanguage,
    subtitleNeedsTranslation: item.subtitleNeedsTranslation,
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
    const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(epKey)
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
      // Single-file movies: the stall fallback must not ask Atlantic for "S1E1".
      mediaType: item.category === 'movies' && !seMatch && playlist.length <= 1 ? 'movie' : 'tv',
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
  activeUrlRef.current = activePlaylistItem.url || ''
  // Audio menu: only when the Movy city that is playing lists 2+ language streams.
  const movyAudioSession = getMovyPlaySession(activePlaylistItem.url)
  const movyAudioOptions = movyAudioSession?.audioOptions ?? []
  const movyAudioCurrent =
    movyAudioOptions.find((o) => o.key === movyAudioSession?.language) ?? null
  useEffect(() => {
    setMovyAudioOpen(false)
  }, [activePlaylistItem.url])
  useEffect(() => {
    if (!chromeVisible) setMovyAudioOpen(false)
  }, [chromeVisible])
  // Prefer the active episode's subs only — never fall back to another episode's
  // show-level subtitleUrl (that reused E02 captions while watching E05).
  const subtitleUrl = activePlaylistItem.subtitleUrl
  const subtitleKind = activePlaylistItem.subtitleKind
  // Companion files and embedded softsubs both get a Subs control once we have a URL.
  const showSubsLoading = subsStatus === 'loading' && Boolean(subtitleUrl)
  const subsSearching = !subtitleUrl && subsSearch === 'searching'
  const subsRetryable = !subtitleUrl && subsSearch === 'retryable'
  const showSubsControls = Boolean(subtitleUrl) || subsSearching || subsRetryable
  const videoMountKey = `v${AUDIO_PIPELINE_REV}-${item.id}-${activePlaylistItem.url ?? ''}-r${hlsRemountNonce}`

  // Allow one auto-advance per episode (ended + near-end timeupdate both fire).
  useEffect(() => {
    autoAdvanceLockRef.current = false
  }, [playlistIndex, item.id])

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
    setAnimeAudioChoice(null)
    setAnimeAudioMode('sub')
    primeAnimeAudioPicker(list, nextIndex)
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

    const rememberPipe = () => {
      const pipe =
        inferPlayPipe({
          url: activePlaylistItem.url || item.url,
          referrer: activePlaybackReferrerRef.current || item.httpReferrer,
        }) || (item.torrentUri ? ('torrent' as PlayPipe) : null)
      if (!pipe) return
      const epKey =
        playlistEpisodeKey(activePlaylistItem) || parseEpisodeKey(item.title) || ''
      const se = /^S(\d{1,2})E(\d{1,4})$/i.exec(epKey)
      const tmdbId = rivestreamTmdbIdFromItem(item)
      rememberLastGoodPlay(
        playReliabilityKey({
          itemId: item.id,
          tmdbId,
          mediaType: tmdbId ? 'tv' : undefined,
          season: se ? Number(se[1]) : undefined,
          episode: se ? Number(se[2]) : undefined,
        }),
        pipe,
        {
          host: (() => {
            try {
              return new URL(activePlaylistItem.url || item.url || '').hostname
            } catch {
              return undefined
            }
          })(),
        },
      )
    }

    const onPlaying = () => {
      if (!started) {
        started = true
        recordPlaybackHealth(key, 'started')
        rememberPipe()
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
            rememberPipe()
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

  /** Pin UI/clock across recoverMediaError / remount (media element resets to 0). */
  function pinStallPlayhead(at: number) {
    if (!(at > 0.5)) return
    stallHoldPlayheadRef.current = at
    autoSeekResumeOnceRef.current = Math.max(autoSeekResumeOnceRef.current, at)
    watchClockRef.current = { lastTs: 0, accrued: at }
    setPlaybackClock((prev) =>
      Math.abs(prev.current - at) < 0.15 ? prev : { ...prev, current: at },
    )
  }

  function clearStallHoldIfCaughtUp(video: HTMLVideoElement) {
    const hold = stallHoldPlayheadRef.current
    if (!(hold > 0.5)) return
    const t = Number.isFinite(video.currentTime) ? video.currentTime : 0
    // Media has landed near the hold and is playing — drop the pin.
    if (!video.paused && !video.ended && t >= hold - 1.25 && t <= hold + 12) {
      stallHoldPlayheadRef.current = 0
    }
  }

  function effectivePlayhead(video: HTMLVideoElement): number {
    const absolute = absolutePlayhead(video)
    const hold = stallHoldPlayheadRef.current
    // recoverMediaError / remount briefly report t=0 — keep the bar at the stall.
    if (hold > 0.5 && (absolute < 1 || absolute + 1.5 < hold)) {
      return hold
    }
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
    clearStallHoldIfCaughtUp(video)
    // Prefer effective playhead so brief remux/HLS stalls don't freeze the bar
    // while audio is still advancing via accrued clock.
    const playhead = effectivePlayhead(video)
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

  /**
   * urgent: pause / hide / close / PiP / end — always write locally and push to sync now.
   * Plain playback ticks only write when the playhead moved ≥5 s (see upsertContinueEntry).
   */
  function saveContinueProgress(urgent = false) {
    if (isTile) return
    const video = videoRef.current
    if (!video) return
    // Never persist a mid-seek playhead — Back/Forward (±10) on HLS is async;
    // saving the pre-seek time re-arms Resume and fights the jump.
    if (video.seeking || pendingNativeSeekRef.current != null) return
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
    if (currentTime > sessionFurthestRef.current) sessionFurthestRef.current = currentTime
    if (restartGuardRef.current) {
      // Drop stale mid-episode ticks until the restarted stream is actually at the start.
      if (currentTime < 5) {
        finishRestartGuard(true)
        return
      }
      if (Date.now() < restartGuardUntilRef.current) return
      // Restart never reached the start (failed / stuck): keep the saved resume
      // point and go back to saving normally.
      finishRestartGuard(false)
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
          genres: item.genres,
          tags: item.tags,
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
        genres: item.genres,
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
      { allowUnknownDuration: true, playbackUrl, urgent },
    )
    } catch (err) {
      console.warn('Continue watching progress save failed:', err)
    }
  }

  /** End the Restart save guard. reachedStart: playhead really is back near 0. */
  function finishRestartGuard(reachedStart: boolean) {
    if (!restartGuardRef.current) return
    restartGuardRef.current = false
    restartGuardUntilRef.current = 0
    if (reachedStart) {
      // Only now forget the old resume point, and only when it belongs to this
      // episode (Continue watching keeps one entry per show).
      const saved = getContinueEntry(item.id)
      if (saved && (saved.playlistIndex || 0) === (playlistIndex || 0)) {
        removeContinueEntry(item.id)
      }
      setResumeOffer(null)
    }
    const video = videoRef.current
    setStatusRaw((s) =>
      /^Restarting/i.test(s) ? (video && !video.paused ? 'Playing' : 'Ready') : s,
    )
  }

  function restartEpisode() {
    if (isPip || isTile) return
    const video = videoRef.current
    if (!video) return
    // Continue watching is cleared in saveContinueProgress once the playhead is
    // really back near 0 (or the guard gives up after RESTART_GUARD_MS and the old
    // resume point stays).
    restartGuardRef.current = true
    restartGuardUntilRef.current = Date.now() + RESTART_GUARD_MS
    // saveContinueProgress only runs on playback ticks; this ends the guard (and
    // the Restarting… status) even when the video sits paused or never loads.
    const checkRestartGuard = () => {
      if (!restartGuardRef.current) return
      const left = restartGuardUntilRef.current - Date.now()
      if (left > 0) {
        window.setTimeout(checkRestartGuard, left + 250)
        return
      }
      const v = videoRef.current
      const t = v && Number.isFinite(v.currentTime) ? v.currentTime + timelineOffsetRef.current : 0
      finishRestartGuard(Boolean(v && !v.error && v.currentSrc && t < 5))
    }
    window.setTimeout(checkRestartGuard, RESTART_GUARD_MS + 250)
    resumePendingRef.current = false
    resumeKeyRef.current = `${item.id}:${playlistIndex}:restart`
    autoSeekResumeOnceRef.current = 0
    stallHoldPlayheadRef.current = 0
    pendingNativeSeekRef.current = null
    seekGuardUntilRef.current = Date.now() + 18_000
    setResumeOffer(null)
    skipDismissedRef.current = null
    setSkipTarget(null)
    setPlaybackClock((prev) => ({ ...prev, current: 0 }))
    const hadOffset = timelineOffsetRef.current > 0
    setTimelineOffsetSeconds(0)
    watchClockRef.current = { lastTs: 0, accrued: 0 }

    const raw = activePlaylistItem.url || item.url || video.currentSrc
    const url = stripResumeOffset(raw)
    const hadError = Boolean(error) || Boolean(video.error)
    const hls = hlsInstanceRef.current
    // Decide from the URL that is actually playing, not item.httpReferrer or a
    // referrer left over from an earlier Movy attempt. Anime often falls back to
    // a Nyaa torrent; the stale Movy referrer sent every Restart down the
    // re-resolve path, which got the same local stream URL back and never reloaded.
    const localStream = isEphemeralLocalStreamUrl(url) || isRemuxPlaybackUrl(url)
    const remoteHostedHls = isMovyStreamUrl(url) || ATLANTIC_HLS_URL_RE.test(url)
    // Remote element with nothing loaded (readyState 0) can't seek in place: re-resolve.
    const remoteNotLoaded = !localStream && video.readyState === 0
    const freshSource = !localStream && (hadError || remoteHostedHls || remoteNotLoaded)
    const logRestart = (branch: string) =>
      subsLog('player.restart', {
        branch,
        host: url,
        local: localStream,
        hadError,
        readyState: video.readyState,
      })

    setError(null)
    setStatus('Restarting…')

    // Movy signed URLs expire mid-title, so Restart mints a fresh source instead
    // of reloading the dead playlist that stalled at e.g. 3:10.
    if (freshSource) {
      // Re-resolving can take ~40s on anime; the success path re-arms a fresh
      // RESTART_GUARD_MS window once the new source is handed to the player.
      restartGuardUntilRef.current = Date.now() + RESTART_GUARD_MS + 45_000
      hlsStallRemountRef.current = { key: '', count: 0, playStableSince: 0 }
      if (hlsFallbackMetaRef.current) {
        hlsFallbackMetaRef.current.busy = false
        hlsFallbackMetaRef.current.tried = false
      }
      // Stop the old picture/audio so it can't keep playing (or re-pin its
      // playhead through stall recovery) while the new source resolves.
      try {
        video.pause()
      } catch {
        /* ignore */
      }
      flash('Restarting with a fresh source…')
      bumpChrome()
      logRestart(
        hadError
          ? 'fresh-source (error)'
          : remoteNotLoaded
            ? 'fresh-source (not loaded)'
            : 'fresh-source (hosted HLS)',
      )
      void selectPlaylistItemRef.current(playlistIndex, {
        force: true,
        rotateSource: true,
        fromRestart: true,
      })
      return
    }

    // Desktop remux / torrent pipe: reopen without t= so ffmpeg starts at 0. Local only:
    // remote signed URLs carry their own t= (MovieBox `&t=<unix>`); rewriting those broke
    // the signature, so the first Restart only moved the seek bar.
    const hadRemuxSeek =
      localStream &&
      (isRemuxPlaybackUrl(raw) ||
        isRemuxPlaybackUrl(url) ||
        /[?&]t=\d+/.test(video.currentSrc) ||
        hadOffset)
    if (hadRemuxSeek) {
      logRestart('reopen-local-remux')
      try {
        const parsed = new URL(url)
        parsed.searchParams.set('r', String(Date.now()))
        video.src = parsed.toString()
      } catch {
        video.src = url
      }
      video.load()
      void video.play().catch(() => setStatus('Press play'))
      flash('Restarted from beginning')
      bumpChrome()
      return
    }

    // Errored local torrent stream (Android /stream/<hash>), or an HLS URL with no
    // live session: full remount from the start. (currentTime=0 alone left anime
    // stuck after a bad scrub with "HLS load timed out".)
    if ((localStream && hadError) || (isHlsUrl(url) && !hls)) {
      logRestart('remount')
      setRetryTick((n) => n + 1)
      flash('Restarted from beginning')
      bumpChrome()
      return
    }

    // Healthy HLS: stop the old window, then load from 0.
    if (hls) {
      logRestart('hls-startLoad-0')
      try {
        hls.stopLoad()
      } catch {
        /* ignore */
      }
      try {
        video.currentTime = 0
        hls.startLoad(0)
      } catch {
        setRetryTick((n) => n + 1)
        flash('Restarted from beginning')
        bumpChrome()
        return
      }
      void video.play().catch(() => setStatus('Press play'))
      flash('Restarted from beginning')
      bumpChrome()
      return
    }

    // Progressive (MovieBox MP4) / mpeg-ts / local torrent stream: seek in place.
    logRestart('seek-in-place')
    try {
      video.currentTime = 0
    } catch {
      /* ignore */
    }
    void video.play().catch(() => setStatus('Press play'))
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
      resumePendingRef.current = true
      resumeKeyRef.current = `${item.id}:${playlistIndex}`
      setStatus(`Resuming at ${formatClock(target)}…`)
      const baseUrl = stripResumeOffset(playbackUrl)
      const resumeUrl = withResumeOffset(baseUrl, target)
      let settled = false
      // Never auto-jump to t=0 on a slow remux/probe — that feels like Resume
      // "restarted the episode". Keep the offer and let them retry.
      const holdResumePoint = (message: string) => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('canplay', onReady)
        video.removeEventListener('playing', onReady)
        video.removeEventListener('error', onResumeError)
        resumePendingRef.current = false
        setResumeOffer(target)
        setError(null)
        setPaused(true)
        setStatus('Resume point not ready — tap Resume when more is downloaded')
        flash(message)
      }
      const failTimer = window.setTimeout(() => {
        // Remux + audio-track probe often needs >22s on cold torrents.
        holdResumePoint('Still buffering at resume point — tap Resume again')
      }, 55_000)
      const onReady = () => {
        if (settled) return
        // Ignore a stale ready from the previous src before the resume pipe attaches.
        if (video.currentSrc && !/[?&]t=\d+/i.test(video.currentSrc) && target >= 5) {
          return
        }
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('canplay', onReady)
        video.removeEventListener('playing', onReady)
        video.removeEventListener('error', onResumeError)
        resumePendingRef.current = false
        setResumeOffer(null)
        setError(null)
        setStatus('Ready')
        flash(`Resumed at ${formatClock(target)}`)
        void video.play().catch(() => undefined)
      }
      const onResumeError = () => {
        holdResumePoint('Resume point not ready yet — tap Resume when more is downloaded')
      }
      video.addEventListener('loadeddata', onReady)
      video.addEventListener('canplay', onReady)
      video.addEventListener('playing', onReady)
      video.addEventListener('error', onResumeError)
      video.src = resumeUrl
      video.load()
      void video.play().catch(() => undefined)
      return
    }
    try {
      // HLS / MSE seeks are async — reading currentTime right after assign still
      // returns the old playhead, which falsely aborted Resume and left a seek
      // in flight (black "Buffering…" at the resume point with the button still up).
      setStatus(`Resuming at ${formatClock(target)}…`)
      resumePendingRef.current = true
      let settled = false
      const finishOk = () => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('canplay', onSeeked)
        video.removeEventListener('playing', onSeeked)
        video.removeEventListener('error', onFail)
        resumeKeyRef.current = `${item.id}:${playlistIndex}`
        resumePendingRef.current = false
        setResumeOffer(null)
        setError(null)
        setStatus('Playing')
        flash(`Resumed at ${formatClock(target)}`)
        void video.play().catch(() => undefined)
      }
      const onSeeked = () => {
        if (settled) return
        const at = Number.isFinite(video.currentTime) ? video.currentTime : 0
        // Accept near-miss (keyframe snap) — only retry if still nowhere near target.
        if (Math.abs(at - target) > 12) return
        finishOk()
      }
      const onFail = () => {
        if (settled) return
        settled = true
        window.clearTimeout(failTimer)
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('canplay', onSeeked)
        video.removeEventListener('playing', onSeeked)
        video.removeEventListener('error', onFail)
        resumePendingRef.current = false
        setStatus('Resume not ready — try again in a moment')
        flash('Resume is not ready yet — try again in a moment')
      }
      const failTimer = window.setTimeout(() => {
        if (settled) return
        const at = Number.isFinite(video.currentTime) ? video.currentTime : 0
        if (Math.abs(at - target) <= 12) {
          finishOk()
          return
        }
        onFail()
      }, 14_000)
      video.addEventListener('seeked', onSeeked)
      video.addEventListener('canplay', onSeeked)
      video.addEventListener('playing', onSeeked)
      video.addEventListener('error', onFail)
      video.currentTime = target
      // Nudge hls.js to fetch around the new playhead (VOD stalls after seek).
      try {
        hlsInstanceRef.current?.startLoad(target)
      } catch {
        /* ignore */
      }
      void video.play().catch(() => undefined)
    } catch {
      resumePendingRef.current = false
      flash('Resume is not ready yet — try again in a moment')
    }
  }

  useEffect(() => {
    let cancelled = false
    // Always drop cues when the episode has no sub URL (or on episode change).
    // Keeping prior cues here left E02 text on screen while watching E05.
    if (!subtitleUrl) {
      setSubtitleCues([])
      setSubtitleLine('')
      setSubsStatus('idle')
      return
    }
    // Keep existing cues visible during a manual re-fetch so toggle doesn't blank the screen.
    if (subsFetchTick === 0 || subtitleCues.length === 0) {
      setSubtitleCues([])
      setSubtitleLine('')
    }

    setSubsStatus((prev) => (prev === 'ready' && subtitleCues.length > 0 ? prev : 'loading'))
    subsExtractDoneRef.current = false
    const startedAt = Date.now()
    // Keep refreshing for a long time — progressive extract fills cues as the
    // torrent downloads; stopping early makes subs vanish mid-episode.
    const maxWaitMs = 3 * 60 * 60 * 1000
    let latestCount = 0
    let lastCueEnd = 0
    const sidecar = subtitleKind === 'file' || /^https?:\/\//i.test(subtitleUrl)
    const remoteSidecar =
      sidecar && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(subtitleUrl)
    // Local torrent extract (Android /subs.vtt, desktop /subs-cache): the VTT grows while
    // ffmpeg reads the file, so keep polling until the server says done.
    const localExtract = !remoteSidecar && subtitleKind !== 'file'

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
              let referer = 'https://rivestream.ru/'
              let origin = 'https://rivestream.ru'
              try {
                const host = new URL(subtitleUrl!).hostname
                if (!/rivestream/i.test(host)) {
                  origin = new URL(subtitleUrl!).origin
                  referer = `${origin}/`
                }
              } catch {
                /* keep rivestream referer */
              }
              const remote = await nativeFetchText(subtitleUrl!, {
                quiet: true,
                headers: isBiliSubtitleUrl(subtitleUrl)
                  ? // Bilibili CDNs reject their own origin as Referer (hotlink rule).
                    biliSubtitleHeaders(subtitleUrl!)
                  : {
                      Accept: 'text/vtt,text/plain,application/x-subrip,*/*',
                      Referer: referer,
                      Origin: origin,
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
              // Local torrent extract: send the position so desktop / Android can start
              // (or move) the extract near it instead of crawling up from 0:00.
              const video = videoRef.current
              const at =
                localExtract && video
                  ? `&at=${Math.max(0, Math.floor(absolutePlayhead(video) - subtitleDelayRef.current))}`
                  : ''
              const response = await fetch(`${subtitleUrl}${sep}t=${Date.now()}${force}${at}`)
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
            // Translation may send the (still growing) last chunk once the source is complete.
            if (extractDone || (remoteSidecar && cues.length > 0)) subsExtractDoneRef.current = true
            const notASubtitle = sidecar && text.length > 40 && !text.includes('-->')
            // Wyzie free-plan ad dump — drop and let Nyaa / next source try.
            // VTT conversion sometimes returns the ad; the raw SRT is still usable.
            if (
              sidecar &&
              cues.length === 0 &&
              isJunkSubtitleText(text) &&
              /[?&]to=vtt/i.test(subtitleUrl!)
            ) {
              const plain = subtitleUrl!
                .replace(/([?&])to=vtt&?/gi, '$1')
                .replace(/([?&])plain=1&?/gi, '$1')
                .replace(/[?&]$/, '')
              if (plain !== subtitleUrl && /^https?:\/\//i.test(plain)) {
                if (!cancelled) {
                  setLocalPlaylist((prev) => {
                    const base = prev ?? item.playlist ?? []
                    return base.map((row, i) =>
                      i === playlistIndex ? { ...row, subtitleUrl: plain, subtitleKind: 'file' } : row,
                    )
                  })
                }
                break
              }
            }
            if (sidecar && cues.length === 0 && (isJunkSubtitleText(text) || notASubtitle)) {
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
                const firstCues = latestCount === 0
                latestCount = cues.length
                if (firstCues && localExtract && !cancelled) flash('Subtitles ready')
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
            if (sidecar && latestCount > 0 && (extractDone || (!localExtract && latestCount > 20))) {
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
            if (/no (usable )?(text )?subtitle track|only image subtitles/i.test(httpBody)) {
              // Probe finished: this release has no embedded softsubs — drop the
              // local URL so Wyzie / OpenSubtitles / Nyaa can still attach. Signs/Songs-only
              // releases land here too; never pick that release again as a subtitle sidecar.
              if (!cancelled && !remoteSidecar) {
                const sidecarHash = markNyaaSubtitleSourceUnusable(subtitleUrl!)
                const playing = String(activePlaylistItem.url || item.url || '').toLowerCase()
                if (
                  sidecarHash &&
                  sidecarHash !== String(item.torrentInfoHash || '').toLowerCase() &&
                  !playing.includes(sidecarHash)
                ) {
                  // Subtitle-only swarm: stop downloading the whole episode in the background.
                  void torrentStop(sidecarHash).catch(() => {})
                }
                setSubtitleCues([])
                setSubsStatus('idle')
                movySubsSidecarRef.current = ''
                setLocalPlaylist((prev) => {
                  const base = prev ?? item.playlist ?? []
                  return base.map((row, i) =>
                    i === playlistIndex
                      ? { ...row, subtitleUrl: undefined, subtitleKind: undefined }
                      : row,
                  )
                })
              }
              break
            }
            if (/not ready|timed out|read failed|could not read/i.test(httpBody)) {
              await new Promise((resolve) =>
                window.setTimeout(
                  resolve,
                  sidecar && !localExtract
                    ? 800
                    : localExtract
                      ? isDesktopTorrentAvailable()
                        ? 800
                        : 2000
                      : 5000,
                ),
              )
              continue
            }
          }
        } catch {
          /* retry while torrent pieces / ffmpeg catch up */
        }
        // Keep polling even after "done" if cues look short for a long title —
        // progressive extract often resumes after an early EOF.
        // Local extract: fast until the first cues land, then every 2s while it grows.
        await new Promise((resolve) =>
          window.setTimeout(resolve, sidecar && (!localExtract || latestCount === 0) ? 700 : 2000),
        )
      }
      if (!cancelled && latestCount === 0) setSubsStatus('missing')
    }

    void loadSubtitles()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subtitleCues only used to avoid blanking on manual refetch
  }, [subtitleUrl, subtitleKind, playlistIndex, subsFetchTick])

  /** Non-English / M2Box / Movy / anime: Wyzie → OpenSubtitles → Nyaa when needed. */
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
    const isM2BoxPlay =
      isM2BoxCatalogItem(item) || item.tags?.some((t) => /^m2box$/i.test(String(t)))
    const canTitleLookup =
      isM2BoxPlay ||
      item.category === 'series' ||
      item.category === 'anime' ||
      item.category === 'kids'
    if (
      !isMovyPlay &&
      !isAtlanticPlay &&
      !rivestreamTmdbIdFromItem(item) &&
      !canTitleLookup
    ) {
      return
    }

    const knownTmdbId = rivestreamTmdbIdFromItem(item)
    const canNyaa =
      isTorrentPlaybackAvailable() &&
      (shouldTryNyaaForItem(item) ||
        item.category === 'series' ||
        item.category === 'anime' ||
        item.category === 'kids' ||
        Boolean(item.rivestreamTmdbId) ||
        Boolean(knownTmdbId) ||
        isM2BoxPlay)
    if (!knownTmdbId && !canTitleLookup && !canNyaa) return

    const epKey = playlistEpisodeKey(activePlaylistItem) || ''
    const sidecarKey = `${item.id}|${playlistIndex}|${epKey}`
    if (movySubsSidecarRef.current === sidecarKey) return
    movySubsSidecarRef.current = sidecarKey

    const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(epKey)
    const season = seMatch ? Number(seMatch[1]) : 1
    const episode = seMatch ? Number(seMatch[2]) : playlistIndex + 1
    const showName = cleanShowDisplayTitle(item.title) || item.title

    let settled = false
    let cancelled = false
    setSubsSearch('off')

    /** Backoff sleep that a manual retry (Subs tap) or cleanup can cut short. */
    const sleepWakeable = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.clearTimeout(timer)
          if (sidecarWakeRef.current === done) sidecarWakeRef.current = null
          resolve()
        }
        const timer = window.setTimeout(done, ms)
        sidecarWakeRef.current = done
      })

    const giveUp = (retryable: boolean) => {
      settled = true
      if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
      setSubsSearch(retryable ? 'retryable' : 'off')
      flash('No subtitles for this episode')
    }

    const applySubs = (
      url: string,
      kind?: 'file' | 'embedded',
      label = 'Subtitles ready',
      extra?: { language?: string; needsTranslation?: boolean },
    ) => {
      if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
      setSubsSearch('off')
      setLocalPlaylist((prev) => {
        const base = prev ?? item.playlist ?? []
        return base.map((row, i) =>
          i === playlistIndex
            ? {
                ...row,
                subtitleUrl: url,
                subtitleKind: kind,
                subtitleLanguage: extra?.language,
                subtitleNeedsTranslation: extra?.needsTranslation,
              }
            : row,
        )
      })
      setSubsFetchTick((n) => n + 1)
      flash(label)
    }

    /** Original-language Wyzie/OpenSubtitles track to translate when nothing better exists. */
    let translationFallback: Awaited<ReturnType<typeof ensureEpisodeSoftSubtitles>>['translationFallback']
    const applyTranslationFallback = (): boolean => {
      if (!translationFallback) return false
      settled = true
      applySubs(
        translationFallback.subtitleUrl,
        translationFallback.subtitleKind,
        `${translationFallback.language ? subtitleLanguageLabel(translationFallback.language) : 'Other-language'} subtitles found - translating`,
        { language: translationFallback.language, needsTranslation: true },
      )
      return true
    }

    ;(async () => {
      try {
        const softMissKey = `${knownTmdbId || showName}|${season}|${episode}|${skipWyzieSubsRef.current ? 'nw' : 'w'}`
        if ((knownTmdbId || canTitleLookup) && softSubsMissByEpisode.get(softMissKey) !== sidecarRetryTick) {
          flash('Finding subtitles…')
          const soft = await ensureEpisodeSoftSubtitles({
            title: showName,
            item,
            tmdbId: knownTmdbId || undefined,
            season,
            episode,
            skipWyzie: skipWyzieSubsRef.current,
            // Native series / anime pipes without captions should still try.
            force:
              isMovyPlay ||
              isAtlanticPlay ||
              isM2BoxPlay ||
              shouldPreferRivestreamJapaneseAudio(item),
          })
          if (cancelled) return
          if (soft.subtitleUrl) {
            settled = true
            const label =
              soft.source === 'opensubtitles'
                ? 'Subtitles ready (OpenSubtitles)'
                : 'Subtitles ready (Wyzie)'
            applySubs(soft.subtitleUrl, soft.subtitleKind, label)
            return
          }
          translationFallback = soft.translationFallback
          // English titles that don't need softsubs — stop quietly.
          if (!soft.needsSoftSubs) {
            settled = true
            return
          }
          softSubsMissByEpisode.set(softMissKey, sidecarRetryTick)
        }
        if (!canNyaa) {
          if (applyTranslationFallback()) return
          giveUp(false)
          return
        }
        flash('Finding subtitles…')
        const sidecarOpts = { showTitle: showName, season, episode }
        // Manual Retry Subs (tick bumped): try releases that failed or were unusable again.
        if (sidecarRetryTick > 0 && sidecarRetryTick !== sidecarResetTickRef.current) {
          sidecarResetTickRef.current = sidecarRetryTick
          resetNyaaSubtitleSidecarFailures(sidecarOpts)
        }
        let subs = await resolveNyaaSubtitleSidecar(sidecarOpts)
        if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
        if (!subs?.subtitleUrl && isNyaaSubtitleSidecarPending(sidecarOpts)) {
          // The release torrent is still starting (native engine may take up to ~3 min).
          // Keep checking in the background; the torrent is reused, never restarted.
          setSubsSearch('searching')
          flash('Looking for subtitles…')
          const backoffMs = isDesktopTorrentAvailable()
            ? SIDECAR_RETRY_BACKOFF_DESKTOP_MS
            : SIDECAR_RETRY_BACKOFF_ANDROID_MS
          const windowMs = isDesktopTorrentAvailable() ? SIDECAR_RETRY_WINDOW_MS : SIDECAR_RETRY_WINDOW_ANDROID_MS
          const deadline =
            Date.now() +
            (translationFallback ? Math.min(windowMs, SIDECAR_WAIT_WITH_TRANSLATION_FALLBACK_MS) : windowMs)
          if (translationFallback) {
            subsLog('softsubs.translate-fallback.wait', {
              season,
              episode,
              language: translationFallback.language,
              waitMs: Math.min(windowMs, SIDECAR_WAIT_WITH_TRANSLATION_FALLBACK_MS),
              reason: 'Nyaa release still starting - translating the fallback track if it does not arrive',
            })
          }
          // A release torrent becoming ready (or failing) wakes the wait immediately.
          const unsubscribeSettle = onNyaaSubtitleSidecarSettled(() => sidecarWakeRef.current?.())
          try {
            for (let attempt = 0; Date.now() < deadline; attempt++) {
              await sleepWakeable(backoffMs[Math.min(attempt, backoffMs.length - 1)]!)
              if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
              subs = await resolveNyaaSubtitleSidecar({ ...sidecarOpts, budgetMs: 8_000 })
              if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
              if (subs?.subtitleUrl) break
              if (!isNyaaSubtitleSidecarPending(sidecarOpts)) break
            }
          } finally {
            unsubscribeSettle()
          }
        }
        if (!subs?.subtitleUrl) {
          // Nyaa had nothing: translate the original-language track if one was found.
          if (applyTranslationFallback()) return
          // Window over (or every release failed): manual retry stays available.
          giveUp(true)
          return
        }
        settled = true
        // Local torrent extract: the URL exists before ffmpeg has produced cues, so don't
        // claim "ready" yet; loadSubtitles flashes it when the first cues arrive.
        const localExtractUrl =
          subs.subtitleKind !== 'file' &&
          /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(subs.subtitleUrl)
        applySubs(
          subs.subtitleUrl,
          subs.subtitleKind,
          localExtractUrl ? 'Loading subtitles…' : 'Subtitles ready',
        )
        // Only this release's subs are read: stop the episode's other sidecar swarms.
        // Never the playing torrent (its hash or one inside the playing URL).
        const protectHashes = [
          String(item.torrentInfoHash || '').toLowerCase(),
          ...(String(item.url || '').toLowerCase().match(/[a-f0-9]{40}/g) || []),
        ].filter(Boolean)
        releaseOtherNyaaSubtitleSidecars(sidecarOpts, subs.subtitleUrl, protectHashes)
      } catch {
        if (cancelled || movySubsSidecarRef.current !== sidecarKey) return
        giveUp(true)
      }
    })()

    return () => {
      cancelled = true
      // End any pending backoff sleep so the loop exits now (no stacked timers).
      sidecarWakeRef.current?.()
      if (!settled && movySubsSidecarRef.current === sidecarKey) {
        movySubsSidecarRef.current = ''
      }
    }
  }, [
    subtitleUrl,
    item.id,
    item.category,
    item.title,
    item.rivestreamTmdbId,
    item.cinetaroTmdbId,
    item.netmirrorTmdbId,
    item.m2boxSubjectId,
    item.originalLanguage,
    item.httpReferrer,
    playlistIndex,
    activePlaylistItem.episodeKey,
    activePlaylistItem.title,
    activePlaylistItem.fileName,
    sidecarRetryTick,
  ])

  useEffect(() => {
    // Per-episode sync — anime gets a default +delay so softsubs aren't ahead of audio.
    // Bilibili's own tracks are timed to the Bilibili video, so they start at 0.
    const delay = isBiliSubtitleUrl(subtitleUrl) ? 0 : initialSubtitleDelayForCategory(item.category)
    subtitleDelayRef.current = delay
    setSubtitleDelaySec(delay)
  }, [subtitleUrl, playlistIndex, item.category])

  useEffect(() => {
    skipWyzieSubsRef.current = false
    // New episode: drop any "Looking for subtitles" / "Retry Subs" state from the last one.
    setSubsSearch('off')
  }, [playlistIndex, item.id])

  // New subtitle source: forget the previous track's translation / Translate offer.
  useEffect(() => {
    setTranslateOffer(null)
    setTranslationSnap(null)
    setTranslateMode('translated')
    translationStatusRef.current = null
    // Cues still in state belong to the previous track until loadSubtitles replaces them.
    staleTranslateCuesRef.current = subtitleCues.length ? subtitleCues : null
    return () => {
      translationRef.current?.dispose()
      translationRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per track only
  }, [subtitleUrl, playlistIndex, item.id])

  /**
   * In-app subtitle translation (same on desktop dev, installed Windows and Android):
   * decide once per track whether it needs translating, then feed every (growing) cue
   * list to the session, which only translates chunks it has not translated yet.
   */
  useEffect(() => {
    if (!subtitleUrl || subtitleCues.length === 0) return
    if (subtitleCues === staleTranslateCuesRef.current) return
    const target = getPreferredSubtitleLanguage()
    const sessionKey = `${subtitleUrl}|${target}`
    let session = translationRef.current
    if (session && session.key !== sessionKey) {
      session.dispose()
      translationRef.current = null
      session = null
      setTranslationSnap(null)
    }
    if (!session) {
      let detected = activePlaylistItem.subtitleNeedsTranslation
        ? normalizeLanguageCode(activePlaylistItem.subtitleLanguage)
        : ''
      if (!detected) {
        const cached = detectedSubLangRef.current
        if (cached && cached.url === subtitleUrl) {
          detected = cached.lang
        } else {
          // Early cues of a growing extract are too few to judge the language.
          if (subtitleCues.length < 20 && !subsExtractDoneRef.current) return
          detected = detectCueLanguage(subtitleCues)
          detectedSubLangRef.current = { url: subtitleUrl, lang: detected }
        }
      }
      if (detected && detected === target) {
        setTranslateOffer(null)
        return
      }
      const manual = translateManualKeyRef.current === sessionKey
      const auto =
        getAutoTranslateSubsPref() &&
        (Boolean(activePlaylistItem.subtitleNeedsTranslation) || Boolean(detected))
      if (!manual && !auto) {
        setTranslateOffer(detected || 'auto')
        return
      }
      setTranslateOffer(null)
      setTranslateMode('translated')
      translationStatusRef.current = null
      let announced = false
      const created: SubtitleTranslationSession = new SubtitleTranslationSession({
        key: sessionKey,
        src: detected || 'auto',
        tgt: target,
        getPlayhead: () => {
          const video = videoRef.current
          return video ? absolutePlayhead(video) - subtitleDelayRef.current : 0
        },
        isComplete: () => subsExtractDoneRef.current,
        // Names glossary + show / episode / synopsis context (TMDB; optional, bounded).
        loadAids: async () => {
          const isMovie = item.category === 'movies'
          const epKey = playlistEpisodeKey(activePlaylistItem) || ''
          const se = /^S(\d{1,2})E(\d{1,4})$/i.exec(epKey)
          const showTitle = cleanShowDisplayTitle(item.title) || item.title
          let tmdbId = rivestreamTmdbIdFromItem(item) || ''
          if (item.category === 'anime') {
            tmdbId = (await resolveAnimeTmdbTvId(item.title, tmdbId || null).catch(() => null)) || tmdbId
          }
          return loadTranslationAids({
            tmdbId,
            kind: isMovie ? 'movie' : 'tv',
            season: isMovie ? undefined : se ? Number(se[1]) : 1,
            episode: isMovie ? undefined : se ? Number(se[2]) : playlistIndex + 1,
            showTitle,
          })
        },
        onChange: (snap) => {
          if (translationRef.current !== created) return
          setTranslationSnap(snap)
          const prev = translationStatusRef.current
          translationStatusRef.current = snap.status
          if (snap.status === 'unavailable' && prev !== 'unavailable') {
            flash('Translation unavailable - showing original subtitles')
          } else if (!announced && snap.translatedCues > 0) {
            announced = true
            flash(`Subtitles translated to ${subtitleLanguageLabel(snap.tgt)}`)
          }
        },
      })
      translationRef.current = created
      setTranslationSnap(created.snapshot())
      session = created
    }
    session.update(subtitleCues)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per cue update / manual Translate
  }, [subtitleCues, subtitleUrl, translateRequestTick])

  /** Cues actually drawn: translated text when a translation exists and is selected. */
  const displayCues = useMemo(
    () =>
      translateMode === 'translated' &&
      translationRef.current &&
      translationSnap &&
      translationSnap.translatedCues > 0
        ? translationRef.current.apply(subtitleCues)
        : subtitleCues,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- translationSnap changes when chunks land
    [subtitleCues, translationSnap, translateMode],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const syncCue = () => {
      if (!subsEnabledRef.current || displayCues.length === 0) {
        setSubtitleLine('')
        return
      }
      // Remux resume uses ffmpeg -ss, so video.currentTime is relative — add offset.
      // Subtract delay so positive delay pushes cues later (VLC-style).
      // absolutePlayhead tracks the title clock so cues stay locked to audio.
      setSubtitleLine(
        activeSubtitleText(
          displayCues,
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
    displayCues,
    subsEnabled,
    activePlaylistItem.url,
    playlistIndex,
    timelineOffset,
    subtitleDelaySec,
    videoMountKey,
  ])

  function toggleSubtitles() {
    bumpChrome()
    if (!subtitleUrl && subsSearch === 'searching') {
      // Background search running: check right now instead of waiting for the backoff.
      sidecarWakeRef.current?.()
      flash('Looking for subtitles…')
      return
    }
    if (!subtitleUrl && subsSearch === 'retryable') {
      // Manual retry: re-run the subtitle search for this episode (torrents are reused).
      setSubsEnabled(true)
      movySubsSidecarRef.current = ''
      setSidecarRetryTick((n) => n + 1)
      flash('Looking for subtitles…')
      return
    }
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

  /** Translate button: start an on-demand translation, or retry after it was unavailable. */
  function requestTranslate() {
    bumpChrome()
    const session = translationRef.current
    if (session) {
      session.retry()
      setTranslateMode('translated')
      flash('Retrying translation\u2026')
      return
    }
    if (!subtitleUrl) return
    const target = getPreferredSubtitleLanguage()
    translateManualKeyRef.current = `${subtitleUrl}|${target}`
    setTranslateRequestTick((n) => n + 1)
    flash(`Translating subtitles to ${subtitleLanguageLabel(target)}\u2026`)
  }

  /** Translated / Original toggle (keeps both versions; timings are identical). */
  function toggleTranslateMode() {
    if (translationSnap?.status === 'unavailable') {
      requestTranslate()
      return
    }
    bumpChrome()
    setTranslateMode((mode) => {
      const next = mode === 'translated' ? 'original' : 'translated'
      flash(next === 'translated' ? 'Showing translated subtitles' : 'Showing original subtitles')
      return next
    })
  }

  function nudgeSubtitleDelay(delta: number) {
    const next = Math.round((subtitleDelayRef.current + delta) * 10) / 10
    const clamped = Math.max(-15, Math.min(15, next))
    subtitleDelayRef.current = clamped
    setSubtitleDelaySec(clamped)
    if (item.category === 'anime' && !isBiliSubtitleUrl(subtitleUrl)) writeAnimeSubtitleDelay(clamped)
    bumpChrome()
  }

  function resetSubtitleDelay() {
    subtitleDelayRef.current = 0
    setSubtitleDelaySec(0)
    if (item.category === 'anime' && !isBiliSubtitleUrl(subtitleUrl)) writeAnimeSubtitleDelay(0)
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
      if (item.category === 'anime' && !isBiliSubtitleUrl(subtitleUrl)) writeAnimeSubtitleDelay(result.delaySec)
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
        return false
      }
      meta.tried = true
      activePlaybackReferrerRef.current = alt.referer || ATLANTIC_PLAY_REFERER
      rememberLastGoodPlay(
        playReliabilityKey({
          itemId: item.id,
          tmdbId: meta.tmdbId,
          mediaType: meta.mediaType,
          season: meta.season,
          episode: meta.episode,
        }),
        'atlantic',
        { provider: alt.provider },
      )
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
        // Stall recovery: jump back to where they were once the new HLS is ready.
        autoSeekResumeOnceRef.current = resumeAt
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
      return false
    } finally {
      if (hlsFallbackMetaRef.current) hlsFallbackMetaRef.current.busy = false
    }
  }

  async function selectPlaylistItem(
    index: number,
    options?: {
      force?: boolean
      rotateTorrent?: boolean
      rotateSource?: boolean
      /** Same-episode Restart: clear stall/auto-seek targets and always remount. */
      fromRestart?: boolean
    },
  ) {
    if (index < 0 || index >= playlist.length) return
    if (index === playlistIndex && !options?.force && !options?.rotateSource) return
    // Never hard-block other episodes while one resolve is in flight — that left
    // anime stuck after a mid-play stall (Next / Restart / other eps did nothing).
    if (episodeLoading) {
      episodeFailGenRef.current += 1
    }
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
    const hasPlayableHttp =
      Boolean(entry.url) &&
      /^https?:\/\//i.test(entry.url) &&
      !isEphemeralLocalStreamUrl(entry.url)
    const movyStyleUrl =
      isMovyStreamUrl(entry.url) || /[?&]type=m3u8\b/i.test(entry.url || '')
    // Always re-resolve torrent episodes. Sibling entries often still hold a
    // 127.0.0.1 remux URL from earlier, but torrentStop() kills that swarm —
    // reusing it shows "Native playback failed".
    const needsTorrent =
      (baseCandidates.length > 0 || useTorrentio) &&
      (options?.force ||
        options?.rotateTorrent ||
        options?.rotateSource ||
        !hasPlayableHttp ||
        isEphemeralLocalStreamUrl(entry.url || ''))
    const needsM2Box =
      isM2BoxCatalogItem(item) &&
      (Boolean(options?.rotateSource) ||
        !hasPlayableHttp ||
        /hakunaymatata\.com|aoneroom\.com/i.test(entry.url || ''))
    // If the playlist already carries Nyaa/torrent magnets, use those — don't
    // bounce back into Rive (which often only has a dead embed shell).
    // Movy signed playlists expire — re-resolve on episode change / force / rotate.
    // Single-file movie on a Movy / Atlantic / Streamo HLS pipe: Retry and stall
    // remints re-resolve the *movie* (the TV branch below asked for S1E1) and rotate
    // away from the city that just played.
    const movieTmdbId =
      item.category === 'movies' && playlist.length <= 1 && !entry.torrentUri
        ? rivestreamTmdbIdFromItem(item)
        : ''
    const movieOnHlsPipe =
      movyStyleUrl ||
      Boolean(getMovyPlaySession(entry.url)) ||
      ['movy', 'atlantic', 'streamo'].includes(
        inferPlayPipe({ url: entry.url, referrer: activePlaybackReferrerRef.current }) ?? '',
      ) ||
      Boolean(item.tags?.some((t) => /^(movy|atlantic|streamo)$/i.test(t)))
    const needsMovyMovie =
      Boolean(movieTmdbId) &&
      movieOnHlsPipe &&
      (Boolean(options?.rotateSource) || (movyStyleUrl && Boolean(options?.force)))
    const needsRivestream =
      !needsMovyMovie &&
      isRivestreamShow &&
      !entry.torrentUri &&
      (options?.rotateSource ||
        !hasPlayableHttp ||
        (movyStyleUrl && (options?.force || index !== playlistIndex)))

    // Show the target episode in chrome immediately.
    setLoadingPlaylistIndex(index)
    if (episodeFailTimerRef.current) {
      window.clearTimeout(episodeFailTimerRef.current)
      episodeFailTimerRef.current = 0
    }
    const failGen = ++episodeFailGenRef.current
    const animeAudioGen = ++animeAudioGenRef.current
    setAnimeAudioChoice(null)
    setAnimeAudioMode('sub')

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
      if (options?.fromRestart) finishRestartGuard(false)
      setEpisodeLoading(false)
      setMediaReady(false)
      setLoadingPlaylistIndex(null)
      // Stay on the episode the user chose (don't snap back to episode 1).
      setPlaylistIndex(index)
      clearVideoSource()

      const epLabel = episodeKey || `episode ${index + 1}`
      const userMessage = message.includes(epLabel)
        ? message
        : `${message} (${epLabel})`

      // Auto-skip is torrent-only (dead magnet swarms). Movy/HLS misses must not
      // silently jump E1 → E2 → E3 when a provider times out.
      const dead = needsTorrent && DEAD_SWARM_RE.test(message)
      if (!dead) {
        episodeFailRef.current = { index: -1, fails: 0 }
        setError(userMessage)
        setStatus(userMessage)
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
        flash(`No working torrent for ${epLabel} — trying ${nextKey}`)
        episodeFailTimerRef.current = window.setTimeout(() => {
          if (episodeFailGenRef.current !== failGen) return
          void selectPlaylistItemRef.current(next)
        }, 650)
        return
      }

      setError(userMessage)
      setStatus(userMessage)
    }

    if (needsM2Box) {
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus('Loading episode…')
      setError(null)
      try {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(episodeKey)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        // Anime Sub / Dub: M2Box lists the English dub ("… [English]") and the original
        // as separate subjects. Play the one the preference asks for; any miss plays
        // this row as before.
        const m2Anime = shouldPreferRivestreamJapaneseAudio(item)
        const isDubRow = isAnimeDubRowItem(item)
        let m2Info: AnimeDubInfo | null | undefined
        let m2Mode: AnimeAudioMode = isDubRow ? 'dub' : 'sub'
        let resolved: Awaited<ReturnType<typeof resolveM2BoxPlay>> | null = null
        if (m2Anime) {
          const want: AnimeAudioMode = isDubRow
            ? getShowAnimeAudioMode(animeShowTitle) ?? 'dub'
            : effectiveAnimeAudioMode(animeShowTitle)
          if (want !== m2Mode) {
            setStatus(want === 'dub' ? 'Looking for the English dub…' : 'Looking for Japanese audio…')
            m2Info = await withTimeout(
              findAnimeEnglishDub(animeShowTitle),
              10_000,
              'Dub lookup timed out.',
            ).catch(() => null)
            if (episodeFailGenRef.current !== failGen) return
            const alt = want === 'dub' ? m2Info?.dub : m2Info?.original
            if (m2Info && alt && animeDubHasEpisode(m2Info, season, episode)) {
              const altResolved = await withTimeout(
                resolveM2BoxPlay(animeDubDetailUrl(alt), {
                  subjectId: alt.subjectId,
                  season,
                  episode,
                }),
                20_000,
                'Audio took too long to open.',
              ).catch(() => null)
              if (episodeFailGenRef.current !== failGen) return
              if (altResolved?.ok && altResolved.url) {
                resolved = altResolved
                m2Mode = want
              }
            }
            if (!resolved && want === 'dub') {
              flash('No English dub for this episode — Japanese with subtitles')
            }
          }
        }
        if (!resolved) {
          resolved = await resolveM2BoxPlay(item.detailUrl || item.url, {
            subjectId: item.m2boxSubjectId,
            season,
            episode,
          })
        }
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
        let subtitleUrl: string | undefined
        let subtitleKind: 'file' | undefined
        try {
          const showName = cleanShowDisplayTitle(item.title) || item.title
          const soft = await ensureEpisodeSoftSubtitles({
            title: showName,
            item,
            season,
            episode,
            skipWyzie: skipWyzieSubsRef.current,
          })
          if (episodeFailGenRef.current !== failGen) return
          subtitleUrl = soft.subtitleUrl
          subtitleKind = soft.subtitleKind
        } catch {
          /* play without captions — softsub effect may still retry */
        }
        setLocalPlaylist((prev) => {
          const base = prev ?? item.playlist ?? []
          return base.map((row, i) =>
            i === index
              ? {
                  ...row,
                  url: resolved.url,
                  episodeKey: row.episodeKey || episodeKey || undefined,
                  ...(subtitleUrl ? { subtitleUrl, subtitleKind } : {}),
                }
              : row,
          )
        })
        if (subtitleUrl) setSubsFetchTick((n) => n + 1)
        setEpisodeLoading(false)
        if (m2Anime) {
          const playing = m2Mode
          if (playing === 'dub') setSubsEnabled(false)
          // Offer the button only when the other audio exists for this show.
          const mark = (info: AnimeDubInfo | null) => {
            if (!info || animeAudioGenRef.current !== animeAudioGen) return
            if (!animeDubHasEpisode(info, season, episode)) return
            if (playing === 'dub' && isDubRow && !info.original) return
            const choice: AnimeAudioChoice = { kind: 'm2box', info, index, season, episode }
            animeAudioChoiceRef.current = choice
            setAnimeAudioChoice(choice)
            setAnimeAudioMode(playing)
          }
          if (m2Info !== undefined) mark(m2Info)
          else void findAnimeEnglishDub(animeShowTitle).then(mark)
        }
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not load M2Box episode')
        return
      }
    } else if (needsMovyMovie) {
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus(options?.rotateSource ? 'Trying another source…' : 'Opening stream…')
      setError(null)
      // Keep the playhead across the source switch (tail keeps autoSeekResumeOnceRef
      // for a same-index remint).
      const video = videoRef.current
      const keepAt =
        video && !options?.fromRestart && index === playlistIndex
          ? Math.max(0, Math.floor(absolutePlayhead(video)))
          : 0
      if (keepAt > 0) pinStallPlayhead(keepAt)
      try {
        const prevSession = getMovyPlaySession(entry.url)
        const reliabilityKey = playReliabilityKey({
          itemId: item.id,
          tmdbId: movieTmdbId,
          mediaType: 'movie',
        })
        // Retry: never pin the pipe / city that just failed.
        if (options?.rotateSource) forgetLastGoodPlay(reliabilityKey)
        const yearMatch = /\b((?:19|20)\d{2})\b/.exec(String(item.title || item.description || ''))
        const movy = await withTimeout(
          resolveMovyPlay({
            tmdbId: movieTmdbId,
            title:
              prevSession?.request.title || cleanShowDisplayTitle(item.title) || item.title,
            mediaType: 'movie',
            year: prevSession?.request.year ?? yearMatch?.[1],
            originalLanguage:
              normalizeLanguageCode(item.originalLanguage) ||
              prevSession?.request.originalLanguage ||
              undefined,
            avoidProvider:
              options?.rotateSource && !options?.fromRestart ? prevSession?.provider : undefined,
          }),
          22_000,
          'Source lookup timed out.',
        )
        if (episodeFailGenRef.current !== failGen) return
        if (!movy.ok) {
          failOnEpisode(movy.error || 'No other source for this movie right now')
          return
        }
        rememberResolvedHlsPlay(reliabilityKey, movy)
        hlsFallbackMetaRef.current = {
          tmdbId: movieTmdbId,
          mediaType: 'movie',
          title: cleanShowDisplayTitle(item.title) || item.title,
          tried: movy.backend === 'atlantic',
          busy: false,
        }
        activePlaybackReferrerRef.current = movy.referer || MOVY_PLAY_REFERER
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: movy.url,
            referrer: movy.referer || MOVY_PLAY_REFERER,
          })
        }
        if (keepAt >= 5) reopenMovyAt(movy.url, keepAt, index)
        setLocalPlaylist((prev) => {
          const base = prev && prev.length > 0 ? prev : playlist
          return base.map((row, i) =>
            i === index
              ? {
                  ...row,
                  url: movy.url,
                  // Keep captions already attached; Movy's own English track wins.
                  subtitleUrl: movy.subtitleUrl || row.subtitleUrl,
                  subtitleKind: movy.subtitleUrl ? movy.subtitleKind : row.subtitleKind,
                }
              : row,
          )
        })
        if (options?.rotateSource && prevSession?.provider && prevSession.provider !== movy.provider) {
          flash('Switched to another source')
        }
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not load movie')
        return
      } finally {
        if (episodeFailGenRef.current === failGen) {
          setEpisodeLoading(false)
          setLoadingPlaylistIndex(null)
        }
      }
    } else if (needsRivestream) {
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus('Opening stream…')
      setError(null)
      // Safety: never leave Next/Restart frozen if a resolve hangs past budget.
      const loadingWatchdog = window.setTimeout(() => {
        if (episodeFailGenRef.current !== failGen) return
        setEpisodeLoading(false)
        setLoadingPlaylistIndex(null)
      }, item.category === 'anime' ? 40_000 : 25_000)
      try {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(episodeKey)
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
          let lastError = 'Could not start source'
          for (let i = 0; i < candidates.length; i++) {
            const uri = candidates[i]
            usedUri = uri
            setStatus(
              candidates.length > 1
                ? `Loading source… (${i + 1}/${candidates.length})`
                : 'Opening source…',
            )
            try {
              const attempt = await withTimeout(
                torrentStream(uri, {
                  keepOthers: inMultiview,
                  preferJapaneseAudio:
                    shouldPreferRivestreamJapaneseAudio(item) &&
                    effectiveAnimeAudioMode(animeShowTitle) !== 'dub',
                }),
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
          markRemuxDualAudio(
            animeAudioGen,
            `${nyaa.choice.title} ${result.name || ''} ${result.fileName || ''}`,
            result.url,
          )
          index = nyaa.playIndex
          // Torrent now: a Movy referrer from an earlier attempt must not stick.
          activePlaybackReferrerRef.current = ''
          rememberLastGoodPlay(
            playReliabilityKey({
              itemId: item.id,
              tmdbId: rivestreamTmdbIdFromItem(item),
              mediaType: 'tv',
              season,
              episode,
            }),
            'nyaa',
          )
          return 'played'
        }

        // Anime Sub / Dub. Dub preference: try the English dub (M2Box) first; on any miss
        // fall through to the normal Japanese chain. Sub: unchanged chain, and the dub
        // lookup runs after playback starts (cached per show) to decide on the button.
        const animeAudio = shouldPreferRivestreamJapaneseAudio(item)
        const dubFits = (info: AnimeDubInfo | null): info is AnimeDubInfo => {
          if (!info || !animeDubHasEpisode(info, season, episode)) return false
          // M2Box sometimes merges seasons (e.g. 47 eps in "S1") — numbering would be off.
          const local = playlist
            .map((row) => /^S(\d{1,2})E(\d{1,4})$/i.exec(playlistEpisodeKey(row) || ''))
            .filter((m): m is RegExpExecArray => Boolean(m) && Number(m![1]) === season)
            .map((m) => Number(m[2]))
          const localMax = local.length ? Math.max(...local) : 0
          const m2Max = info.seasons.find((s) => s.season === season)?.maxEpisode || 0
          return !localMax || !m2Max || m2Max <= localMax + 2
        }
        const markDubPicker = (info: AnimeDubInfo, playing: AnimeAudioMode) => {
          if (animeAudioGenRef.current !== animeAudioGen) return
          const cur = animeAudioChoiceRef.current
          if (cur && cur.kind !== 'm2box') return
          const choice: AnimeAudioChoice = { kind: 'm2box', info, index, season, episode }
          animeAudioChoiceRef.current = choice
          setAnimeAudioChoice(choice)
          setAnimeAudioMode(playing)
        }
        const tryPlayAnimeDub = async (): Promise<boolean> => {
          setStatus('Looking for the English dub…')
          const info = await withTimeout(
            findAnimeEnglishDub(showName),
            10_000,
            'Dub lookup timed out.',
          ).catch(() => null)
          if (episodeFailGenRef.current !== failGen) return false
          if (!dubFits(info)) {
            flash('No English dub for this episode — Japanese with subtitles')
            return false
          }
          setStatus('Opening English dub…')
          const resolved = await withTimeout(
            resolveM2BoxPlay(animeDubDetailUrl(info.dub), {
              subjectId: info.dub.subjectId,
              season,
              episode,
            }),
            20_000,
            'Dub took too long to open.',
          ).catch(() => null)
          if (episodeFailGenRef.current !== failGen) return false
          if (!resolved || !resolved.ok || !resolved.url) {
            flash('English dub unavailable right now — Japanese with subtitles')
            return false
          }
          const dubUrl = resolved.url
          hlsFallbackMetaRef.current = null
          activePlaybackReferrerRef.current = resolved.referer || ''
          if (window.signalDesktop?.setPlaybackHeaders) {
            void window.signalDesktop.setPlaybackHeaders({
              url: dubUrl,
              referrer: resolved.referer,
            })
          }
          // Subtitles stay available (Subs button) — the sidecar finds them as usual.
          setLocalPlaylist((prev) => {
            const base = prev ?? item.playlist ?? []
            return base.map((row, i) =>
              i === index
                ? {
                    ...row,
                    url: dubUrl,
                    episodeKey: row.episodeKey || episodeKey || undefined,
                    subtitleUrl: undefined,
                    subtitleKind: undefined,
                  }
                : row,
            )
          })
          markDubPicker(info, 'dub')
          setSubsEnabled(false)
          setStatus('Playing · English dub')
          return true
        }
        const dubPlayed =
          animeAudio && effectiveAnimeAudioMode(showName) === 'dub'
            ? await tryPlayAnimeDub()
            : false
        if (episodeFailGenRef.current !== failGen) return

        let tmdbId = rivestreamTmdbIdFromItem(item)
        if (dubPlayed) {
          /* English dub (M2Box) — playlist row already set */
        } else if (item.category === 'anime') {
          setStatus('Looking up show…')
          tmdbId = (await resolveAnimeTmdbTvId(item.title, tmdbId)) || ''
        } else if (!tmdbId && isYmoviesCatalogItem(item)) {
          setStatus('Looking up show…')
          tmdbId = (await lookupRivestreamTmdbId(item.title)) || ''
        }
        if (dubPlayed) {
          /* English dub playing */
        } else if (!tmdbId) {
          const nyaa = await tryPlayFromNyaa()
          if (nyaa === 'failed') return
          if (nyaa === 'skip') {
            failOnEpisode('No TMDB ID for this show')
            return
          }
          nyaaHandled = true
        } else if (!nyaaHandled) {
          const yearMatch = /\b(19|20)\d{2}\b/.exec(String(item.description || item.title || ''))
          const reliabilityKey = playReliabilityKey({
            itemId: item.id,
            tmdbId,
            mediaType: 'tv',
            season,
            episode,
          })
          // Stalled / Retry: don't pin the dead pipe that just failed.
          if (options?.rotateSource) forgetLastGoodPlay(reliabilityKey)
          const lastGood = getLastGoodPlay(reliabilityKey)
          const movy = await withTimeout(
            resolveMovyPlay({
              tmdbId,
              title: showName,
              mediaType: 'tv',
              season,
              episode,
              year: yearMatch?.[0],
              preferBackend: preferredResolveBackend(lastGood),
              preferProvider: lastGood?.provider,
              originalLanguage: normalizeLanguageCode(item.originalLanguage) || undefined,
              avoidProvider:
                options?.rotateSource && !options?.fromRestart
                  ? getMovyPlaySession(entry.url)?.provider
                  : undefined,
            }),
            item.category === 'anime' ? 35_000 : 20_000,
            'Source lookup timed out.',
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
            if (usedAtlantic) setStatus('Playing')
            rememberResolvedHlsPlay(reliabilityKey, movy)
            let subtitleUrl = movy.subtitleUrl
            let subtitleKind = movy.subtitleKind
            if (!subtitleUrl) {
              try {
                const soft = await ensureEpisodeSoftSubtitles({
                  title: showName,
                  item: { ...item, rivestreamTmdbId: tmdbId },
                  tmdbId,
                  season,
                  episode,
                  skipWyzie: skipWyzieSubsRef.current,
                  force: item.category === 'anime',
                })
                if (episodeFailGenRef.current !== failGen) return
                if (soft.subtitleUrl) {
                  subtitleUrl = soft.subtitleUrl
                  subtitleKind = soft.subtitleKind
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
            setStatus('Trying another source…')
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
                rememberLastGoodPlay(
                  playReliabilityKey({
                    itemId: item.id,
                    tmdbId,
                    mediaType: 'tv',
                    season,
                    episode,
                  }),
                  'atlantic',
                  { provider: alt.provider },
                )
                if (window.signalDesktop?.setPlaybackHeaders) {
                  void window.signalDesktop.setPlaybackHeaders({
                    url: alt.url,
                    referrer: alt.referer || ATLANTIC_PLAY_REFERER,
                  })
                }
                let subtitleUrl: string | undefined
                let subtitleKind: 'file' | 'embedded' | undefined
                try {
                  const soft = await ensureEpisodeSoftSubtitles({
                    title: showName,
                    item: { ...item, rivestreamTmdbId: tmdbId },
                    tmdbId,
                    season,
                    episode,
                    skipWyzie: skipWyzieSubsRef.current,
                    force: item.category === 'anime',
                  })
                  if (episodeFailGenRef.current !== failGen) return
                  if (soft.subtitleUrl) {
                    subtitleUrl = soft.subtitleUrl
                    subtitleKind = soft.subtitleKind
                  }
                } catch {
                  /* play without captions */
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
                setStatus('Playing')
              }
            } catch {
              /* fall through to Nyaa */
            }
            if (atlanticOk) {
              /* playlist updated */
            } else {
              // Movy/Atlantic miss — donghua chain: bilibili.tv → bilibili.com (official,
              // fan upload) → iQIYI (src/lib/donghuaResolve.ts), then Nyaa below.
              let biliOk = false
              try {
                setStatus('Searching Bilibili…')
                const bili = await withTimeout(
                  resolveDonghuaPlay({
                    title: showName,
                    altTitles: showName !== item.title ? [item.title] : [],
                    season,
                    episode,
                    episodeCountHint: playlist.length || undefined,
                    tmdbId: tmdbId || undefined,
                    cached: item.bilibiliSeasonId,
                    onStatus: (text) => {
                      if (episodeFailGenRef.current === failGen) setStatus(text)
                    },
                  }),
                  45_000,
                  'Bilibili lookup timed out.',
                )
                if (episodeFailGenRef.current !== failGen) return
                if (bili.cache && bili.cache !== item.bilibiliSeasonId) {
                  void upsertTorrentItems([{ ...item, bilibiliSeasonId: bili.cache }])
                }
                if (bili.ok) {
                  if (bili.mode === 'embed') {
                    biliOk = true
                    navigate(`/web?url=${encodeURIComponent(bili.url)}`, {
                      replace: true,
                      state: {
                        from: `/watch/${item.id}`,
                        playerMode: 'embed',
                        pipOnBack: true,
                      },
                    })
                    setEpisodeLoading(false)
                    setLoadingPlaylistIndex(null)
                    return
                  }
                  biliOk = true
                  activePlaybackReferrerRef.current = bili.referer || BILIBILI_TV_PLAY_REFERER
                  if (window.signalDesktop?.setPlaybackHeaders) {
                    void window.signalDesktop.setPlaybackHeaders({
                      url: bili.url,
                      referrer: bili.referer || BILIBILI_TV_PLAY_REFERER,
                    })
                  }
                  // Bilibili's own track (English, or Chinese → translator) wins over whatever
                  // the sidecar chain found meanwhile; none → keep the row's / chain's subs.
                  const biliSubs = bili.subtitle
                  if (biliSubs) flash(`Subtitles: ${biliSubs.label}`)
                  setLocalPlaylist((prev) => {
                    const base = prev ?? item.playlist ?? []
                    return base.map((row, i) =>
                      i === index
                        ? {
                            ...row,
                            url: bili.url,
                            episodeKey: row.episodeKey || episodeKey || undefined,
                            ...(biliSubs
                              ? {
                                  subtitleUrl: biliSubs.subtitleUrl,
                                  subtitleKind: 'file' as const,
                                  subtitleLanguage: biliSubs.language,
                                  subtitleNeedsTranslation: biliSubs.needsTranslation,
                                }
                              : {}),
                          }
                        : row,
                    )
                  })
                  setStatus('Playing')
                }
              } catch {
                /* fall through to Nyaa */
              }
              if (!biliOk) {
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
        }
        if (animeAudio && !dubPlayed) {
          // Japanese is playing — find out (cached, off the critical path) whether a dub exists.
          void findAnimeEnglishDub(showName).then((info) => {
            if (dubFits(info)) markDubPicker(info, 'sub')
          })
        }
      } catch (err) {
        failOnEpisode(err instanceof Error ? err.message : 'Could not load episode')
        return
      } finally {
        window.clearTimeout(loadingWatchdog)
        if (episodeFailGenRef.current === failGen) {
          setEpisodeLoading(false)
          setLoadingPlaylistIndex(null)
        }
      }
    } else if (needsTorrent) {
      if (!isTorrentPlaybackAvailable()) {
        failOnEpisode('Playback needs the Jiyu desktop app or Android source engine.')
        return
      }
      setEpisodeLoading(true)
      setMediaReady(false)
      setStatus(
        useTorrentio && hasRealDebridToken()
          ? 'Checking ready sources…'
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
          failOnEpisode('No source link for this episode')
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
                ? `Opening ready source (${i + 1}/${candidates.length})…`
                : 'Opening ready source…',
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
                preferJapaneseAudio:
                    shouldPreferRivestreamJapaneseAudio(item) &&
                    effectiveAnimeAudioMode(animeShowTitle) !== 'dub',
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
        // Torrent now: a Movy referrer from an earlier attempt must not stick.
        activePlaybackReferrerRef.current = ''

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
        if (result?.ok && result.url) {
          markRemuxDualAudio(
            animeAudioGen,
            `${entry.title || ''} ${result.name || ''} ${result.fileName || ''}`,
            result.url,
          )
        }
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
    // Same-episode remint (stall / Retry rotateSource) must keep
    // autoSeekResumeOnceRef so MANIFEST_PARSED can restore the playhead.
    watchClockRef.current = { lastTs: 0, accrued: 0 }
    timelineOffsetRef.current = 0
    setTimelineOffset(0)
    resumeKeyRef.current = null
    resumePendingRef.current = false
    if (index !== playlistIndex || options?.fromRestart) {
      autoSeekResumeOnceRef.current = 0
      stallHoldPlayheadRef.current = 0
      audioSwitchResumeRef.current = 0
    }
    if (options?.fromRestart) {
      // Give the new load its own guard window, and remount even when the
      // resolver handed back the same URL (otherwise nothing reloads).
      if (restartGuardRef.current) restartGuardUntilRef.current = Date.now() + RESTART_GUARD_MS
      setRetryTick((n) => n + 1)
    }
    setResumeOffer(null)
    skipDismissedRef.current = null
    setSkipTarget(null)
    setPlaylistIndex(index)
    setLoadingPlaylistIndex(null)
    setPlaylistOpenState(false)
    bumpChrome()
  }
  selectPlaylistItemRef.current = selectPlaylistItem

  /**
   * First episode opened by the show page (or a resume): tell the Sub / Dub button what is
   * playing. Episodes the Player opens itself are marked in selectPlaylistItem.
   */
  function primeAnimeAudioPicker(list: StreamPlaylistItem[] | null, startIndex: number) {
    animeAudioChoiceRef.current = null
    if (!shouldPreferRivestreamJapaneseAudio(item)) return
    const gen = ++animeAudioGenRef.current
    const row = list?.[startIndex]
    const url = row?.url || (list ? '' : item.url) || ''
    if (!url) return
    if (isRemuxPlaybackUrl(url)) {
      markRemuxDualAudio(gen, String(row?.fileName || item.title || ''), url)
      return
    }
    const tags = item.tags ?? []
    const playingDub =
      tags.some((t) => /^anime-dub$/i.test(String(t))) ||
      (isAnimeDubRowItem(item) && !tags.some((t) => /^anime-sub$/i.test(String(t))))
    if (playingDub) {
      setAnimeAudioMode('dub')
      setSubsEnabled(false)
    }
    const key = /^S(\d{1,2})E(\d{1,4})$/i.exec(row?.episodeKey || parseEpisodeKey(item.title) || '')
    const season = key ? Number(key[1]) : 1
    const episode = key ? Number(key[2]) : startIndex + 1
    const localMax = (list ?? [])
      .map((r) => /^S(\d{1,2})E(\d{1,4})$/i.exec(r.episodeKey || ''))
      .reduce((max, m) => (m && Number(m[1]) === season ? Math.max(max, Number(m[2])) : max), 0)
    const showTitle = animeShowTitle
    void findAnimeEnglishDub(showTitle).then((info) => {
      if (animeAudioGenRef.current !== gen || animeAudioChoiceRef.current) return
      const m2Max = info?.seasons.find((x) => x.season === season)?.maxEpisode || 0
      const fits =
        Boolean(info) &&
        animeDubHasEpisode(info!, season, episode) &&
        (isM2BoxCatalogItem(item) || !localMax || !m2Max || m2Max <= localMax + 2)
      if (!info || !fits) {
        if (!playingDub && effectiveAnimeAudioMode(showTitle) === 'dub') {
          flash('No English dub for this show — Japanese with subtitles')
        }
        return
      }
      // Dub row with no separate original listed: nothing to switch to.
      if (playingDub && !info.original && isAnimeDubRowItem(item)) return
      const choice: AnimeAudioChoice = { kind: 'm2box', info, index: startIndex, season, episode }
      animeAudioChoiceRef.current = choice
      setAnimeAudioChoice(choice)
      setAnimeAudioMode(playingDub ? 'dub' : 'sub')
    })
  }

  /** Dual-audio anime torrent (Japanese + English): the remuxer can switch tracks. */
  function markRemuxDualAudio(gen: number, releaseName: string, url: string) {
    if (!shouldPreferRivestreamJapaneseAudio(item)) return
    if (animeAudioGenRef.current !== gen) return
    if (!isRemuxPlaybackUrl(url) || !isDualAudioReleaseName(releaseName)) return
    const choice: AnimeAudioChoice = { kind: 'remux' }
    animeAudioChoiceRef.current = choice
    setAnimeAudioChoice(choice)
    const dub = remuxUrlIsDub(url)
    setAnimeAudioMode(dub ? 'dub' : 'sub')
    if (dub) setSubsEnabled(false)
  }

  /** Sub / Dub button: switch this episode's audio, keep the position, remember per show. */
  async function switchAnimeAudio(next: AnimeAudioMode) {
    const choice = animeAudioChoice
    if (!choice || next === animeAudioMode || animeAudioBusyRef.current) return
    const video = videoRef.current
    const at = video ? Math.max(0, Math.floor(absolutePlayhead(video))) : 0
    const prevMode = animeAudioMode
    const label = next === 'dub' ? 'English dub' : 'Japanese audio · subtitles on'
    setShowAnimeAudioMode(animeShowTitle, next)
    setAnimeAudioMode(next)
    setSubsEnabled(next === 'sub')
    bumpChrome()
    if (choice.kind === 'hls') {
      const hls = hlsInstanceRef.current
      if (hls) hls.audioTrack = next === 'dub' ? choice.en : choice.ja
      flash(label)
      return
    }
    const reopenAt = (url: string) => {
      if (at >= 5 && isVodCategory(item.category)) {
        upsertContinueEntry(
          {
            id: item.id,
            title: item.title,
            poster: item.poster,
            category: item.category,
            playlistIndex,
            episodeTitle: hasPlaylist ? activePlaylistItem.title : undefined,
            currentTime: at,
            duration: 0,
            runtimeSeconds: item.runtimeSeconds,
            torrentUri: item.torrentUri,
            detailUrl: item.detailUrl,
            playUrl: item.detailUrl || item.torrentUri,
            source: item.source,
          },
          { allowUnknownDuration: true, playbackUrl: url },
        )
        if (/\.m3u8(?:[?#]|$)/i.test(url)) {
          resumePendingRef.current = true
          autoSeekResumeOnceRef.current = at
        } else {
          audioSwitchResumeRef.current = at
        }
      }
      setLocalPlaylist((prev) => {
        const base = prev ?? item.playlist ?? []
        return base.map((row, i) => (i === playlistIndex ? { ...row, url } : row))
      })
    }
    if (choice.kind === 'remux') {
      reopenAt(remuxUrlWithAudio(stripResumeOffset(activePlaylistItem.url), next))
      flash(label)
      return
    }
    const target = next === 'dub' ? choice.info.dub : choice.info.original
    if (!target) {
      // No separate original-audio stream listed — reopen this episode the normal way.
      if (at >= 5) {
        audioSwitchResumeRef.current = at
        autoSeekResumeOnceRef.current = at
      }
      flash(label)
      void selectPlaylistItemRef.current(playlistIndex, { rotateSource: true })
      return
    }
    animeAudioBusyRef.current = true
    setStatus(next === 'dub' ? 'Opening English dub…' : 'Opening Japanese audio…')
    try {
      const resolved = await withTimeout(
        resolveM2BoxPlay(animeDubDetailUrl(target), {
          subjectId: target.subjectId,
          season: choice.season,
          episode: choice.episode,
        }),
        20_000,
        'Audio switch timed out.',
      )
      if (!resolved.ok || !resolved.url) throw new Error('unavailable')
      if (animeAudioChoiceRef.current !== choice) return
      hlsFallbackMetaRef.current = null
      activePlaybackReferrerRef.current = resolved.referer || ''
      if (window.signalDesktop?.setPlaybackHeaders) {
        void window.signalDesktop.setPlaybackHeaders({
          url: resolved.url,
          referrer: resolved.referer,
        })
      }
      reopenAt(resolved.url)
      flash(label)
    } catch {
      if (animeAudioChoiceRef.current === choice) {
        setShowAnimeAudioMode(animeShowTitle, prevMode)
        setAnimeAudioMode(prevMode)
        setSubsEnabled(prevMode === 'sub')
      }
      flash(next === 'dub' ? 'English dub unavailable right now' : 'Japanese audio unavailable right now')
      setStatus('Playing')
    } finally {
      animeAudioBusyRef.current = false
    }
  }

  /**
   * Audio menu (Movy cities that ship one stream per language): reopen the picked
   * language's stream from the same city at the current position.
   */
  /**
   * Same-title source swap (Audio menu / movie Retry): reopen the new URL at `at`.
   * hls.js restores via autoSeekResumeOnceRef; direct files via audioSwitchResumeRef.
   */
  function reopenMovyAt(url: string, at: number, index: number) {
    if (isVodCategory(item.category)) {
      upsertContinueEntry(
        {
          id: item.id,
          title: item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex: index,
          episodeTitle: hasPlaylist ? playlist[index]?.title : undefined,
          currentTime: at,
          duration: 0,
          runtimeSeconds: item.runtimeSeconds,
          torrentUri: item.torrentUri,
          detailUrl: item.detailUrl,
          playUrl: item.detailUrl || item.torrentUri,
          source: item.source,
        },
        { allowUnknownDuration: true, playbackUrl: url },
      )
    }
    resumePendingRef.current = true
    autoSeekResumeOnceRef.current = at
    audioSwitchResumeRef.current = at
  }

  async function switchMovyAudio(option: MovyAudioOption) {
    const fromUrl = activePlaylistItem.url
    const session = getMovyPlaySession(fromUrl)
    if (!session || option.key === session.language || movyAudioBusyRef.current) return
    const video = videoRef.current
    const at = video ? Math.max(0, Math.floor(absolutePlayhead(video))) : 0
    const index = playlistIndex
    movyAudioBusyRef.current = true
    setMovyAudioBusy(true)
    setStatus(`Opening ${option.label} audio…`)
    bumpChrome()
    try {
      let url = ''
      if (await probeMovyHlsUrl(option.url, MOVY_PLAY_REFERER)) {
        url = option.url
        rememberMovyPlaySession(url, { ...session, language: option.key })
      } else {
        // Signed link went stale — ask the same city again for that language.
        const fresh = await withTimeout(
          resolveMovyPlay({
            ...session.request,
            audioLanguage: option.key,
            providers: [session.provider],
            preferProvider: session.provider,
            preferBackend: undefined,
            avoidProvider: undefined,
          }),
          20_000,
          'Audio switch timed out.',
        )
        if (fresh.ok && fresh.language === option.key) url = fresh.url
      }
      if (!url) throw new Error('unavailable')
      if (activeUrlRef.current !== fromUrl) return
      activePlaybackReferrerRef.current = MOVY_PLAY_REFERER
      if (window.signalDesktop?.setPlaybackHeaders) {
        void window.signalDesktop.setPlaybackHeaders({ url, referrer: MOVY_PLAY_REFERER })
      }
      if (at >= 5) reopenMovyAt(url, at, index)
      setLocalPlaylist((prev) => {
        const base = prev && prev.length > 0 ? prev : playlist
        return base.map((row, i) => (i === index ? { ...row, url } : row))
      })
      flash(`Audio: ${option.label}`)
    } catch {
      flash(`${option.label} audio unavailable right now`)
      setStatus('Playing')
    } finally {
      movyAudioBusyRef.current = false
      setMovyAudioBusy(false)
    }
  }

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

  function bumpChrome(opts?: { delayMs?: number } | React.SyntheticEvent) {
    setChromeVisible(true)
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current)
    // Keep chrome up while loading / episode list / PiP — Android was hiding
    // controls while still on "Loading HLS…" so Play was unreachable.
    const loadingChrome = !mediaReady || episodeLoading || Boolean(error) || CHROME_HOLD_RE.test(status)
    if (playlistOpenRef.current || isPip || loadingChrome) return
    const delayMs =
      opts && typeof opts === 'object' && 'delayMs' in opts && typeof opts.delayMs === 'number'
        ? opts.delayMs
        : CHROME_IDLE_MS
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), delayMs)
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
          !mediaReady || episodeLoading || Boolean(error) || CHROME_HOLD_RE.test(status)
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

  async function openMirrorSettings() {
    flash('Open screen cast to mirror the phone')
    try {
      await androidOpenScreenCastSettings()
    } catch {
      flash('Could not open Cast settings')
    }
  }

  async function handleCast() {
    const playUrl = activePlaylistItem.url || item.url || videoRef.current?.currentSrc || ''
    const mode = castModeForPlayback(item, playUrl)
    // Prefer Chromecast when the SDK is up and we have a real media URL; otherwise mirror.
    if (!(mode === 'media' && castAvailable)) {
      await openMirrorSettings()
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
      await openMirrorSettings()
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
      await openMirrorSettings()
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

  /**
   * HLS / progressive seek that survives double-taps on Back/Forward.
   * Stacks deltas off the pending target and nudges hls.js to load around it.
   */
  function applyNativeMediaSeek(absoluteSeconds: number, notice?: string) {
    const video = videoRef.current
    if (!video) return
    if (!Number.isFinite(video.duration) || video.duration === Infinity) {
      flash('Live — seek unavailable')
      return
    }
    const target = Math.min(video.duration, Math.max(0, absoluteSeconds))
    pendingNativeSeekRef.current = target
    const gen = ++pendingNativeSeekGenRef.current
    // Give fragments time to land before stall remounts tear the session down.
    seekGuardUntilRef.current = Date.now() + 18_000
    if (pendingNativeSeekClearTimerRef.current) {
      window.clearTimeout(pendingNativeSeekClearTimerRef.current)
      pendingNativeSeekClearTimerRef.current = 0
    }
    if (pendingNativeSeekHandlerRef.current) {
      video.removeEventListener('seeked', pendingNativeSeekHandlerRef.current)
      pendingNativeSeekHandlerRef.current = null
    }

    const clearPending = () => {
      if (gen !== pendingNativeSeekGenRef.current) return
      if (pendingNativeSeekRef.current == null) return
      const aim = pendingNativeSeekRef.current
      const at = Number.isFinite(video.currentTime) ? video.currentTime : 0
      // Another Back/Forward may have moved the aim — wait until we land near it.
      if (Math.abs(at - aim) > 2.5) return
      pendingNativeSeekRef.current = null
      if (pendingNativeSeekHandlerRef.current === clearPending) {
        video.removeEventListener('seeked', clearPending)
        pendingNativeSeekHandlerRef.current = null
      }
      if (pendingNativeSeekClearTimerRef.current) {
        window.clearTimeout(pendingNativeSeekClearTimerRef.current)
        pendingNativeSeekClearTimerRef.current = 0
      }
      watchClockRef.current = { lastTs: 0, accrued: absolutePlayhead(video) }
      setError(null)
      setStatus('Playing')
      void video.play().catch(() => undefined)
    }

    pendingNativeSeekHandlerRef.current = clearPending
    video.addEventListener('seeked', clearPending)
    pendingNativeSeekClearTimerRef.current = window.setTimeout(() => {
      if (gen !== pendingNativeSeekGenRef.current) return
      pendingNativeSeekRef.current = null
      pendingNativeSeekClearTimerRef.current = 0
      if (pendingNativeSeekHandlerRef.current === clearPending) {
        video.removeEventListener('seeked', clearPending)
        pendingNativeSeekHandlerRef.current = null
      }
      // Soft heal instead of leaving a wedged MSE buffer after a long seek.
      try {
        const hls = hlsInstanceRef.current
        if (hls) {
          hls.startLoad(Number.isFinite(video.currentTime) ? video.currentTime : target)
        }
      } catch {
        /* ignore */
      }
      void video.play().catch(() => undefined)
      setStatus('Buffering…')
    }, 12_000)

    setError(null)
    setStatus('Seeking…')
    const hls = hlsInstanceRef.current
    try {
      // hls.js: stop before jumping so we don't keep fetching the old segment
      // window — that race was wedging anime VOD after scrub and timing out.
      if (hls) {
        try {
          hls.stopLoad()
        } catch {
          /* ignore */
        }
      }
      video.currentTime = target
      if (hls) {
        try {
          hls.startLoad(target)
        } catch {
          /* ignore */
        }
      }
    } catch {
      pendingNativeSeekRef.current = null
      video.removeEventListener('seeked', clearPending)
      flash('Seek unavailable')
      return
    }
    watchClockRef.current = { lastTs: 0, accrued: target + timelineOffsetRef.current }
    setPlaybackClock((prev) => ({
      ...prev,
      current: target + timelineOffsetRef.current,
    }))
    if (notice) flash(notice)
    bumpChrome()
  }

  function seekBy(seconds: number) {
    const video = videoRef.current
    if (!video) return
    const url = activePlaylistItem.url
    const notice = seconds < 0 ? `Back ${Math.abs(seconds)}s` : `Forward ${seconds}s`
    seekGuardUntilRef.current = Date.now() + 18_000

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

    // Stack rapid Back/Forward taps from the pending aim, not stale currentTime.
    const base =
      pendingNativeSeekRef.current != null
        ? pendingNativeSeekRef.current
        : Number.isFinite(video.currentTime)
          ? video.currentTime
          : 0
    applyNativeMediaSeek(base + seconds, notice)
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
    // User scrub — keep stall remount from destroying the session mid-jump.
    seekGuardUntilRef.current = Date.now() + 18_000

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
        setError(null)
        bumpChrome()
        return
      }
      setError(null)
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

    const relative = Math.max(0, target - timelineOffsetRef.current)
    applyNativeMediaSeek(relative)
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

  async function toggleFullscreen() {
    const stage = shellRef.current
    if (!stage) return
    // Web embed owns OS fullscreen — don't steal/clear it from the native player.
    // A 'web' claim with no web surface on screen is stale (embed closed while it
    // held Full): take it back instead of blocking Full forever.
    if (getFullscreenOwner() === 'web') {
      if (webSurfaceFullscreenMounted()) {
        flash('Web player is fullscreen')
        return
      }
      claimFullscreenOwner('native')
    }
    // Desktop: trust the real window state over our mirror. A missed
    // leave-full-screen left osFullScreenRef true, so Full only "exited".
    if (usesOsFullscreenOnly() && window.signalDesktop?.isFullScreen && !document.fullscreenElement) {
      try {
        const actual = Boolean(await window.signalDesktop.isFullScreen())
        if (actual !== osFullScreenRef.current) {
          osFullScreenRef.current = actual
          setOsFullScreen(actual)
        }
      } catch {
        /* keep the mirror */
      }
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
    // Desktop Electron + Android: OS/immersive fullscreen + CSS `.is-os-fullscreen`.
    // HTML Fullscreen API enter/leave was racing exitOsFullscreen (Full looked broken).
    if (!usesOsFullscreenOnly()) {
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
    // Orientation often fires before layout settles — clear stale picture size and re-fit.
    // Android immersive + rotate can leave the WebView stuck at the old short edge;
    // re-assert immersive and poke the visual viewport so the shell fills again.
    const orientTimers: number[] = []
    const onOrient = () => {
      setFittedVideo(null)
      fit()
      // Only re-assert when the user is actually in Full. On Android
      // usesOsFullscreenOnly() is always true, so the old check forced immersive on
      // every orientationchange - including the one fired by expanding system PiP,
      // which snapped the window straight back into PiP.
      if (!isPip && !isTile && osFullScreenRef.current && !androidSystemPipSettling()) {
        void enterOsFullscreen('native')
      }
      try {
        const root = document.documentElement
        root.style.height = '100dvh'
        root.style.minHeight = '100dvh'
        if (document.body) {
          document.body.style.height = '100dvh'
          document.body.style.minHeight = '100dvh'
        }
      } catch {
        /* ignore */
      }
      for (const ms of [80, 280, 600, 1000, 1600]) {
        orientTimers.push(
          window.setTimeout(() => {
            fit()
            window.dispatchEvent(new Event('resize'))
          }, ms),
        )
      }
    }
    window.addEventListener('orientationchange', onOrient)
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => {
      cancelAnimationFrame(frame)
      video.removeEventListener('loadedmetadata', fit)
      video.removeEventListener('resize', fit)
      observer.disconnect()
      window.removeEventListener('orientationchange', onOrient)
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
      for (const id of orientTimers) window.clearTimeout(id)
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

  // PiP / system-PiP: audio often keeps advancing while the opaque loader or a
  // black frame makes the window look "stuck". Clear ready state and nudge paint.
  useEffect(() => {
    const inPipSurface = () =>
      isPip || document.documentElement.classList.contains('is-system-pip')

    const clearIfAudible = () => {
      const video = videoRef.current
      if (!video || video.error) return
      const progressing =
        !video.paused &&
        !video.ended &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        (video.currentTime > 0.2 || (video.played?.length ?? 0) > 0)
      if (progressing) setMediaReady(true)
    }

    const nudgePipSurface = () => {
      clearIfAudible()
      if (!inPipSurface()) return
      const video = videoRef.current
      if (video && video.paused === false) {
        void video.play().catch(() => undefined)
      }
      window.requestAnimationFrame(() => {
        clearIfAudible()
        window.dispatchEvent(new Event('resize'))
      })
    }

    nudgePipSurface()
    window.addEventListener('resize', clearIfAudible)
    // SystemPipBridge toggles html.is-system-pip after Home → PiP.
    const mo = new MutationObserver(() => nudgePipSurface())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const timer = window.setInterval(() => {
      if (inPipSurface()) clearIfAudible()
    }, 800)
    return () => {
      window.removeEventListener('resize', clearIfAudible)
      mo.disconnect()
      window.clearInterval(timer)
    }
  }, [isPip, videoMountKey])

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
            // Electron/Android: OS FS only — don't re-enter HTML FS (exit races Full).
            if (usesOsFullscreenOnly()) return undefined
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
      // Desktop Electron Full is BrowserWindow FS; HTML FS ending must not clear it.
      if (
        !document.fullscreenElement &&
        osFullScreenRef.current &&
        !bouncingFromVideo &&
        getFullscreenOwner() !== 'web' &&
        !webSurfaceOwnsFullscreen()
      ) {
        if (usesOsFullscreenOnly()) {
          void window.signalDesktop?.isFullScreen?.().then((osFs) => {
            if (osFs) return
            osFullScreenRef.current = false
            setOsFullScreen(false)
          })
          return
        }
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
    /**
     * recoverMediaError() tears down MediaSource — calling it from stall + freeze
     * + BUFFER_STALLED at once looked like mid-play restarts. One shot per window.
     * Preserve playhead: recover resets currentTime to 0 unless we restore after
     * MEDIA_ATTACHED + loadedmetadata.
     */
    let lastMediaRecoverAt = 0
    const MEDIA_RECOVER_COOLDOWN_MS = 12_000
    const restorePlayheadAfterAttach = (hlsInst: Hls, at: number) => {
      if (!(at > 0.5)) return
      const videoEl = videoRef.current
      if (!videoEl) return
      let done = false
      const apply = () => {
        if (done || cancelled) return
        done = true
        try {
          videoEl.currentTime = at
          hlsInst.startLoad(at)
        } catch {
          /* ignore */
        }
        void ensureVideoAutoplay(videoEl)
      }
      const onAttached = () => {
        hlsInst.off(Hls.Events.MEDIA_ATTACHED, onAttached)
        if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
          apply()
          return
        }
        const onMeta = () => {
          videoEl.removeEventListener('loadedmetadata', onMeta)
          apply()
        }
        videoEl.addEventListener('loadedmetadata', onMeta)
        window.setTimeout(() => {
          videoEl.removeEventListener('loadedmetadata', onMeta)
          apply()
        }, 2_000)
      }
      hlsInst.on(Hls.Events.MEDIA_ATTACHED, onAttached)
      // recoverMediaError sometimes reuses an already-attached media element.
      window.setTimeout(() => {
        if (!done && videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) apply()
      }, 80)
    }
    const tryRecoverMediaError = (hlsInst: Hls | null | undefined): boolean => {
      if (!hlsInst) return false
      const now = Date.now()
      if (now - lastMediaRecoverAt < MEDIA_RECOVER_COOLDOWN_MS) return false
      lastMediaRecoverAt = now
      const videoEl = videoRef.current
      const held = stallHoldPlayheadRef.current
      const savedTime = Math.max(
        held > 0.5 ? held : 0,
        videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0,
      )
      // Pin the seek bar BEFORE MediaSource teardown reports t=0.
      if (savedTime > 0.5) pinStallPlayhead(savedTime)
      try {
        hlsInst.recoverMediaError()
        if (savedTime > 0.5) restorePlayheadAfterAttach(hlsInst, savedTime)
        return true
      } catch {
        return false
      }
    }
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
        // Sustained play only — brief playing blips used to reset the remount
        // budget and loop "Stream stalled — reloading…".
        if (hlsStallRemountRef.current.count > 0) {
          if (!hlsStallRemountRef.current.playStableSince) {
            hlsStallRemountRef.current.playStableSince = Date.now()
          } else if (Date.now() - hlsStallRemountRef.current.playStableSince >= 20_000) {
            hlsStallRemountRef.current.count = 0
            hlsStallRemountRef.current.playStableSince = 0
          }
        }
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
      hlsStallRemountRef.current.playStableSince = 0
      setStatus('Buffering…')
      // Don't bump chrome — Android HLS fires `waiting` often, and that was
      // cancelling the hide timer for the whole episode.
      // Immediate HLS nudge — never abort an in-flight fragment on Movy/Auto.
      try {
        const hlsInst = hlsInstanceRef.current
        if (hlsInst) {
          const t = video.currentTime
          const onMovy =
            isMovyStreamUrl(activePlaylistItem.url) ||
            activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
            /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
          softHealHlsStall(hlsInst, Number.isFinite(t) ? t : NaN, {
            allowAbrDownshift: onMovy && getViewingQuality() === 'auto',
            onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
          })
        }
      } catch {
        /* ignore */
      }
      // Remux can spin forever when peers stall — surface a recoverable error.
      // Movy HLS can also stall forever — switch to Atlantic/Cinecat after a soft wait.
      // Plain Rivestream/anime HLS needs the same soft/hard stall watch (not only torrent/Movy).
      const playUrl = activePlaylistItem.url
      const isLocal = isEphemeralLocalStreamUrl(playUrl)
      const isHlsVod = Boolean(hlsInstanceRef.current) && !isLivePlaybackItem(item)
      const meta = hlsFallbackMetaRef.current
      const canAtlantic =
        Boolean(meta) &&
        !meta!.tried &&
        !meta!.busy &&
        (isMovyStreamUrl(playUrl) || meta!.tmdbId.length > 0)
      if (!isLocal && !canAtlantic && !isHlsVod) return
      const now = Date.now()
      if (!waitingSince) waitingSince = now
      if (!waitingOrigin) waitingOrigin = now
      if (stallTimer != null) return
      // Soft limit: no meaningful buffer growth. Hard cap: never sit here forever
      // because tiny fragment arrivals kept resetting the soft timer.
      const perf = getPerformanceKnobs()
      const onMovyHls =
        isMovyStreamUrl(playUrl) ||
        activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
        /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
      // Movy anime CDNs often need a longer first-buffer than sports HLS —
      // swapping to Atlantic at 12s felt worse than waiting like the website.
      const stallLimitMs = canAtlantic
        ? onMovyHls
          ? 28_000
          : 12_000
        : isHlsVod
          ? onMovyHls
            ? 24_000
            : 14_000
          : isRemuxPlaybackUrl(activePlaylistItem.url)
            ? perf.remuxStallMs
            : perf.localStallMs
      const hardCapMs = canAtlantic
        ? onMovyHls
          ? 45_000
          : 20_000
        : isHlsVod
          ? onMovyHls
            ? 48_000
            : 28_000
          : Math.max(stallLimitMs * 2, 120_000)
      let lastBufferedEnd = 0
      let bufferedAtOrigin = -1
      let lastMovingPlayhead = -1
      let hlsHealTicks = 0
      stallTimer = window.setInterval(() => {
        if (cancelled || !waitingSince || !waitingOrigin) return
        // User scrub / ±10s — heal with startLoad, don't remount (that was
        // producing "HLS load timed out" after dragging the seekbar).
        if (Date.now() < seekGuardUntilRef.current) {
          const el = videoRef.current
          if (el && hlsInstanceRef.current) {
            const t = el.currentTime
            softHealHlsStall(hlsInstanceRef.current, Number.isFinite(t) ? t : NaN, {
              allowAbrDownshift: false,
            })
            void ensureVideoAutoplay(el)
          }
          return
        }
        // Fragment still downloading — don't treat slow CDN as a stall, and
        // never reset the loader (that aborts the segment and freezes ABR).
        if (hlsHasInFlightMainFrag(hlsInstanceRef.current)) {
          waitingSince = Date.now()
          setStatus('Buffering…')
          return
        }
        const videoEl = videoRef.current
        if (!videoEl) return
        const t = videoEl.currentTime
        const playheadMoving =
          lastMovingPlayhead >= 0 && t > lastMovingPlayhead + 0.2
        if (playheadMoving) lastMovingPlayhead = t
        else if (lastMovingPlayhead < 0) lastMovingPlayhead = t
        // Only clear when the playhead is actually advancing — HAVE_FUTURE_DATA
        // alone was true during frozen Movy stalls (tiny buffer, no progress).
        // Playhead moving means this is not a stall — HAVE_FUTURE_DATA was often
        // false during normal HLS playback and the watch then reloaded from 0.
        if (!videoEl.paused && playheadMoving) {
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
        // Swarm/remux/HLS still downloading — reset soft stall so we don't remount-loop
        // a slow but healthy VOD (One Piece anime was restarting every ~14s).
        // Movy→Atlantic path still ignores buffer blips (want a real source swap).
        if (bufferedEnd > lastBufferedEnd + 0.35) {
          lastBufferedEnd = bufferedEnd
          if (!canAtlantic) {
            waitingSince = Date.now()
            setError(null)
            setStatus('Buffering…')
          }
        }
        // Soft heal: never abort an in-flight fragment. Movy Auto → ABR downshift
        // instead of startLoad thrash that freezes on 1080p.
        if (isHlsVod && hlsInstanceRef.current) {
          hlsHealTicks += 1
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          if (hlsHealTicks % 2 === 0) {
            const onMovy =
              isMovyStreamUrl(activePlaylistItem.url) ||
              activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
              /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
            softHealHlsStall(hlsInstanceRef.current, t, {
              allowAbrDownshift: onMovy && getViewingQuality() === 'auto',
              onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
            })
          }
          void ensureVideoAutoplay(videoEl)
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
        // Buffer still filling — don't remount/reload a working (slow) session.
        if (hardStalled && !almostNoLead && !softStalled && !canAtlantic) return
        // Prefer Atlantic HLS before rotating torrent magnets.
        if (canAtlantic) {
          clearStallWatch()
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
                  ? 'Still starting the stream — sources may be slow. Tap Resume if offered, or Retry / another quality.'
                  : 'Still buffering after 45s — sources may be slow. Tap Retry, or try another episode/quality.',
              )
              setStatus('Buffering…')
              return
            }
            setError('Stream stalled — alternate source unavailable. Tap Retry.')
            setStatus('Buffering…')
          })
          return
        }
        if (isHlsVod) {
          // Soft stall: never remount <video> — that blacks the frame and snaps
          // the seek bar to 0. Keep the element; only startLoad around the playhead.
          // Remount is for explicit Retry; remint only after a dead Movy URL.
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          setError(null)
          setStatus('Buffering…')
          if (hlsInstanceRef.current) {
            softHealHlsStall(hlsInstanceRef.current, t, {
              allowAbrDownshift: onMovyHls && getViewingQuality() === 'auto',
              onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
            })
          }
          void ensureVideoAutoplay(videoEl)
          // Movy playlist tokens can expire — after a long wedged stall, mint a
          // fresh source (source switch, not a same-URL remount).
          if (onMovyHls && hardStalled) {
            clearStallWatch()
            setStatus('Stream stalled — fetching a fresh source…')
            if (hlsFallbackMetaRef.current) {
              hlsFallbackMetaRef.current.busy = false
              hlsFallbackMetaRef.current.tried = false
            }
            void selectPlaylistItemRef.current(playlistIndex, {
              force: true,
              rotateSource: true,
            })
            return
          }
          if (hardStalled) {
            clearStallWatch()
            setError('Stream stalled — tap Retry, or pick another episode/quality.')
            return
          }
          // Soft heal kept the element alive — reset soft clock, keep the watch.
          waitingSince = Date.now()
          return
        }
        clearStallWatch()
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
            ? 'Still starting the stream — sources may be slow. Tap Resume if offered, or Retry / another quality.'
            : 'Still buffering after 45s — sources may be slow. Tap Retry, or try another episode/quality.',
        )
        setStatus('Buffering…')
      }, 1000)
    }

    // Playhead freeze watchdog — Movy/anime HLS often stalls without reliable
    // `waiting` events (frozen frame, readyState still HAVE_*).
    let freezeLastTime = -1
    let freezeSince = 0
    let freezeTimer: number | null = null
    let freezeNudges = 0
    const clearFreezeWatch = () => {
      freezeLastTime = -1
      freezeSince = 0
      freezeNudges = 0
      if (freezeTimer != null) {
        window.clearInterval(freezeTimer)
        freezeTimer = null
      }
    }
    const armFreezeWatch = () => {
      if (freezeTimer != null) return
      freezeTimer = window.setInterval(() => {
        if (cancelled) return
        // waiting-event stall watch owns healing — dual recoverMediaError remounts
        // looked like mid-play restarts while the clock kept ticking.
        if (stallTimer != null) {
          freezeLastTime = -1
          freezeSince = 0
          freezeNudges = 0
          return
        }
        if (Date.now() < seekGuardUntilRef.current) {
          const el = videoRef.current
          if (el && hlsInstanceRef.current && !el.paused) {
            const t = el.currentTime
            softHealHlsStall(hlsInstanceRef.current, Number.isFinite(t) ? t : NaN, {
              allowAbrDownshift: false,
            })
          }
          return
        }
        // Slow segment in flight — reset freeze clock so we don't "heal" mid-download.
        if (hlsHasInFlightMainFrag(hlsInstanceRef.current)) {
          freezeLastTime = -1
          freezeSince = 0
          return
        }
        const meta = hlsFallbackMetaRef.current
        const playUrl = activePlaylistItem.url
        const canAtlantic =
          Boolean(meta) &&
          !meta!.tried &&
          !meta!.busy &&
          (isMovyStreamUrl(playUrl) || meta!.tmdbId.length > 0)
        const isHlsVod = Boolean(hlsInstanceRef.current) && !isLivePlaybackItem(item)
        if (!canAtlantic && !isHlsVod) return
        const el = videoRef.current
        if (!el || el.paused || el.ended) {
          freezeLastTime = -1
          freezeSince = 0
          freezeNudges = 0
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
          freezeNudges = 0
          return
        }
        const frozenFor = Date.now() - freezeSince
        // Soft heal: keep fetching around the freeze — don't rebuild MediaSource
        // and don't abort fragments already downloading.
        if (isHlsVod && hlsInstanceRef.current && frozenFor >= 4_000 && freezeNudges < 6) {
          freezeNudges += 1
          setStatus('Buffering…')
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          const frozenMovySoft =
            isMovyStreamUrl(playUrl) ||
            activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
            /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
          softHealHlsStall(hlsInstanceRef.current, t, {
            allowAbrDownshift: frozenMovySoft && getViewingQuality() === 'auto',
            onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
          })
          void ensureVideoAutoplay(el)
        }
        if (frozenFor < 12_000) return
        // Atlantic is an explicit source switch — OK to leave this element.
        if (canAtlantic) {
          clearFreezeWatch()
          clearStallWatch()
          setStatus('Stream stalled — switching source…')
          bumpChrome()
          void tryHlsFallbackRef.current(t).then((ok) => {
            if (cancelled || ok) return
            setError('Stream stalled — alternate source unavailable. Tap Retry.')
            setStatus('Buffering…')
          })
          return
        }
        if (isHlsVod) {
          // Never remount on freeze. Keep the freeze clock (don't clearFreezeWatch)
          // so soft startLoad can keep healing until ~22s, then remint/error.
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          setError(null)
          setStatus('Buffering…')
          if (hlsInstanceRef.current) {
            const frozenMovySoft =
              isMovyStreamUrl(playUrl) ||
              activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
              /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
            softHealHlsStall(hlsInstanceRef.current, t, {
              allowAbrDownshift: frozenMovySoft && getViewingQuality() === 'auto',
              onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
            })
          }
          void ensureVideoAutoplay(el)
          if (frozenFor < 22_000) return
          clearFreezeWatch()
          clearStallWatch()
          const frozenMovy =
            isMovyStreamUrl(playUrl) ||
            activePlaybackReferrerRef.current === MOVY_PLAY_REFERER ||
            /movy\.sx/i.test(activePlaybackReferrerRef.current || '')
          if (frozenMovy) {
            setStatus('Stream stalled — fetching a fresh source…')
            if (hlsFallbackMetaRef.current) {
              hlsFallbackMetaRef.current.busy = false
              hlsFallbackMetaRef.current.tried = false
            }
            void selectPlaylistItemRef.current(playlistIndex, {
              force: true,
              rotateSource: true,
            })
            return
          }
          setError('Stream stalled — tap Retry, or pick another episode/quality.')
          setStatus('Buffering…')
        }
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
        flash('Waiting for more source data…')
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
          'Playback stopped mid-title — source buffer ran dry. Tap Retry, wait a moment, or Restart.',
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
        flash('Source gap — waiting, then continuing from here')
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

    const shouldAutoAdvanceAfterEnd = (
      playhead: number,
      playbackUrl: string,
      trusted: number,
      reported: number,
    ): boolean => {
      const remux =
        isRemuxPlaybackUrl(playbackUrl) || isLocalPlaybackUrl(playbackUrl)
      // Remux: require trusted near-end — false EOF mid-title is common.
      if (remux) {
        return isTrustedDuration(trusted) && playhead / trusted >= 0.9
      }
      // HLS / native VOD: catalog runtime is often missing; media `ended` plus a
      // sane reported duration (or a long enough playhead) is enough to advance.
      if (isTrustedDuration(trusted) && playhead / trusted >= 0.9) return true
      if (
        isTrustedDuration(reported) &&
        playhead / reported >= 0.9 &&
        !isLikelyPartialDuration(reported, playhead, { playbackUrl })
      ) {
        return true
      }
      // Natural media end without a catalog runtime (typical Movy/anime HLS).
      return video.ended && playhead >= 60
    }

    const advanceToNextEpisodeOrWatchNext = () => {
      if (cancelled || autoAdvanceLockRef.current) return
      if (playlistIndex < playlist.length - 1) {
        autoAdvanceLockRef.current = true
        setStatus('Next episode…')
        // Re-resolve — sibling rows often have empty / expired Movy URLs.
        void selectPlaylistItemRef.current(playlistIndex + 1)
        return
      }
      // Title / last episode finished — start the one-slot Up next queue.
      const queued = watchNextRef.current
      if (!queued || queued.id === item.id) return
      autoAdvanceLockRef.current = true
      const next = takeWatchNext()
      if (!next) return
      flash(`Up next: ${next.title}`)
      window.setTimeout(() => {
        navigate(next.href, { replace: true })
      }, 400)
    }

    const onEnded = () => {
      // Torrent remux pipes often fire `ended` when the buffered fragment looks
      // like the full title or ffmpeg hits a download gap.
      if (continueRemuxPastGap('ended')) return

      const playhead = effectivePlayhead(video)
      const playbackUrl = activePlaylistItem.url
      const trusted = remuxTrustedRuntime(playhead, playbackUrl)
      const reported = remuxReportedAbsolute()
      saveContinueProgress(true)

      if (cancelled) return
      if (!shouldAutoAdvanceAfterEnd(playhead, playbackUrl, trusted, reported)) return
      advanceToNextEpisodeOrWatchNext()
    }

    const onRemuxGuard = () => {
      if (cancelled || remuxContinueBusy) return
      const playbackUrl = activePlaylistItem.url
      // HLS/anime often never fire `ended` — advance when the playhead reaches
      // the real media end so the next episode still starts.
      if (!isRemuxPlaybackUrl(playbackUrl) && !isLocalPlaybackUrl(playbackUrl)) {
        updatePlaybackClock(video)
        if (autoAdvanceLockRef.current || episodeLoading) return
        if (playlistIndex >= playlist.length - 1 && !watchNextRef.current) return
        const playhead = effectivePlayhead(video)
        const reported = remuxReportedAbsolute()
        const trusted = remuxTrustedRuntime(playhead, playbackUrl)
        const atMediaEnd =
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          video.duration !== Infinity &&
          video.currentTime >= video.duration - 1.25
        const nearComplete =
          (isTrustedDuration(trusted) && playhead / trusted >= 0.97) ||
          (isTrustedDuration(reported) &&
            playhead / reported >= 0.97 &&
            !isLikelyPartialDuration(reported, playhead, { playbackUrl }))
        if ((atMediaEnd || (nearComplete && (video.ended || video.paused))) && playhead >= 60) {
          saveContinueProgress(true)
          advanceToNextEpisodeOrWatchNext()
        }
        return
      }
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

    let hlsNetTeardown: (() => void) | null = null
    const cleanupPlayers = () => {
      hlsNetTeardown?.()
      hlsNetTeardown = null
      if (hls) {
        hls.destroy()
        hls = null
      }
      if (hlsInstanceRef.current) hlsInstanceRef.current = null
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
        // Sub / Dub switch mid-episode: reopen at the same spot (no Resume prompt).
        const audioSwitchAt = audioSwitchResumeRef.current
        audioSwitchResumeRef.current = 0
        const saved = getContinueEntry(item.id)
        const resumeAt =
          audioSwitchAt < 5 &&
          saved &&
          !restartGuardRef.current &&
          saved.playlistIndex === playlistIndex &&
          saved.currentTime >= 5
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
            flash('Still buffering at resume point')
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
        if (audioSwitchAt >= 5 && isRemuxPlaybackUrl(activePlaylistItem.url)) {
          setTimelineOffsetSeconds(audioSwitchAt)
          watchClockRef.current = { lastTs: 0, accrued: audioSwitchAt }
          video.src = withResumeOffset(activePlaylistItem.url, audioSwitchAt, { exact: true })
        } else {
          setTimelineOffsetSeconds(0)
          if (resumeAt >= 5) setResumeOffer(resumeAt)
          if (audioSwitchAt >= 5) {
            video.addEventListener(
              'loadedmetadata',
              () => {
                try {
                  video.currentTime = audioSwitchAt
                } catch {
                  /* ignore */
                }
              },
              { once: true },
            )
          }
          video.src = activePlaylistItem.url
        }
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
        const liveMode = isLivePlaybackItem(item)
        const playbackReferrer =
          activePlaybackReferrerRef.current || item.httpReferrer || ''
        const movyPlayback =
          isMovyStreamUrl(activePlaylistItem.url) ||
          playbackReferrer === MOVY_PLAY_REFERER ||
          /movy\.sx/i.test(playbackReferrer)
        const playbackHeaders = {
          url: activePlaylistItem.url || item.url,
          userAgent: item.httpUserAgent,
          referrer: playbackReferrer || (movyPlayback ? MOVY_PLAY_REFERER : undefined),
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders(playbackHeaders)
        }
        hls = new Hls({
          enableWorker: perf.enableMediaWorkers,
          // Live may use LL-HLS knobs; VOD (anime) must keep a normal cushion —
          // lowLatencyMode on episode m3u8 was stalling mid-title as "Buffering…".
          lowLatencyMode: liveMode ? perf.liveHlsLowLatency : false,
          // Movy anime: bigger cushion — website ABR feels seamless; we were
          // remounting on short buffers while paleoak/majorplay caught up.
          maxBufferLength: liveMode
            ? Math.max(perf.liveHlsMaxBufferLength, perf.hlsMaxBufferLength, 36)
            : Math.max(perf.hlsMaxBufferLength, movyPlayback ? 60 : 36),
          maxMaxBufferLength: liveMode
            ? Math.max(perf.liveHlsMaxBufferLength + 24, 72)
            : Math.max(perf.hlsMaxBufferLength + 30, movyPlayback ? 120 : 72),
          // Stay several segments behind the edge so jitter doesn't empty the buffer.
          liveSyncDurationCount: liveMode ? perf.liveHlsSyncSegments : undefined,
          liveMaxLatencyDurationCount: liveMode
            ? Math.max(perf.liveHlsSyncSegments + 4, 10)
            : undefined,
          // Live sports: keep a back buffer so short stalls can recover without
          // seeking to the live edge (which re-empties the forward cushion).
          // VOD: keep recent segments so brief seeks/stalls can resume without reload.
          backBufferLength: liveMode ? 90 : movyPlayback ? 90 : 60,
          maxBufferHole: liveMode ? 1.5 : 1.0,
          fragLoadingTimeOut: liveMode ? 20_000 : movyPlayback ? 30_000 : 20_000,
          manifestLoadingTimeOut: liveMode ? 15_000 : movyPlayback ? 20_000 : 12_000,
          levelLoadingTimeOut: liveMode ? 15_000 : movyPlayback ? 20_000 : 12_000,
          fragLoadingMaxRetry: liveMode ? 8 : 12,
          manifestLoadingMaxRetry: liveMode ? 6 : 6,
          levelLoadingMaxRetry: liveMode ? 6 : 6,
          fragLoadingRetryDelay: liveMode ? 800 : 1000,
          // VOD: exponential backoff (1s,2s,4s.. capped 16s) rides out Wi-Fi dips
          // instead of exhausting retries in ~6s and going fatal.
          ...(liveMode
            ? {}
            : {
                fragLoadPolicy: {
                  default: {
                    maxTimeToFirstByteMs: 10_000,
                    maxLoadTimeMs: movyPlayback ? 30_000 : 20_000,
                    timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
                    errorRetry: {
                      maxNumRetry: 12,
                      retryDelayMs: 1000,
                      maxRetryDelayMs: 16_000,
                      backoff: 'exponential' as const,
                    },
                  },
                },
              }),
          // Movy masters are true ladders (360/720/1080). Start near 720p
          // bandwidth, downshift quickly, climb slowly — never lock max bitrate.
          ...(movyPlayback && !liveMode
            ? {
                abrEwmaDefaultEstimate: 2_200_000,
                startLevel: -1,
                abrEwmaFastVoD: 2,
                abrEwmaSlowVoD: 8,
                abrBandWidthFactor: 0.7,
                abrBandWidthUpFactor: 0.45,
                maxStarvationDelay: 4,
                maxLoadingDelay: 4,
                abrMaxWithRealBitrate: true,
              }
            : {}),
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
              try {
                xhr.setRequestHeader('Origin', new URL(referrer).origin)
              } catch {
                /* ignore */
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
              origin: playbackHeaders.referrer
                ? (() => {
                    try {
                      return new URL(playbackHeaders.referrer).origin
                    } catch {
                      return 'https://www.movy.sx'
                    }
                  })()
                : undefined,
            },
          ),
        })
        let recoveries = 0
        let bufferStallNudges = 0
        let settled = false
        let playRecoveries = 0
        // Movy can hang forever on "Loading HLS…" after a mid-episode stall —
        // fail fast so Atlantic / next engine can take over.
        const meta = hlsFallbackMetaRef.current
        const canAtlanticSoon =
          Boolean(meta) &&
          !meta!.tried &&
          (isMovyStreamUrl(activePlaylistItem.url) || meta!.tmdbId.length > 0)
        // Anime / long Movy manifests often need >8s before MANIFEST_PARSED —
        // the short budget aborted into Atlantic/remount loops mid-open.
        const hlsLoadBudgetMs = canAtlanticSoon ? 18_000 : liveMode ? 55_000 : 28_000
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
        const nudgeHlsAtPlayhead = () => {
          if (!hls) return
          const t = video.currentTime
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          softHealHlsStall(hls, Number.isFinite(t) ? t : NaN, {
            allowAbrDownshift: movyPlayback && getViewingQuality() === 'auto',
            onAbrCap: (height) => setEngineLabel(`hls · auto ≤${height}p`),
          })
          void ensureVideoAutoplay(video)
        }
        // Same recovery as skip-forward, but at the current playhead.
        const forceReloadAtPlayhead = () => {
          if (!hls || cancelled) return
          const t = video.currentTime
          if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
          softHealHlsStall(hls, Number.isFinite(t) ? t : NaN, { force: true })
          if (Number.isFinite(t) && Math.abs(video.currentTime - t) > 0.25) {
            try {
              video.currentTime = t
            } catch {
              /* ignore */
            }
          }
          void ensureVideoAutoplay(video)
        }
        const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false
        const netBackoffSteps = [1000, 2000, 4000, 8000, 15_000]
        let netBackoffTimer = 0
        let netBackoffStep = 0
        let netBackoffStarted = 0
        const clearNetBackoff = () => {
          window.clearTimeout(netBackoffTimer)
          netBackoffTimer = 0
          netBackoffStep = 0
          netBackoffStarted = 0
        }
        /** True while a backoff retry is scheduled/allowed (~90s budget). */
        const scheduleNetBackoff = (): boolean => {
          if (!netBackoffStarted) netBackoffStarted = Date.now()
          if (Date.now() - netBackoffStarted > 90_000) return false
          if (netBackoffTimer) return true
          const delay = netBackoffSteps[Math.min(netBackoffStep, netBackoffSteps.length - 1)]!
          netBackoffStep += 1
          netBackoffTimer = window.setTimeout(() => {
            netBackoffTimer = 0
            if (cancelled || !hls) return
            if (isOffline()) return
            forceReloadAtPlayhead()
          }, delay)
          return true
        }
        const onNetOffline = () => {
          if (cancelled || !settled) return
          setStatus('Reconnecting\u2026')
        }
        const onNetOnline = () => {
          if (cancelled || !hls || !settled) return
          window.clearTimeout(netBackoffTimer)
          netBackoffTimer = 0
          setStatus('Buffering\u2026')
          forceReloadAtPlayhead()
        }
        let frozenAt = -1
        let frozenSince = 0
        const frozenWatch = window.setInterval(() => {
          if (cancelled || !hls || !settled) return
          const t = video.currentTime
          if (video.paused || video.ended || !Number.isFinite(t)) {
            frozenAt = -1
            return
          }
          if (frozenAt < 0 || t > frozenAt + 0.2) {
            if (frozenAt >= 0 && t > frozenAt + 0.2) clearNetBackoff()
            frozenAt = t
            frozenSince = Date.now()
            return
          }
          if (isOffline() || Date.now() < seekGuardUntilRef.current) return
          if (Date.now() - frozenSince >= 6000) {
            frozenSince = Date.now()
            forceReloadAtPlayhead()
          }
        }, 1000)
        window.addEventListener('online', onNetOnline)
        window.addEventListener('offline', onNetOffline)
        hlsNetTeardown = () => {
          window.removeEventListener('online', onNetOnline)
          window.removeEventListener('offline', onNetOffline)
          window.clearInterval(frozenWatch)
          clearNetBackoff()
        }
        // Samsung: referer-locked CDNs (Movy / Atlantic …) via the relay; no-op elsewhere.
        hls.loadSource(tizenHlsUrl(activePlaylistItem.url, playbackHeaders.referrer))
        hls.attachMedia(video)
        hlsInstanceRef.current = hls
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled || settled) return
          settled = true
          window.clearTimeout(loadTimer)
          applyHlsQuality()
          // Prefer Japanese (anime) or English audio when the HLS master lists multiple tracks.
          // MULTI packs often default to French — don't leave that as the active group.
          let hlsDualAnnounced = false
          const pickPreferredAudioTrack = () => {
            try {
              const tracks = hls?.audioTracks || []
              if (tracks.length < 2) return
              const animeItem = shouldPreferRivestreamJapaneseAudio(item)
              if (animeItem) {
                // Japanese + English in one stream → Sub / Dub button, no reload to switch.
                const blobOf = (t: (typeof tracks)[number]) =>
                  `${t.name || ''} ${t.lang || ''}`.toLowerCase()
                const jaIdx = tracks.findIndex((t) =>
                  /japanese|\bjpn?\b|\bja\b|\bjp\b|nihongo/.test(blobOf(t)),
                )
                const enIdx = tracks.findIndex((t) =>
                  /english|\beng\b|\ben-?us\b|^en$|\ben-/.test(blobOf(t)),
                )
                if (jaIdx >= 0 && enIdx >= 0 && jaIdx !== enIdx) {
                  const dub =
                    effectiveAnimeAudioMode(cleanShowDisplayTitle(item.title) || item.title) ===
                    'dub'
                  const want = dub ? enIdx : jaIdx
                  if (hls && hls.audioTrack !== want) hls.audioTrack = want
                  if (!hlsDualAnnounced) {
                    hlsDualAnnounced = true
                    const choice: AnimeAudioChoice = { kind: 'hls', en: enIdx, ja: jaIdx }
                    animeAudioChoiceRef.current = choice
                    setAnimeAudioChoice(choice)
                    setAnimeAudioMode(dub ? 'dub' : 'sub')
                    if (dub) setSubsEnabled(false)
                  }
                  return
                }
              }
              const wantJa = animeItem
              const scored = tracks.map((t, index) => {
                const blob = `${t.name || ''} ${t.lang || ''} ${t.groupId || ''}`.toLowerCase()
                let score = 0
                if (wantJa) {
                  if (/japanese|\bjpn?\b|\bja\b|\bjp\b|nihongo/.test(blob)) score += 30
                  else if (/english|\beng\b|\ben-?us\b|^en$|\ben-/.test(blob)) score += 12
                  if (
                    /hindi|\bhin\b|arabic|spanish|french|fran[cç]ais|\bfr\b|german|portuguese|russian|turkish|tamil|telugu|urdu|korean|chinese/.test(
                      blob,
                    )
                  ) {
                    score -= 25
                  }
                } else {
                  if (/english|\beng\b|\ben-?us\b|^en$|\ben-/.test(blob)) score += 20
                  if (
                    /hindi|\bhin\b|arabic|spanish|french|fran[cç]ais|\bfr\b|german|portuguese|russian|turkish|tamil|telugu|urdu|korean|chinese|japanese|\bjp\b|\bja\b/.test(
                      blob,
                    )
                  ) {
                    score -= 25
                  }
                }
                return { index, score }
              })
              scored.sort((a, b) => b.score - a.score)
              const best = scored[0]
              const second = scored[1]
              // Switch when preferred language wins, or when the default track is clearly
              // foreign and an unlabeled/neutral track scores higher.
              if (
                best &&
                hls &&
                (best.score >= 10 ||
                  (second != null && best.score > second.score && best.score >= 0))
              ) {
                hls.audioTrack = best.index
              }
            } catch {
              /* ignore */
            }
          }
          pickPreferredAudioTrack()
          hls?.on(Hls.Events.AUDIO_TRACKS_UPDATED, pickPreferredAudioTrack)
          // Movy Auto: seed the first fragment near 720p so ABR can climb/drop
          // instead of opening on a choking 1080p estimate.
          if (movyPlayback && !liveMode && getViewingQuality() === 'auto' && hls) {
            try {
              const levels = hls.levels
              let best = -1
              let bestDist = Number.POSITIVE_INFINITY
              for (let i = 0; i < levels.length; i++) {
                const h = levels[i]?.height || 0
                if (h <= 0) continue
                const dist = Math.abs(h - 720)
                if (dist < bestDist) {
                  bestDist = dist
                  best = i
                }
              }
              if (best >= 0) {
                hls.startLevel = best
                hls.nextLevel = best
                hls.currentLevel = -1
              }
            } catch {
              /* ignore */
            }
          }
          setStatus('Ready')
          const saved = getContinueEntry(item.id)
          if (
            saved &&
            !restartGuardRef.current &&
            saved.playlistIndex === playlistIndex &&
            saved.currentTime >= 5
          ) {
            setResumeOffer(saved.currentTime)
            resumePendingRef.current = false
          }
          const autoAt = Math.max(
            autoSeekResumeOnceRef.current,
            stallHoldPlayheadRef.current > 0.5 ? stallHoldPlayheadRef.current : 0,
          )
          // Any stall past the first half-second should restore the playhead
          // (was >= 5, which dropped early mid-open recovers back to 0).
          if (autoAt > 0.5) {
            autoSeekResumeOnceRef.current = 0
            // hls.js took the reopen — drop the direct-file fallback seek.
            audioSwitchResumeRef.current = 0
            pinStallPlayhead(autoAt)
            let jumped = false
            const jump = () => {
              if (jumped || cancelled) return
              jumped = true
              try {
                video.currentTime = autoAt
                hls?.startLoad(autoAt)
              } catch {
                /* ignore */
              }
              resumePendingRef.current = false
              setResumeOffer(null)
              // Silent resume — flashing "Resumed at…" made soft stalls feel like restarts.
              setStatus('Buffering…')
              void ensureVideoAutoplay(video).then((ok) => {
                if (ok) {
                  stallHoldPlayheadRef.current = 0
                  setStatus('Playing')
                }
              })
            }
            // Wait for level/metadata — blind 350ms timeouts often seek before
            // duration exists and the browser drops the target back to 0.
            const onLevel = () => {
              hls?.off(Hls.Events.LEVEL_LOADED, onLevel)
              video.removeEventListener('loadedmetadata', onLevel)
              if (video.readyState >= HTMLMediaElement.HAVE_METADATA) jump()
              else {
                const onMeta = () => {
                  video.removeEventListener('loadedmetadata', onMeta)
                  jump()
                }
                video.addEventListener('loadedmetadata', onMeta)
                window.setTimeout(jump, 2_000)
              }
            }
            hls?.on(Hls.Events.LEVEL_LOADED, onLevel)
            video.addEventListener('loadedmetadata', onLevel)
            window.setTimeout(onLevel, 2_500)
          }
          const bufferedAheadSec = () => {
            try {
              const t = Number.isFinite(video.currentTime) ? video.currentTime : 0
              const b = video.buffered
              for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= t + 0.35 && b.end(i) > t) return b.end(i) - t
              }
            } catch {
              /* ignore */
            }
            return 0
          }
          const kickPlay = () => {
            if (cancelled) return
            void ensureVideoAutoplay(video).then((ok) => {
              if (!ok && video.paused) setStatus('Press play')
              else if (ok) setStatus('Playing')
            })
          }
          // Movy: require ~2–3 full segments buffered before play() so ABR has
          // room to breathe. Cap wait so opens still feel snappy.
          if (movyPlayback && !liveMode) {
            setStatus('Buffering…')
            const segDur = hlsTargetSegmentDurationSec(hls)
            const prebufferNeed = segDur * 2.5
            const prebufferCapMs = Math.min(20_000, Math.max(12_000, segDur * 4_000))
            const prebufferStarted = Date.now()
            const waitCushion = () => {
              if (cancelled) return
              // Don't call play() while the first segments are still on the wire.
              if (hlsHasInFlightMainFrag(hls) && Date.now() - prebufferStarted < prebufferCapMs) {
                window.setTimeout(waitCushion, 250)
                return
              }
              if (
                bufferedAheadSec() >= prebufferNeed ||
                Date.now() - prebufferStarted >= prebufferCapMs
              ) {
                kickPlay()
                return
              }
              window.setTimeout(waitCushion, 350)
            }
            waitCushion()
          } else {
            kickPlay()
          }
          // Live IPTV/sports: first play() often races MEDIA_ATTACHED — retry briefly.
          if (liveMode) {
            window.setTimeout(kickPlay, 900)
            window.setTimeout(kickPlay, 2800)
          }
          resolve()
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !hls) return
          // Non-fatal buffer underrun — nudge the loader instead of sitting idle
          // (VOD resume seeks often stall here until the user force-retries).
          if (!data.fatal && data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            const t = video.currentTime
            if (Number.isFinite(t) && t > 0.5) pinStallPlayhead(t)
            // Mid-title underrun: nudge the loader only. recoverMediaError here
            // rewound the seek bar to 0 and blacked the frame for several seconds.
            if (Number.isFinite(t) && t > 1 && !video.paused && !video.ended) {
              setStatus('Buffering…')
              nudgeHlsAtPlayhead()
              return
            }
            bufferStallNudges += 1
            setStatus('Buffering…')
            nudgeHlsAtPlayhead()
            // Mid-title: never recoverMediaError (MediaSource teardown → black /
            // seek bar 0). Remount only via explicit Retry. At cold start only.
            const midTitle = Number.isFinite(t) && t > 1 && !video.paused && !video.ended
            if (
              !midTitle &&
              bufferStallNudges >= 6 &&
              bufferStallNudges % 6 === 0 &&
              playRecoveries < 4
            ) {
              if (tryRecoverMediaError(hls)) playRecoveries += 1
              nudgeHlsAtPlayhead()
            }
            return
          }
          if (!data.fatal) return

          // Initial load: limited recoveries, then fail the engine promise.
          if (!settled) {
            if (recoveries < 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              recoveries += 1
              try {
                hls.startLoad()
                return
              } catch {
                /* fall through */
              }
            }
            if (recoveries < 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              if (tryRecoverMediaError(hls)) {
                recoveries += 1
                return
              }
            }
            settled = true
            window.clearTimeout(loadTimer)
            const message = describeHlsError(data)
            hls.destroy()
            hls = null
            reject(new Error(message))
            return
          }

          // Mid-playback network loss: wait for 'online' / back off without
          // spending recoveries or jumping to Atlantic.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (isOffline()) {
              setStatus('Reconnecting\u2026')
              return
            }
            if (scheduleNetBackoff()) {
              setStatus('Reconnecting\u2026')
              return
            }
          }

          // Mid-playback: keep recovering — the old `settled` gate dropped fatals
          // and left anime frozen on "Buffering…" with no Retry path.
          if (playRecoveries < 8) {
            playRecoveries += 1
            setStatus('Buffering…')
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              nudgeHlsAtPlayhead()
              return
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              tryRecoverMediaError(hls)
              nudgeHlsAtPlayhead()
              return
            }
          }

          const fb = hlsFallbackMetaRef.current
          const canAtlanticNow =
            Boolean(fb) &&
            !fb!.tried &&
            !fb!.busy &&
            (isMovyStreamUrl(activePlaylistItem.url) || fb!.tmdbId.length > 0)
          if (canAtlanticNow) {
            const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0
            setStatus('Stream stalled — switching source…')
            bumpChrome()
            void tryHlsFallbackRef.current(resumeAt)
            return
          }
          setError('Stream stalled — tap Retry, or pick another episode/quality.')
          setStatus('Buffering…')
          bumpChrome()
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
        const liveMode = isLivePlaybackItem(item)
        // Stash absorbs jitter on public sports TS; latency chasing emptied the
        // buffer and stalled while other apps on the same network kept playing.
        const stashSize = liveMode
          ? Math.max(perf.mpegTsStashInitialSize, 512 * 1024)
          : perf.mpegTsStashInitialSize
        tsPlayer = mpegts.createPlayer(
          { type: 'mse', isLive: liveMode, url: activePlaylistItem.url },
          {
            enableWorker: perf.enableMediaWorkers,
            enableStashBuffer: liveMode ? true : perf.mpegTsEnableStashBuffer,
            stashInitialSize: stashSize,
            liveBufferLatencyChasing: liveMode ? false : perf.mpegTsLiveLatencyChasing,
            liveBufferLatencyMaxLatency: liveMode
              ? Math.max(perf.mpegTsLiveLatencyMaxLatency, 10)
              : perf.mpegTsLiveLatencyMaxLatency,
            liveBufferLatencyMinRemain: Math.min(
              2.5,
              Math.max(perf.mpegTsLiveLatencyMaxLatency, 10) / 3,
            ),
            autoCleanupSourceBuffer: true,
          },
        )
        const loadTimer = window.setTimeout(() => {
          if (settled || cancelled) return
          settled = true
          try {
            tsPlayer?.destroy()
          } catch {
            /* ignore */
          }
          tsPlayer = null
          reject(new Error('MPEG-TS load timed out — stream stalled.'))
        }, liveMode ? 55_000 : 28_000)
        tsPlayer.on(mpegts.Events.ERROR, () => {
          if (settled) return
          settled = true
          window.clearTimeout(loadTimer)
          reject(new Error('MPEG-TS playback failed — stream offline or unsupported.'))
        })
        tsPlayer.attachMediaElement(video)
        tsPlayer.load()
        const finishPlaying = () => {
          if (settled || cancelled) return
          settled = true
          window.clearTimeout(loadTimer)
          setStatus('Playing')
          resolve()
        }
        const finishPaused = () => {
          if (settled || cancelled) return
          settled = true
          window.clearTimeout(loadTimer)
          setStatus('Press play')
          resolve()
        }
        const tryStart = (attempt: number) => {
          if (settled || cancelled) return
          void ensureVideoAutoplay(video).then((ok) => {
            if (settled || cancelled) return
            if (ok || (!video.paused && !video.ended)) {
              finishPlaying()
              return
            }
            if (liveMode && attempt < 2) {
              window.setTimeout(() => tryStart(attempt + 1), attempt === 0 ? 900 : 2000)
              return
            }
            finishPaused()
          })
        }
        void tsPlayer.play().then(
          () => finishPlaying(),
          () => tryStart(0),
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

      let engines = pickEngines(activePlaylistItem.url)
      // Samsung Tizen: native <video> HLS first when CORS blocks hls.js.
      if (
        isTizenTv() &&
        engines.includes('hls') &&
        !(await tizenCorsReadable(activePlaylistItem.url))
      ) {
        engines = ['native', ...engines.filter((e) => e !== 'native')]
      }
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
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(epKey)
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
          setStatus('Trying another source…')
          flash('Trying another source…')
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
          const reliabilityKey = playReliabilityKey({
            itemId: item.id,
            tmdbId,
            mediaType: 'tv',
            season,
            episode,
          })
          const lastGood = getLastGoodPlay(reliabilityKey)
          setError(null)
          setStatus('Trying sources…')
          flash('Trying sources…')
          try {
            const movy = await withTimeout(
              resolveMovyPlay({
                tmdbId,
                title: showName,
                mediaType: 'tv',
                season,
                episode,
                year: yearMatch?.[0],
                preferBackend: preferredResolveBackend(lastGood),
                preferProvider: lastGood?.provider,
                originalLanguage: normalizeLanguageCode(item.originalLanguage) || undefined,
              }),
              20_000,
              'Source lookup timed out.',
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
              rememberResolvedHlsPlay(reliabilityKey, movy)
              let subtitleUrl = movy.subtitleUrl
              let subtitleKind = movy.subtitleKind
              if (!subtitleUrl) {
                try {
                  const soft = await ensureEpisodeSoftSubtitles({
                    title: showName,
                    item: { ...item, rivestreamTmdbId: tmdbId },
                    tmdbId,
                    season,
                    episode,
                    skipWyzie: skipWyzieSubsRef.current,
                    force: item.category === 'anime',
                  })
                  if (cancelled) return
                  if (soft.subtitleUrl) {
                    subtitleUrl = soft.subtitleUrl
                    subtitleKind = soft.subtitleKind
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
            setStatus('Trying another source…')
            flash('Trying another source…')
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
      saveContinueProgress(true)
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

    const persist = () => saveContinueProgress(false)
    const persistNow = () => saveContinueProgress(true)
    const onTimeUpdate = () => {
      persist()
      const video = videoRef.current
      if (video) updatePlaybackClock(video)
      // Audio/playhead advancing — never leave the loading cover up over sound.
      if (
        video &&
        !video.error &&
        !video.paused &&
        video.currentTime > 0.25 &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        setMediaReady(true)
        setErrorRaw((prev) => (prev ? null : prev))
      }
      // Hide Resume once the playhead is already at/past that point (stale button
      // after a successful seek or after watching past the saved offset).
      if (video) {
        const playhead = effectivePlayhead(video)
        setResumeOffer((offer) => {
          if (offer == null) return offer
          if (playhead + 8 >= offer) return null
          return offer
        })
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
    const onPauseSave = () => persistNow()
    const onPageHide = () => persistNow()
    const onForceSave = () => persistNow()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persistNow()
    }
    const onBeforeUnload = () => persistNow()

    const video = videoRef.current
    video?.addEventListener('timeupdate', onTimeUpdate)
    video?.addEventListener('pause', onPauseSave)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
    // Interval backup — timeupdate is unreliable on some remux/HLS streams
    // (playhead stalls → frozen seekbar). Keep the clock moving.
    const interval = window.setInterval(() => {
      persist()
      const el = videoRef.current
      if (el) updatePlaybackClock(el)
    }, 1000)

    return () => {
      persistNow()
      video?.removeEventListener('timeupdate', onTimeUpdate)
      video?.removeEventListener('pause', onPauseSave)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener(FORCE_SAVE_CONTINUE_EVENT, onForceSave)
      window.clearInterval(interval)
    }
  }, [item.id, item.title, item.poster, item.category, playlistIndex, activePlaylistItem.title, isTile, hasPlaylist, skipIntervals])

  // One recommendation signal per playback session (not per progress tick):
  // when this title's session ends, a furthest playhead under a minute is a quick bail.
  useEffect(() => {
    if (isTile) return
    sessionFurthestRef.current = 0
    const session = {
      id: item.id,
      title: item.title,
      category: item.category,
      tags: item.tags,
      genres: item.genres,
    }
    return () => {
      const furthest = sessionFurthestRef.current
      void import('../lib/watchHistory').then(({ recordWatchSessionEnd }) => {
        recordWatchSessionEnd(session, furthest)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, isTile])

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
          void toggleFullscreen()
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
          if (showSubsControls && (subsStatus !== 'missing' || (!subtitleUrl && subsSearch !== 'off'))) {
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
          void toggleFullscreen()
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
  }, [onClose, muted, volume, isTile, showSubsControls, subsStatus, subtitleDelaySec, subsSearch, subtitleUrl])

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

  // Arm a 5s hide once the picture is up. Do not depend on status — Buffering
  // blips were restarting this timer and leaving Android controls up.
  useEffect(() => {
    if (isPip || isTile || !mediaReady || episodeLoading) return
    bumpChrome({ delayMs: CHROME_START_HIDE_MS })
  }, [mediaReady, episodeLoading, isPip, isTile, item.id, activePlaylistItem.url])

  // Fullscreen: show chrome briefly, then tuck it away so the picture stays clean.
  useEffect(() => {
    if (!osFullScreen || isPip || isTile || !mediaReady) return
    bumpChrome({ delayMs: CHROME_START_HIDE_MS })
  }, [osFullScreen, isPip, isTile, mediaReady])

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
        <div key="player-stage" className="player-stage">
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
                {!error && subsSearching ? ' · Looking for subtitles…' : ''}
                {!error && showSubsLoading ? ' · Loading subtitles…' : ''}
                {!error && subsStatus === 'missing' && !subsSearching ? ' · No subs' : ''}
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
                    ? 'Add another stream beside this one (two sources share bandwidth)'
                    : 'Add the next channel to multi-view instead of replacing'
              }
            >
              {awaitingAdd ? 'Pick channel…' : 'Multi-view'}
            </button>
          )}
          {!isPip && isAndroidCastHost() && (
              <button
                type="button"
                className={`ghost-btn control-btn${casting ? ' is-armed' : ''}`}
                onClick={() => void handleCast()}
                title={
                  casting
                    ? castDevice
                      ? `Stop casting to ${castDevice}`
                      : 'Stop casting'
                    : castAvailable &&
                        castModeForPlayback(item, activePlaylistItem.url || item.url) === 'media'
                      ? 'Cast this stream to a TV'
                      : 'Mirror this phone to a nearby TV'
                }
              >
                {casting
                  ? castDevice
                    ? `Cast · ${castDevice}`
                    : 'Casting'
                  : castAvailable &&
                      castModeForPlayback(item, activePlaylistItem.url || item.url) === 'media'
                    ? 'Cast'
                    : 'Mirror'}
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
                // Explicit Retry may tear down <video>; soft stalls must not.
                setHlsRemountNonce((n) => n + 1)
                if (canRetorrent) {
                  void selectPlaylistItem(playlistIndex, {
                    force: true,
                    rotateTorrent: true,
                  })
                  return
                }
                // Dead HLS — walk next pipe. Soft remount alone won't fix a dead CDN.
                void selectPlaylistItem(playlistIndex, {
                  force: true,
                  rotateSource: true,
                })
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
            {!animeAudioChoice && movyAudioOptions.length >= 2 && (
              <div className="player-audio-menu">
                <button
                  type="button"
                  className={`ghost-btn control-btn${movyAudioOpen ? ' is-armed' : ''}`}
                  onClick={() => {
                    setMovyAudioOpen((open) => !open)
                    bumpChrome()
                  }}
                  disabled={movyAudioBusy}
                  aria-haspopup="menu"
                  aria-expanded={movyAudioOpen}
                  title="Audio language"
                >
                  {movyAudioBusy ? 'Audio…' : `Audio: ${movyAudioCurrent?.label || 'Default'}`}
                </button>
                {movyAudioOpen && (
                  <div className="player-audio-menu-list" role="menu" aria-label="Audio language">
                    {movyAudioOptions.map((option) => {
                      const active = option.key === movyAudioCurrent?.key
                      return (
                        <button
                          key={option.key}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={`ghost-btn control-btn${active ? ' is-armed' : ''}`}
                          onClick={() => {
                            setMovyAudioOpen(false)
                            bumpChrome()
                            if (!active) void switchMovyAudio(option)
                          }}
                        >
                          {option.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {animeAudioChoice && (
              <button
                type="button"
                className={`ghost-btn control-btn${animeAudioMode === 'dub' ? ' is-armed' : ''}`}
                onClick={() => void switchAnimeAudio(animeAudioMode === 'dub' ? 'sub' : 'dub')}
                aria-pressed={animeAudioMode === 'dub'}
                title={
                  animeAudioMode === 'dub'
                    ? 'Playing the English dub - click for Japanese audio with subtitles'
                    : 'Playing Japanese audio with subtitles - click for the English dub'
                }
              >
                {animeAudioMode === 'dub' ? 'Dub' : 'Sub'}
              </button>
            )}
            {showSubsControls && (
              <>
                <button
                  type="button"
                  className={`ghost-btn control-btn${subsEnabled && subsStatus === 'ready' ? ' is-armed' : ''}`}
                  onClick={toggleSubtitles}
                  title={
                    subsSearching
                      ? 'Looking for subtitles… (click to check now)'
                      : subsRetryable
                        ? 'No subtitles found yet - click to search again'
                        : showSubsLoading
                      ? 'Click to fetch subtitles now'
                      : subsStatus === 'missing'
                        ? 'Retry loading subtitles'
                        : subsEnabled
                          ? 'Hide subtitles (C)'
                          : 'Show subtitles (C)'
                  }
                >
                  {subsSearching
                    ? 'Subs…'
                    : subsRetryable
                      ? 'Retry Subs'
                      : showSubsLoading
                    ? 'Subs…'
                    : subsStatus === 'missing'
                      ? 'Retry Subs'
                      : subsEnabled
                        ? 'Subs On'
                        : 'Subs Off'}
                </button>
                {subtitleUrl && translationSnap && (
                  <button
                    type="button"
                    className={`ghost-btn control-btn${
                      translateMode === 'translated' && translationSnap.status !== 'unavailable'
                        ? ' is-armed'
                        : ''
                    }`}
                    onClick={toggleTranslateMode}
                    title={
                      translationSnap.status === 'unavailable'
                        ? `Translation unavailable${translationSnap.error ? ` (${translationSnap.error})` : ''} - click to retry`
                        : translateMode === 'translated'
                          ? `Showing ${subtitleLanguageLabel(translationSnap.tgt)} translation${
                              translationSnap.src !== 'auto'
                                ? ` of ${subtitleLanguageLabel(translationSnap.src)} subtitles`
                                : ''
                            } - click for the original`
                          : 'Showing original subtitles - click for the translation'
                    }
                  >
                    {translationSnap.status === 'unavailable'
                      ? 'Translate'
                      : translateMode === 'original'
                        ? 'Original'
                        : translationSnap.translatedCues === 0
                          ? 'Translating\u2026'
                          : 'Translated'}
                  </button>
                )}
                {subtitleUrl && !translationSnap && translateOffer && subsStatus === 'ready' && (
                  <button
                    type="button"
                    className="ghost-btn control-btn"
                    onClick={requestTranslate}
                    title={`Translate ${
                      translateOffer === 'auto' ? 'these' : subtitleLanguageLabel(translateOffer)
                    } subtitles to ${subtitleLanguageLabel(getPreferredSubtitleLanguage())}`}
                  >
                    Translate
                  </button>
                )}
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
                      onClick={resetSubtitleDelay}
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
              <SeekSlider
                value={playbackClock.current}
                max={playbackClock.duration}
                disabled={Boolean(error) || episodeLoading}
                onScrub={() => bumpChrome()}
                onCommit={(next) => {
                  seekToAbsolute(next)
                  bumpChrome()
                }}
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

      <div
        key="player-stage"
        className="player-stage"
        onPointerUp={isPip ? undefined : toggleChromeOnTap}
      >
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
        {isPip && playbackClock.duration > 0 && (
          <label
            className="player-pip-seek"
            title="Seek"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sr-only">Seek</span>
            <SeekSlider
              value={playbackClock.current}
              max={playbackClock.duration}
              disabled={Boolean(error) || episodeLoading}
              onCommit={(next) => {
                seekToAbsolute(next)
              }}
            />
          </label>
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
