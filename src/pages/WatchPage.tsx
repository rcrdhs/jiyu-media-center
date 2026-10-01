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
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import { getViewingQuality, resolveRequestedQuality } from '../lib/viewingQuality'
import { isStreamedCatalogItem, resolveStreamedPlay } from '../lib/streamed'
import {
  isLivextvReplayCatalogItem,
  resolveLivextvReplayPlay,
} from '../lib/livextvReplays'
import { isWebBrowserOnlyUrl, isYouTubeUrl } from '../lib/webBrowser'
import { isVimeoLiveEventUrl, resolveVimeoLiveHls } from '../lib/vimeoLive'
import { resolveYouTubeLivePlay } from '../lib/youtubeLive'
import {
  isTorrentPlaybackAvailable,
  torrentStream,
} from '../lib/torrentBridge'
import {
  androidBrowserHide,
  androidBrowserMultiHideAll,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

function clearWebSurfacesForWatch() {
  void window.signalDesktop?.browserMultiHideAll?.({ blank: true })
  void window.signalDesktop?.browserAdDockClose?.()
  void window.signalDesktop?.browserHide?.({ blank: true })
  if (isAndroidInAppBrowser()) {
    void androidBrowserMultiHideAll({ blank: true })
    void androidBrowserHide({ blank: true, pause: true })
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
  const [error, setError] = useState<string | null>(null)
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

  useEffect(() => {
    if (!item) return

    let cancelled = false

    async function start() {
      setError(null)

      // Cinetaro TV catalog pages are a Cloudflare wall — episode play uses ShowPage.
      // Cinetaro *movies* (shelf search fallback) go straight to the cinextream embed.
      if (isCinetaroCatalogItem(item!) && item!.category === 'movies') {
        const tmdbId = String(item!.cinetaroTmdbId || '').trim()
        const playUrl =
          (item!.url && /cinextream\.cc/i.test(item!.url) ? item!.url : '') ||
          (tmdbId ? cinetaroCinextreamMovieEmbedUrl(tmdbId) : '') ||
          item!.url
        if (!playUrl) {
          setError('No Cinetaro stream for this movie.')
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
          isStreamedCatalogItem(item!) ||
          (isYouTubeUrl(item!.url) &&
            (item!.tags?.includes('local') || item!.id?.startsWith('local-')))
        ) {
          // Fall through to resolve below.
        } else if (isWebBrowserOnlyUrl(item!.url)) {
          clearWebSurfacesForWatch()
          const playUrl = item!.url
          const activeUrl =
            playing?.url && isWebBrowserOnlyUrl(playing.url) ? playing.url : playUrl
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
        const playlist: StreamPlaylistItem[] =
          episodes.length > 0
            ? episodes.map((ep, i) =>
                i === resumeIndex
                  ? {
                      title: ep.title,
                      url: resolved.url,
                      episodeKey: ep.key,
                    }
                  : {
                      title: ep.title,
                      url: '',
                      episodeKey: ep.key,
                    },
              )
            : [{ title: epLabel, url: resolved.url, episodeKey: resumeKey }]
        play(
          {
            ...item!,
            title: `${showName} · ${epLabel}`,
            url: resolved.url,
            httpReferrer: resolved.referer,
            playlist,
            transport: 'direct',
            tags: [...new Set([...(item!.tags ?? []), 'm2box', resolved.format])],
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
      if (isStreamedCatalogItem(item!)) {
        const resolved = await resolveStreamedPlay(item!)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Could not load Streamed match')
          return
        }
        const webItem = {
          ...item!,
          url: resolved.url,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'live'])],
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
        play(webItem, {
          forceFull: true,
          replace: !keepOthers,
          returnTo: returnTo || '/section/sports',
        })
        if (keepOthers) {
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
        play(webItem, {
          forceFull: true,
          replace: !keepOthers,
          returnTo: returnTo || '/section/sports',
        })
        if (keepOthers) {
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
        return
      }

      // Local YouTube channels (Nationwide): resolve live video → embed player + PiP.
      if (
        isYouTubeUrl(item!.url) &&
        (item!.tags?.includes('local') || item!.id?.startsWith('local-'))
      ) {
        const resolved = await resolveYouTubeLivePlay(item!.url)
        if (cancelled) return
        if (!resolved.ok) {
          setError(resolved.error || 'Channel is not live right now')
          return
        }
        const playUrl =
          // Prefer the watch page in WebContentsView — /embed needs an HTTP
          // Referer (Error 153) and is meant for iframes, not top-level guests.
          resolved.watchUrl || resolved.embedUrl
        const webItem = {
          ...item!,
          url: playUrl,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed', 'live', 'youtube'])],
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
        play(webItem, {
          forceFull: true,
          replace: !keepOthers,
          returnTo: returnTo || '/',
        })
        if (keepOthers) {
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(playUrl)}`, {
          replace: true,
          state: {
            from: returnTo || '/',
            playerMode: 'embed' as const,
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

      if (isWebBrowserOnlyUrl(item!.url)) {
        const webItem = {
          ...item!,
          tags: [...new Set([...(item!.tags ?? []), 'web-embed'])],
        }
        const guard = multiviewGuardRef.current
        const keepOthers =
          guard.awaitingAdd || guard.slotsLen > 1 || guard.mode === 'multi'
        if (!keepOthers) clearWebSurfacesForWatch()
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
        play(webItem, {
          forceFull: true,
          replace: !keepOthers,
          returnTo: returnTo || undefined,
        })
        if (keepOthers) {
          navigate('/multiview', { replace: true })
          return
        }
        navigate(`/web?url=${encodeURIComponent(item!.url)}`, {
          replace: true,
          state: webState,
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

      // Torrent catalog entries store a detail page / magnet — resolve at play time.
      // Series / anime / show cards: always rebuild the full episode playlist on continue.
      if (isTorrentPlaybackItem(item!)) {
        if (!isTorrentPlaybackAvailable()) {
          setError('Torrent playback needs the Jiyu desktop app or Android torrent engine.')
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
            const outcome = await scrapePage(detail, item!.source || 'torrent')
            if (cancelled) return
            if (outcome.results.length === 0) {
              setError(outcome.error || 'No magnet or torrent link found on that page.')
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
                setError('Could not choose a torrent for this title.')
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
          if (useDebrid) setError('Checking debrid streams…')
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
          let lastError = 'Could not start torrent stream'
          let deadCount = 0
          for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i]
            usedUri = candidate
            if (isDebridHttpPlayUrl(candidate)) {
              if (candidates.length > 1) {
                setError(`Starting debrid stream (${i + 1}/${candidates.length})…`)
              } else {
                setError('Starting debrid stream…')
              }
              result = { ok: true, url: candidate }
              break
            }
            if (candidates.length > 1) {
              setError('Fetching sources…')
            }
            const attempt = await torrentStream(candidate, {
              keepOthers,
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
                setError(
                  'Fetching sources…',
                )
              }
              continue
            }
          }
          if (!result?.ok || !result.url) {
            setError(
              deadCount > 0 && deadCount === candidates.length
                ? candidates.length > 1
                  ? 'No peers found for any release of this title. Try another episode or quality.'
                  : 'No peers found for this title. Try another episode or quality.'
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
            setError(err instanceof Error ? err.message : 'Torrent playback failed')
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

  // GlobalPlayer owns the video (full or PiP). Keep this route blank while that title plays
  // so we never flash the loading overlay over navigation.
  const streamReady = Boolean(playing?.id === display.id && mode !== 'off')

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
          status="Fetching sources…"
          variant="page"
        />
      )}
    </div>
  )
}
