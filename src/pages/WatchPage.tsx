import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PlaybackLoadingScreen } from '../components/PlaybackLoadingScreen'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import {
  getContinueEntry,
  mergeRuntimeSeconds,
  streamItemFromContinueEntry,
  type ContinueWatchingEntry,
} from '../lib/continueWatching'
import { hasRealDebridToken } from '../lib/debridSettings'
import {
  cleanShowDisplayTitle,
  getConnectionDownlinkMbps,
  isDebridHttpPlayUrl,
  isTorrentInput,
  buildEpisodeChoices,
  isShowBrowseItem,
  isM2BoxCatalogItem,
  isNetMirrorCatalogItem,
  isYmoviesCatalogItem,
  isCinetaroCatalogItem,
  isTmdbTvCatalogItem,
  parseEpisodeKey,
  pickBestEpisodeIndex,
  pickBestStream,
  resolveShowEpisodes,
  scrapePage,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { cinetaroCinextreamMovieEmbedUrl } from '../lib/cinetaro'
import { resolveM2BoxPlay } from '../lib/m2box'
import { ensureEpisodeSoftSubtitles, resolveSoftSubtitles } from '../lib/softSubs'
import {
  lookupTmdbMovieMeta,
  rivestreamTmdbIdFromItem,
  shouldPreferRivestreamJapaneseAudio,
} from '../lib/rivestream'
import { resolveMovyPlay, MOVY_PLAY_REFERER } from '../lib/movy'
import {
  getLastGoodPlay,
  playReliabilityKey,
  preferredResolveBackend,
  rememberLastGoodPlay,
} from '../lib/playReliability'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import { getViewingQuality, resolveRequestedQuality } from '../lib/viewingQuality'
import { isStreamedCatalogItem, resolveStreamedPlay } from '../lib/streamed'
import {
  isLivextvReplayCatalogItem,
  resolveLivextvReplayPlay,
} from '../lib/livextvReplays'
import {
  isFullmatchShowsCatalogItem,
  resolveFullmatchShowsPlay,
} from '../lib/fullmatchShows'
import {
  isNativeMedia3PlaybackItem,
  isWebEmbedPlaybackItem,
  isYouTubeUrl,
  shouldOpenInWebBrowser,
  toAutoplayUrl,
} from '../lib/webBrowser'
import { resolveYouTubeLivePlay } from '../lib/youtubeLive'
import { isVimeoLiveEventUrl, resolveVimeoLiveHls } from '../lib/vimeoLive'
import {
  isTorrentPlaybackAvailable,
  torrentStream,
} from '../lib/torrentBridge'
import { maskUserFacingMessage } from '../lib/sourceMask'
import {
  androidBrowserHide,
  androidBrowserMultiHideAll,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  androidResolveEmbedMedia,
  canAndroidResolveEmbedMedia,
} from '../lib/androidStreamResolve'
import { isAndroidMedia3Host, media3Hide } from '../lib/androidMedia3'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

function clearWebSurfacesForWatch() {
  void window.signalDesktop?.browserMultiHideAll?.({ blank: true })
  void window.signalDesktop?.browserAdDockClose?.()
  void window.signalDesktop?.browserHide?.({ blank: true })
  if (isAndroidInAppBrowser()) {
    void androidBrowserMultiHideAll({ blank: true })
    // Hide only — no blank and no pause. Pausing then reopening Sports Replay
    // left Gecko's empty white compositor on screen until the embed painted.
    void androidBrowserHide({ blank: false, pause: false })
  }
  window.dispatchEvent(new Event('jiyu:clear-web-surfaces'))
}

/** Series / anime / show-shelf kids — attach a multi-episode playlist on continue. */
function wantsShowEpisodePlaylist(item: StreamItem): boolean {
  if (isShowBrowseItem(item)) return true
  if (item.category === 'series' || item.category === 'anime') return true
  if (item.category === 'kids') {
    return Boolean(
      item.tags?.some((t) => /full-shows|kids-shows|kids.?show/i.test(t)),
    )
  }
  return false
}

function isTorrentPlaybackItem(item: StreamItem): boolean {
  if (item.transport === 'torrent' || item.sourceKind === 'torrent') return true
  if (item.torrentUri && isTorrentInput(item.torrentUri)) return true
  return false
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isTransientSourceError(message: string): boolean {
  return /timed? ?out|took too long|unavailable|no working sources|no peers|no reachable|empty source|not ready|read failed|could not start|engine failed/i.test(
    message,
  )
}

/** Build player playlist rows; activeIndex gets the live stream URL when known. */
function episodePlaylistFromChoices(
  episodes: EpisodeChoice[],
  activeIndex: number,
  active?: { url?: string; torrentUri?: string; subtitleUrl?: string; subtitleKind?: 'file' | 'embedded'; fileName?: string },
): StreamPlaylistItem[] {
  return episodes.map((ep, i) =>
    i === activeIndex
      ? {
          title: ep.title,
          url: active?.url || '',
          torrentUri: active?.torrentUri || ep.torrentUri,
          torrentAlternates: ep.alternates,
          episodeKey: ep.key,
          subtitleUrl: active?.subtitleUrl,
          subtitleKind: active?.subtitleKind,
          fileName: active?.fileName,
        }
      : {
          title: ep.title,
          url: '',
          torrentUri: ep.torrentUri,
          torrentAlternates: ep.alternates,
          episodeKey: ep.key,
        },
  )
}

/** Prefer the saved continue episode over “first episode” / URI heuristics. */
function resolveContinueEpisodeIndex(
  episodes: EpisodeChoice[],
  saved: ContinueWatchingEntry | null,
): number | null {
  if (!saved || saved.currentTime < 5 || episodes.length === 0) return null
  const max = episodes.length - 1

  if (saved.episodeTitle) {
    const savedKey = parseEpisodeKey(saved.episodeTitle)
    if (savedKey) {
      const byKey = episodes.findIndex((ep) => ep.key === savedKey)
      if (byKey >= 0) return byKey
    }
    const byTitle = episodes.findIndex(
      (ep) =>
        ep.title === saved.episodeTitle ||
        ep.title.includes(saved.episodeTitle!) ||
        saved.episodeTitle!.includes(ep.title),
    )
    if (byTitle >= 0) return byTitle
  }

  if (saved.torrentUri) {
    const byUri = episodes.findIndex((ep) => ep.torrentUri === saved.torrentUri)
    if (byUri >= 0) return byUri
  }

  // Title on the continue card is often "Show · S01E02".
  const titleKey = parseEpisodeKey(saved.title)
  if (titleKey) {
    const byKey = episodes.findIndex((ep) => ep.key === titleKey)
    if (byKey >= 0) return byKey
  }

  return Math.min(Math.max(0, saved.playlistIndex), max)
}

/** SxxExx (or Exx) from a title / continue entry → M2Box play API season + episode. */
function m2boxSeasonEpisode(title: string | undefined | null): { season: number; episode: number } {
  const key = title ? parseEpisodeKey(title) : null
  if (key) {
    const sxxexx = /^S(\d{1,2})E(\d{1,3})$/i.exec(key)
    if (sxxexx) {
      return { season: Math.max(1, Number(sxxexx[1])), episode: Math.max(1, Number(sxxexx[2])) }
    }
    const exx = /^E(\d+(?:\.\d+)?)$/i.exec(key)
    if (exx) {
      return { season: 1, episode: Math.max(1, Math.floor(Number(exx[1]))) }
    }
  }
  return { season: 1, episode: 1 }
}

export function WatchPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { getById, items } = useCatalog()
  const { play, item: playing, slots, mode, awaitingAdd } = usePlayback()
  const raw = id ? getById(id) : undefined
  const continued = useMemo(() => (id ? getContinueEntry(id) : null), [id])
  const item = useMemo(() => {
    const fromCatalog = resolvePlayableItem(raw, items)
    if (fromCatalog) return fromCatalog
    if (continued) return streamItemFromContinueEntry(continued)
    return undefined
  }, [raw, items, continued])
  const [error, setErrorRaw] = useState<string | null>(null)
  const setError = (value: string | null) =>
    setErrorRaw(value == null ? null : maskUserFacingMessage(value))
  const returnTo =
    typeof location.state === 'object' &&
    location.state &&
    'from' in location.state &&
    typeof (location.state as { from?: unknown }).from === 'string'
      ? (location.state as { from: string }).from
      : continued
        ? `/section/${continued.category}`
        : null

  // Read at torrent-start time — must NOT be effect deps. If they are, arming
  // Multi-view or Back→PiP re-runs start() and forceFull undoes both.
  const multiviewGuardRef = useRef({ awaitingAdd, slotsLen: slots.length, mode })
  multiviewGuardRef.current = { awaitingAdd, slotsLen: slots.length, mode }
  // Catalog sync replaces `items` often. Restarting start() cancels the torrent
  // before play() and leaves this screen on "Getting episode ready…".
  const itemsRef = useRef(items)
  itemsRef.current = items
  const playingIdRef = useRef(playing?.id)
  playingIdRef.current = playing?.id
  // GlobalPlayer <video> already owns this title (PiP Expand lands here).
  const playingNativeRef = useRef(false)
  playingNativeRef.current = Boolean(
    playing &&
      mode !== 'off' &&
      !isWebEmbedPlaybackItem(playing) &&
      !isNativeMedia3PlaybackItem(playing),
  )

  useEffect(() => {
    if (!item) return

    let cancelled = false

    async function start() {
      setError(null)

      // PiP Expand → /watch/<id> for a title the native player already owns.
      // Cinetaro series now play via Movy/Bilibili HLS (0.3.70), so the Cinetaro
      // redirect below sent /watch → /show while mode was 'full', and
      // NavigationPiPBridge minimized straight back to the corner player.
      if (playingIdRef.current === item!.id && playingNativeRef.current) {
        const guard = multiviewGuardRef.current
        if (guard.mode !== 'multi' && !guard.awaitingAdd) return
      }

      // Cinetaro TV catalog pages are a Cloudflare wall — episode play uses ShowPage.
      // Cinetaro *movies* (shelf search fallback) go straight to the cinextream embed.
      if (isCinetaroCatalogItem(item!) && item!.category === 'movies') {
        const tmdbId = String(item!.cinetaroTmdbId || '').trim()
        const playUrl =
          (item!.url && /cinextream\.cc/i.test(item!.url) ? item!.url : '') ||
          (tmdbId ? cinetaroCinextreamMovieEmbedUrl(tmdbId) : '') ||
          item!.url
        if (!playUrl) {
          setError('No stream for this movie.')
          return
        }
        clearWebSurfacesForWatch()
        navigate(`/web?url=${encodeURIComponent(playUrl)}`, {
          replace: true,
          state: {
            from: returnTo || '/section/movies',
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item!.id,
              title: item!.title,
              poster: item!.poster,
              category: item!.category,
              playlistIndex: 0,
              detailUrl: item!.detailUrl || item!.url,
              playUrl,
              transport: item!.transport,
              sourceKind: item!.sourceKind,
              source: item!.source,
            },
          },
        })
        return
      }
      if (isCinetaroCatalogItem(item!)) {
        navigate(`/show/${item!.id}`, { replace: true, state: { from: returnTo } })
        return
      }

      // Already owning this title — for native players, skip. For web embeds,
      // still reopen /web (multi-view recovery / same-card re-click).
      // LiveXTV / Streamed need resolve — don't reopen the raw catalog URL.
      if (playingIdRef.current === item!.id) {
        const guard = multiviewGuardRef.current
        if (guard.mode === 'multi' || guard.awaitingAdd) return
        if (
          isLivextvReplayCatalogItem(item!) ||
          isFullmatchShowsCatalogItem(item!) ||
          isStreamedCatalogItem(item!) ||
          (isYouTubeUrl(item!.url) &&
            (item!.tags?.includes('local') || item!.id?.startsWith('local-')))
        ) {
          // Fall through to resolve below.
        } else if (shouldOpenInWebBrowser(item!)) {
          clearWebSurfacesForWatch()
          const playUrl = item!.url
          const activeUrl =
            playing?.url && shouldOpenInWebBrowser(playing)
              ? playing.url
              : playUrl
          navigate(`/web?url=${encodeURIComponent(activeUrl)}`, {
            replace: true,
            state: {
              from: returnTo || '/section/sports',
              playerMode: 'embed',
              pipOnBack: true,
              continueWatch: {
                id: item!.id,
                title: item!.title,
                poster: item!.poster,
                category: item!.category,
                playlistIndex: 0,
                detailUrl: item!.detailUrl || item!.url,
                playUrl: activeUrl,
                transport: item!.transport,
                sourceKind: item!.sourceKind,
                source: item!.source,
              },
            },
          })
          return
        } else {
          return
        }
      }

      // Tear down leftover multi-view web tiles before a fresh single watch —
      // never while adding to an existing multi-view session.
      {
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
      }

      // Series / anime / M2Box: episode list first; resume continues with full playlist
      // so Next / Previous / Episodes still work (same as ShowPage play).
      if (isM2BoxCatalogItem(item!)) {
        const saved = getContinueEntry(item!.id)
        const resuming = Boolean(saved && saved.currentTime >= 5)
        if (!resuming) {
          navigate(`/show/${item!.id}`, { replace: true, state: { from: returnTo } })
          return
        }
        if (!window.signalDesktop?.fetchJsonGet && !window.signalDesktop?.fetchHtml) {
          try {
            const { isNativeHttpPlatform } = await import('../lib/nativeHttp')
            if (!isNativeHttpPlatform()) {
              navigate(`/web?url=${encodeURIComponent(item!.detailUrl || item!.url)}`, {
                replace: true,
              })
              return
            }
          } catch {
            navigate(`/web?url=${encodeURIComponent(item!.detailUrl || item!.url)}`, {
              replace: true,
            })
            return
          }
        }
        const resumeTitle = saved?.episodeTitle || saved?.title || item!.title
        const { season, episode } = m2boxSeasonEpisode(resumeTitle)
        const [resolved, episodeList] = await Promise.all([
          resolveM2BoxPlay(item!.detailUrl || item!.url, {
            subjectId: item!.m2boxSubjectId,
            season,
            episode,
          }),
          resolveShowEpisodes(item!, itemsRef.current),
        ])
        if (cancelled) return
        if (!resolved.ok) {
          navigate(`/show/${item!.id}`, { replace: true, state: { from: returnTo } })
          return
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: resolved.url,
            referrer: resolved.referer,
          })
        }
        const showName = cleanShowDisplayTitle(item!.title) || item!.title
        const epLabel = `S${String(resolved.season).padStart(2, '0')}E${String(resolved.episode).padStart(2, '0')}`
        const episodes = episodeList.episodes
        const resumeKey = epLabel
        const resumeIndex = Math.max(
          0,
          episodes.findIndex((ep) => ep.key === resumeKey),
        )
        let subtitleUrl: string | undefined
        let subtitleKind: 'file' | undefined
        let tmdbId = rivestreamTmdbIdFromItem(item!)
        let originalLanguage = item!.originalLanguage
        try {
          const soft = await ensureEpisodeSoftSubtitles({
            title: showName,
            item: item!,
            season: resolved.season,
            episode: resolved.episode,
            force: true,
          })
          tmdbId = soft.tmdbId || tmdbId
          originalLanguage = soft.originalLanguage || originalLanguage
          subtitleUrl = soft.subtitleUrl
          subtitleKind = soft.subtitleKind
        } catch {
          /* Player may still try softsubs once playback starts */
        }
        const catalogPatch = {
          ...(tmdbId && tmdbId !== item!.rivestreamTmdbId ? { rivestreamTmdbId: tmdbId } : {}),
          ...(originalLanguage && originalLanguage !== item!.originalLanguage
            ? { originalLanguage }
            : {}),
        }
        if (Object.keys(catalogPatch).length > 0) {
          void upsertTorrentItems([{ ...item!, ...catalogPatch }])
        }
        const playlist: StreamPlaylistItem[] =
          episodes.length > 0
            ? episodes.map((ep, i) =>
                i === resumeIndex
                  ? {
                      title: ep.title,
                      url: resolved.url,
                      episodeKey: ep.key,
                      subtitleUrl,
                      subtitleKind,
                    }
                  : {
                      title: ep.title,
                      url: '',
                      episodeKey: ep.key,
                    },
              )
            : [
                {
                  title: epLabel,
                  url: resolved.url,
                  episodeKey: resumeKey,
                  subtitleUrl,
                  subtitleKind,
                },
              ]
        play(
          {
            ...item!,
            ...catalogPatch,
            title: `${showName} · ${epLabel}`,
            url: resolved.url,
            httpReferrer: resolved.referer,
            playlist,
            subtitleUrl,
            subtitleKind,
            transport: 'direct',
            tags: [
              ...new Set([
                ...(item!.tags ?? []),
                'm2box',
                resolved.format,
                ...(subtitleUrl ? ['softsub'] : []),
              ]),
            ],
            runtimeSeconds: resolved.durationSeconds ?? item!.runtimeSeconds,
            m2boxSubjectId: resolved.subjectId || item!.m2boxSubjectId,
          },
          { forceFull: true, returnTo: returnTo ?? `/show/${item!.id}` },
        )
        return
      }

      // NetMirror / YMovies / TMDB: episode list first; play opens Web Browser or native HLS.
      if (
        isNetMirrorCatalogItem(item!) ||
        isYmoviesCatalogItem(item!) ||
        isTmdbTvCatalogItem(item!)
      ) {
        navigate(`/show/${item!.id}`, { replace: true, state: { from: returnTo } })
        return
      }

      // Streamed.pk live sports → resolve embed.st URL, play in Web Browser (PiP on Back).
      // Android: try Gecko unwrap → Media3 first; fall back to embed WebView.
      if (isStreamedCatalogItem(item!)) {
        const resolved = await resolveStreamedPlay(item!)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Could not load Streamed match')
          return
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()

        if (
          !keepOthers &&
          isAndroidMedia3Host() &&
          canAndroidResolveEmbedMedia()
        ) {
          setError('Unwrapping stream…')
          // Gecko sniffs the media URL while we stay on the loading screen.
          const unwrapped = await androidResolveEmbedMedia(resolved.url, 12_000)
          if (cancelled) return
          if (unwrapped.ok && unwrapped.mediaUrl) {
            setError(null)
            const webItem = {
              ...item!,
              url: unwrapped.mediaUrl,
              tags: [
                ...new Set(
                  [...(item!.tags ?? []), 'live', 'media3'].filter(
                    (t) => t !== 'web-embed',
                  ),
                ),
              ],
            }
            play(webItem, {
              forceFull: true,
              replace: true,
              returnTo: returnTo || '/section/sports',
            })
            navigate('/native-stream', {
              replace: true,
              state: {
                from: returnTo || '/section/sports',
                title: item!.title,
                mediaUrl: unwrapped.mediaUrl,
                referrer: unwrapped.referrer || resolved.url,
                poster: item!.poster,
                category: item!.category,
                continueId: item!.id,
              },
            })
            return
          }
          // Sniff failed — clear any Media3 overlay before Gecko /web fallback.
          void media3Hide({ stop: true })
        }

        const webItem = {
          ...item!,
          url: resolved.url,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'live'])],
        }
        if (keepOthers) {
          play(webItem, {
            forceFull: true,
            replace: false,
            returnTo: returnTo || '/section/sports',
          })
          navigate('/multiview', { replace: true })
          return
        }
        // Navigate to /web BEFORE play(). play() marks the title "ready" and
        // WatchPage blanks itself while GlobalPlayer returns null for web-embed
        // — if navigate is skipped/raced, that is a permanent black screen.
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          replace: true,
          state: {
            from: returnTo || '/section/sports',
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item!.id,
              title: item!.title,
              poster: item!.poster,
              category: item!.category,
              playlistIndex: 0,
              detailUrl: item!.detailUrl || item!.url,
              playUrl: resolved.url,
              transport: item!.transport,
              sourceKind: item!.sourceKind,
              source: item!.source,
            },
          },
        })
        play(webItem, {
          forceFull: true,
          replace: true,
          returnTo: returnTo || '/section/sports',
        })
        return
      }

      // FullMatchShows football replays → playmate / playmogo embeds.
      if (isFullmatchShowsCatalogItem(item!)) {
        const resolved = await resolveFullmatchShowsPlay(item!)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Could not load replay')
          return
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
        const webItem = {
          ...item!,
          url: resolved.url,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'replay'])],
        }
        if (keepOthers) {
          play(webItem, {
            forceFull: true,
            replace: false,
            returnTo: returnTo || '/section/sports',
          })
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          replace: true,
          state: {
            from: returnTo || '/section/sports',
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item!.id,
              title: item!.title,
              poster: item!.poster,
              category: item!.category,
              playlistIndex: 0,
              detailUrl: item!.detailUrl || item!.url,
              playUrl: resolved.url,
              transport: item!.transport,
              sourceKind: item!.sourceKind,
              source: item!.source,
            },
          },
        })
        play(webItem, {
          forceFull: true,
          replace: true,
          returnTo: returnTo || '/section/sports',
        })
        return
      }

      // LiveXTV replays → unwrap soccerfull (native HLS when available, else embed).
      if (isLivextvReplayCatalogItem(item!)) {
        const resolved = await resolveLivextvReplayPlay(item!)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Could not load replay')
          return
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
        if (resolved.mode === 'hls') {
          if (window.signalDesktop?.setPlaybackHeaders) {
            void window.signalDesktop.setPlaybackHeaders({
              url: resolved.url,
              referrer: resolved.referer,
            })
          }
          play(
            {
              ...item!,
              url: resolved.url,
              httpReferrer: resolved.referer,
              tags: [...new Set([...(item!.tags ?? []), 'hls', 'replay'])].filter(
                (t) => t !== 'web-embed',
              ),
              transport: 'direct',
            },
            {
              forceFull: true,
              replace: !keepOthers,
              returnTo: returnTo || '/section/sports',
            },
          )
          return
        }
        const webItem = {
          ...item!,
          url: resolved.url,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'replay'])],
        }
        if (keepOthers) {
          play(webItem, {
            forceFull: true,
            replace: false,
            returnTo: returnTo || '/section/sports',
          })
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          replace: true,
          state: {
            from: returnTo || '/section/sports',
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item!.id,
              title: item!.title,
              poster: item!.poster,
              category: item!.category,
              playlistIndex: 0,
              detailUrl: item!.detailUrl || item!.url,
              playUrl: resolved.url,
              transport: item!.transport,
              sourceKind: item!.sourceKind,
              source: item!.source,
            },
          },
        })
        play(webItem, {
          forceFull: true,
          replace: true,
          returnTo: returnTo || '/section/sports',
        })
        return
      }

      // Local YouTube channels (Nationwide / CVM / TVJ): resolve @handle/live →
      // watch?v= so the browser skips YouTube's heavy channel SPA (~20s).
      // Prefer watch URL over /embed/ (embeds blanked the WebContentsView shell).
      // pipOnBack + playerMode embed arm leave→PiP (isEmbedPlayerHost(/watch)).
      if (
        isYouTubeUrl(item!.url) &&
        (item!.tags?.includes('local') || item!.id?.startsWith('local-'))
      ) {
        const resolved = await resolveYouTubeLivePlay(item!.url)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'This channel is not live right now')
          return
        }
        const playUrl = resolved.watchUrl || toAutoplayUrl(item!.url)
        const webItem = {
          ...item!,
          url: playUrl,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'live', 'youtube'])],
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
        if (keepOthers) {
          play(webItem, {
            forceFull: true,
            replace: false,
            returnTo: returnTo || '/',
          })
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(playUrl)}`, {
          replace: true,
          state: {
            from: returnTo || '/',
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item!.id,
              title: item!.title,
              poster: item!.poster,
              category: item!.category,
              playlistIndex: 0,
              detailUrl: item!.detailUrl || item!.url,
              playUrl,
              transport: item!.transport,
              sourceKind: item!.sourceKind,
              source: item!.source,
            },
          },
        })
        play(webItem, {
          forceFull: true,
          replace: true,
          returnTo: returnTo || '/',
        })
        return
      }

      // PPV / Streamed / tagged embeds — even when iframe host rotates off embed.st.
      if (shouldOpenInWebBrowser(item!)) {
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()

        const sportsLike =
          item!.category === 'sports' ||
          item!.tags?.includes('247-series') ||
          item!.tags?.includes('kids-live') ||
          item!.tags?.includes('ppv.st') ||
          item!.tags?.includes('live')
        // Replays must stay on the Gecko embed path — Media3 unwrap left white /web.
        const isReplay =
          item!.tags?.includes('replay') ||
          item!.tags?.includes('livextv') ||
          item!.tags?.includes('fullmatchshows')

        if (
          sportsLike &&
          !isReplay &&
          !keepOthers &&
          isAndroidMedia3Host() &&
          canAndroidResolveEmbedMedia()
        ) {
          setError('Unwrapping stream…')
          const unwrapped = await androidResolveEmbedMedia(item!.url, 12_000)
          if (cancelled) return
          if (unwrapped.ok && unwrapped.mediaUrl) {
            setError(null)
            const nativeItem = {
              ...item!,
              url: unwrapped.mediaUrl,
              tags: [
                ...new Set(
                  [...(item!.tags ?? []), 'media3'].filter((t) => t !== 'web-embed'),
                ),
              ],
            }
            play(nativeItem, {
              forceFull: true,
              replace: true,
              returnTo: returnTo || undefined,
            })
            navigate('/native-stream', {
              replace: true,
              state: {
                from:
                  returnTo ||
                  (item!.category === 'kids'
                    ? '/section/kids'
                    : item!.category === 'series'
                      ? '/section/series'
                      : '/section/sports'),
                title: item!.title,
                mediaUrl: unwrapped.mediaUrl,
                referrer: unwrapped.referrer || item!.url,
                poster: item!.poster,
                category: item!.category,
                continueId: item!.id,
              },
            })
            return
          }
          void media3Hide({ stop: true })
        }

        const webItem = {
          ...item!,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed'])],
        }
        const webState =
          item!.category === 'sports' ||
          item!.tags?.includes('247-series') ||
          item!.tags?.includes('kids-live')
            ? {
                from:
                  returnTo ||
                  (item!.category === 'kids'
                    ? '/section/kids'
                    : item!.category === 'series'
                      ? '/section/series'
                      : '/section/sports'),
                playerMode: 'embed' as const,
                pipOnBack: true,
                continueWatch: {
                  id: item!.id,
                  title: item!.title,
                  poster: item!.poster,
                  category: item!.category,
                  playlistIndex: 0,
                  detailUrl: item!.detailUrl || item!.url,
                  playUrl: item!.url,
                  transport: item!.transport,
                  sourceKind: item!.sourceKind,
                  source: item!.source,
                },
              }
            : undefined
        if (keepOthers) {
          play(webItem, {
            forceFull: true,
            replace: false,
            returnTo: returnTo || undefined,
          })
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(item!.url)}`, {
          replace: true,
          state: webState,
        })
        play(webItem, {
          forceFull: true,
          replace: true,
          returnTo: returnTo || undefined,
        })
        return
      }

      // CVM (and similar): Vimeo live event → fresh tokenized HLS
      if (isVimeoLiveEventUrl(item!.url)) {
        const resolved = await resolveVimeoLiveHls(item!.url)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Could not resolve Vimeo live stream')
          return
        }
        play(
          {
            ...item!,
            url: resolved.url,
            description: resolved.title || item!.description,
            tags: [...new Set([...(item!.tags ?? []), 'hls', 'vimeo'])],
          },
          { forceFull: true, returnTo },
        )
        return
      }

      // Movies: prefer Movy/Atlantic HLS (same as series) before magnets — first
      // click often raced a cold torrent engine and looked like "no source".
      if (item!.category === 'movies' && !wantsShowEpisodePlaylist(item!)) {
        const movieTitle = cleanShowDisplayTitle(item!.title) || item!.title
        const yearMatch = /\b((?:19|20)\d{2})\b/.exec(
          String(item!.title || item!.description || ''),
        )
        let tmdbId = rivestreamTmdbIdFromItem(item!)
        if (!tmdbId) {
          try {
            const meta = await lookupTmdbMovieMeta(item!.title || movieTitle)
            if (cancelled) return
            tmdbId = meta?.tmdbId || ''
          } catch {
            tmdbId = ''
          }
        }
        if (tmdbId) {
          const reliabilityKey = playReliabilityKey({
            itemId: item!.id,
            tmdbId,
            mediaType: 'movie',
          })
          const lastGood = getLastGoodPlay(reliabilityKey)
          try {
            const movy = await withTimeout(
              resolveMovyPlay({
                tmdbId,
                title: movieTitle,
                mediaType: 'movie',
                year: yearMatch?.[1],
                preferBackend: preferredResolveBackend(lastGood),
                preferProvider: lastGood?.provider,
              }),
              22_000,
              'Source lookup timed out.',
            )
            if (cancelled) return
            if (movy.ok) {
              if (!item!.rivestreamTmdbId) {
                void upsertTorrentItems([{ ...item!, rivestreamTmdbId: tmdbId }])
              }
              rememberLastGoodPlay(reliabilityKey, movy.backend ?? 'movy', {
                provider: movy.provider,
                host: (() => {
                  try {
                    return new URL(movy.url).hostname
                  } catch {
                    return undefined
                  }
                })(),
              })
              let subtitleUrl = movy.subtitleUrl
              let subtitleKind = movy.subtitleKind
              if (!subtitleUrl) {
                try {
                  const soft = await resolveSoftSubtitles({ tmdbId })
                  if (cancelled) return
                  if (soft.ok) {
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
              play(
                {
                  ...item!,
                  rivestreamTmdbId: tmdbId,
                  title: movieTitle,
                  url: movy.url,
                  httpReferrer: movy.referer || MOVY_PLAY_REFERER,
                  subtitleUrl,
                  subtitleKind,
                  transport: 'direct',
                  tags: [
                    ...new Set([
                      ...(item!.tags ?? []),
                      movy.backend === 'atlantic' ? 'atlantic' : 'movy',
                      'hls',
                      ...(movy.provider ? [movy.provider] : []),
                      ...(subtitleUrl ? ['softsub'] : []),
                    ]),
                  ],
                },
                {
                  forceFull: true,
                  returnTo: returnTo ?? `/show/${item!.id}`,
                },
              )
              return
            }
          } catch {
            /* fall through to torrent / other paths */
          }
        }
      }

      // Torrent catalog entries store a detail page / magnet — resolve at play time.
      // Series / anime / show cards: always rebuild the full episode playlist on continue.
      if (isTorrentPlaybackItem(item!)) {
        if (!isTorrentPlaybackAvailable()) {
          setError('Playback needs the Jiyu desktop app or Android source engine.')
          return
        }
        try {
          let uri = item!.torrentUri ?? ''
          let title = item!.title
          let episodePlaylist: StreamPlaylistItem[] | undefined
          let startEpisodeIndex = 0
          let episodeAlternates: EpisodeChoice | null = null
          const preference = getViewingQuality()
          const downlink = getConnectionDownlinkMbps()
          const isShowShelf = wantsShowEpisodePlaylist(item!)

          if (isShowShelf) {
            const saved = getContinueEntry(item!.id)
            const resuming = Boolean(saved && saved.currentTime >= 5)
            // Fresh show-card clicks belong on the episode list — auto-playing
            // S01E01 is usually a dead swarm on EZTV.
            if (!resuming && !(uri && isTorrentInput(uri))) {
              navigate(`/show/${item!.id}`, { replace: true, state: { from: returnTo } })
              return
            }
          }

          if (isShowShelf) {
            const resolved = await resolveShowEpisodes(item!, itemsRef.current)
            if (cancelled) return
            const episodes = resolved.episodes
            if (episodes.length === 0) {
              setError(resolved.error || 'No episodes found for this title.')
              return
            }
            const saved = getContinueEntry(item!.id)
            const continuedIndex = resolveContinueEpisodeIndex(episodes, saved)
            if (continuedIndex != null) {
              startEpisodeIndex = continuedIndex
            } else if (uri && isTorrentInput(uri)) {
              const currentKey = parseEpisodeKey(item!.title)
              const byKey = currentKey
                ? episodes.findIndex((ep) => ep.key === currentKey)
                : -1
              const byUri = episodes.findIndex((ep) => ep.torrentUri === uri)
              startEpisodeIndex =
                byKey >= 0 ? byKey : byUri >= 0 ? byUri : pickBestEpisodeIndex(episodes)
            } else {
              startEpisodeIndex = pickBestEpisodeIndex(episodes)
            }
            const chosen = episodes[startEpisodeIndex]
            episodeAlternates = chosen
            uri = chosen.torrentUri
            title = chosen.title || title
            episodePlaylist = episodePlaylistFromChoices(episodes, startEpisodeIndex)
          } else if (!uri || !isTorrentInput(uri)) {
            const detail = item!.detailUrl || item!.url
            let outcome = await scrapePage(detail, item!.source || 'torrent')
            if (cancelled) return
            // One quiet retry — YTS / detail APIs occasionally 5xx on the first hit.
            if (outcome.results.length === 0) {
              await sleep(500)
              if (cancelled) return
              outcome = await scrapePage(detail, item!.source || 'torrent')
              if (cancelled) return
            }
            if (outcome.results.length === 0) {
              setError(outcome.error || 'No source link found on that page.')
              return
            }
            const requestedQuality = resolveRequestedQuality(preference, downlink)
            const episodes = buildEpisodeChoices(outcome.results, downlink, requestedQuality)

            if (episodes.length > 1) {
              const saved = getContinueEntry(item!.id)
              startEpisodeIndex =
                resolveContinueEpisodeIndex(episodes, saved) ?? pickBestEpisodeIndex(episodes)
              const chosen = episodes[startEpisodeIndex]
              episodeAlternates = chosen
              uri = chosen.torrentUri
              title = chosen.title || title
              episodePlaylist = episodePlaylistFromChoices(episodes, startEpisodeIndex)
            } else {
              const pick = pickBestStream(outcome.results, downlink, requestedQuality)
              if (!pick) {
                setError('Could not choose a source for this title.')
                return
              }
              uri = pick.result.uri
              title = pick.result.title || title
            }
          }

          const useTorrentio =
            TORRENTIO_TV_TRIAL &&
            (item!.category === 'series' || item!.category === 'kids') &&
            Boolean(episodeAlternates)
          const useDebrid = useTorrentio && hasRealDebridToken()
          if (useDebrid) setError('Checking ready sources…')
          else if (useTorrentio) setError('Checking more sources…')
          const candidates = episodeAlternates
            ? await torrentUrisForEpisodeWithTorrentio(episodeAlternates, item!.title, {
                enabled: useTorrentio,
              })
            : [uri].filter(Boolean)
          if (cancelled) return
          // Multi-view add must not destroy the first tile's swarm while we resolve.
          const guard = multiviewGuardRef.current
          const keepOthers =
            guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
          let result: TorrentStreamResult | null = null
          let usedUri = uri
          let lastError = 'Could not start source'
          let deadCount = 0
          // Pass 1 + one automatic retry for cold-engine / DHT flakiness (re-click used to "fix" this).
          for (let pass = 0; pass < 2 && !result?.ok; pass++) {
            if (pass > 0) {
              if (!isTransientSourceError(lastError)) break
              setError('Retrying source…')
              await sleep(700)
              if (cancelled) return
              deadCount = 0
            }
            for (let i = 0; i < candidates.length; i++) {
              const candidate = candidates[i]
              usedUri = candidate
              if (isDebridHttpPlayUrl(candidate)) {
                if (candidates.length > 1) {
                  setError(`Opening ready source (${i + 1}/${candidates.length})…`)
                } else {
                  setError('Opening ready source…')
                }
                result = { ok: true, url: candidate }
                break
              }
              if (candidates.length > 1) {
                setError('Fetching sources…')
              }
              const attempt = await torrentStream(candidate, {
                keepOthers,
                preferJapaneseAudio: shouldPreferRivestreamJapaneseAudio(item!),
              })
              if (cancelled) return
              if (attempt.ok && attempt.url) {
                result = attempt
                break
              }
              lastError = attempt.error || lastError
              if (/no peers|no reachable seeds|swarm may be dead|unavailable/i.test(lastError)) {
                deadCount += 1
                if (i < candidates.length - 1) {
                  setError('Fetching sources…')
                }
                continue
              }
            }
          }
          if (!result?.ok || !result.url) {
            setError(
              deadCount > 0 && deadCount === candidates.length
                ? candidates.length > 1
                  ? 'No working sources for any release of this title. Try another episode or quality.'
                  : 'No working sources for this title. Try another episode or quality.'
                : lastError,
            )
            return
          }
          uri = usedUri

          let playlist = episodePlaylist
          if (playlist && playlist.length > 0) {
            playlist = episodePlaylistFromChoices(
              playlist.map((entry) => ({
                key: entry.episodeKey || '',
                title: entry.title,
                torrentUri: entry.torrentUri || '',
                quality: 0,
                alternates: entry.torrentAlternates,
              })),
              startEpisodeIndex,
              {
                url: result.url!,
                torrentUri: usedUri,
                subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                fileName: result.fileName,
              },
            )
          } else if (result.playlist && result.playlist.length > 1) {
            playlist = result.playlist
          }

          const showName = cleanShowDisplayTitle(item!.title) || item!.title
          const epKey =
            episodeAlternates?.key ||
            parseEpisodeKey(title || '') ||
            parseEpisodeKey(result.fileName || result.name || '')
          const playable: StreamItem = {
            ...item!,
            title: epKey ? `${showName} · ${epKey}` : showName,
            description: result.fileName || title || item!.description,
            url: result.url,
            subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
            subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
            playlist,
            torrentUri: uri,
            transport: 'direct',
            // Keep torrent identity so Continue → resume rebuilds the episode list.
            sourceKind: item!.sourceKind || 'torrent',
            runtimeSeconds: mergeRuntimeSeconds(
              result.runtimeSeconds,
              item!.runtimeSeconds,
            ),
            torrentInfoHash: result.infoHash,
          }
          play(playable, {
            forceFull: true,
            returnTo: returnTo ?? (wantsShowEpisodePlaylist(item!) ? `/show/${item!.id}` : `/section/${item!.category}`),
          })
          return
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Playback failed')
          }
          return
        }
      }

      // Direct series/anime continue without a torrent path — still attach episodes.
      if (wantsShowEpisodePlaylist(item!)) {
        const saved = getContinueEntry(item!.id)
        if (saved && saved.currentTime >= 5) {
          const episodeList = await resolveShowEpisodes(item!, itemsRef.current)
          if (cancelled) return
          if (episodeList.episodes.length > 1) {
            const resumeIndex = resolveContinueEpisodeIndex(episodeList.episodes, saved) ?? 0
            play(
              {
                ...item!,
                playlist: episodePlaylistFromChoices(episodeList.episodes, resumeIndex, {
                  url: item!.url,
                }),
              },
              { forceFull: true, returnTo: returnTo ?? `/show/${item!.id}` },
            )
            return
          }
        }
      }

      // Last resort: never leave a web-embed source on /watch (blank GlobalPlayer).
      if (shouldOpenInWebBrowser(item!)) {
        const webItem = {
          ...item!,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed'])],
        }
        navigate(`/web?url=${encodeURIComponent(item!.url)}`, {
          replace: true,
          state: {
            from: returnTo || `/section/${item!.category}`,
            playerMode: 'embed' as const,
            pipOnBack: true,
          },
        })
        play(webItem, { forceFull: true, replace: true, returnTo: returnTo || undefined })
        return
      }

      play(item!, { forceFull: true, returnTo })
    }

    void start()
    return () => {
      cancelled = true
    }
  }, [
    item?.id,
    item?.url,
    item?.torrentUri,
    item?.detailUrl,
    item?.category,
    play,
    navigate,
    returnTo,
  ])

  useEffect(() => {
    if (slots.length > 1 && mode === 'multi') {
      navigate('/multiview', { replace: true })
    }
  }, [slots.length, mode, navigate])

  if (!raw && !item && !continued) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>Stream not found.</p>
          <Link className="ghost-btn" to="/">
            Back home
          </Link>
        </div>
      </div>
    )
  }

  const display = item ?? raw!

  // GlobalPlayer owns native video. Web embeds must reach /web — blanking this
  // route while still on /watch (after play(), before navigate) is a black screen.
  const onWebRoute = location.pathname.startsWith('/web')
  const webEmbedPending = Boolean(
    playing &&
      playing.id === display.id &&
      mode !== 'off' &&
      isWebEmbedPlaybackItem(playing) &&
      !onWebRoute,
  )
  const streamReady = Boolean(
    playing?.id === display.id && mode !== 'off' && !webEmbedPending,
  )

  return (
    <div
      className="watch-placeholder"
      aria-busy={!error && !streamReady}
      aria-hidden={streamReady}
    >
      {error ? (
        <div className="empty-state">
          <p>{error}</p>
          <Link className="ghost-btn" to={`/section/${display.category}`}>
            Back to {display.category}
          </Link>
        </div>
      ) : streamReady ? null : (
        <PlaybackLoadingScreen
          title={cleanShowDisplayTitle(display.title) || display.title}
          status={webEmbedPending ? 'Opening player…' : 'Fetching sources…'}
          variant="page"
        />
      )}
    </div>
  )
}
