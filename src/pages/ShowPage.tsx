import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PlaybackLoadingScreen } from '../components/PlaybackLoadingScreen'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { getContinueEntry, mergeRuntimeSeconds, recordWebEmbedContinue } from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import { hasRealDebridToken } from '../lib/debridSettings'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import {
  fetchYtsMovieSynopsis,
  needsRicherMovieSynopsis,
} from '../lib/movieShelfSearch'
import {
  cleanShowDisplayTitle,
  formatEpisodeListLabel,
  isDebridHttpPlayUrl,
  isEztvSource,
  isM2BoxCatalogItem,
  isNetMirrorCatalogItem,
  isYmoviesCatalogItem,
  isCinetaroCatalogItem,
  isTmdbTvCatalogItem,
  isShowBrowseItem,
  resolveShowEpisodes,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { resolveM2BoxPlay } from '../lib/m2box'
import { resolveNetMirrorPlay } from '../lib/netmirror'
import { resolveYmoviesPlay } from '../lib/ymovies'
import { resolveCinetaroPlay } from '../lib/cinetaro'
import {
  lookupRivestreamTmdbId,
  resolveAnimeTmdbTvId,
  rivestreamTmdbIdFromItem,
  shouldPreferRivestreamJapaneseAudio,
} from '../lib/rivestream'
import { resolveMovyPlay } from '../lib/movy'
import {
  BILIBILI_TV_PLAY_REFERER,
  resolveBilibiliPlay,
} from '../lib/bilibiliTv'
import { ensureEpisodeSoftSubtitles } from '../lib/softSubs'
import {
  NYAA_SEARCH_SOURCE_ID,
  nyaaTorrentCandidates,
  resolveNyaaEpisodePlay,
  shouldTryNyaaForItem,
} from '../lib/nyaa'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import {
  canQueueWatchNext,
  clearWatchNext,
  isWatchNext,
  setWatchNext,
  subscribeWatchNext,
} from '../lib/watchNext'
import {
  canSaveToWatchlist,
  isOnWatchlist,
  subscribeWatchlist,
  toggleWatchlist,
} from '../lib/watchlist'
import {
  isTorrentPlaybackAvailable,
  torrentStream,
} from '../lib/torrentBridge'
import { maskUserFacingMessage } from '../lib/sourceMask'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

const TORRENT_CANDIDATE_TIMEOUT_MS = 28_000

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

export function ShowPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { getById, items } = useCatalog()
  const { play, awaitingAdd, slots, mode } = usePlayback()
  const raw = id ? getById(id) : undefined
  const item = useMemo(() => resolvePlayableItem(raw, items), [raw, items])

  const [episodes, setEpisodes] = useState<EpisodeChoice[]>([])
  const [synopsis, setSynopsis] = useState('')
  const [networks, setNetworks] = useState<Array<{ name: string; logoUrl?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playError, setPlayErrorRaw] = useState<string | null>(null)
  const [prepareStatus, setPrepareStatusRaw] = useState<string | null>(null)
  const setPlayError = (value: string | null) =>
    setPlayErrorRaw(value == null ? null : maskUserFacingMessage(value))
  const setPrepareStatus = (value: string | null) =>
    setPrepareStatusRaw(value == null ? null : maskUserFacingMessage(value))
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const playGenRef = useRef(0)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const [queued, setQueued] = useState(() => (id ? isWatchNext(id) : false))
  const [saved, setSaved] = useState(() => (id ? isOnWatchlist(id) : false))

  useEffect(() => {
    if (!id) return
    return subscribeWatchNext((entry) => setQueued(entry?.id === id))
  }, [id])

  useEffect(() => {
    if (!id) return
    return subscribeWatchlist(() => setSaved(isOnWatchlist(id)))
  }, [id])

  const returnTo =
    typeof location.state === 'object' &&
    location.state &&
    'from' in location.state &&
    typeof (location.state as { from?: unknown }).from === 'string'
      ? (location.state as { from: string }).from
      : item
        ? `/section/${item.category}`
        : '/'

  const continueEntry = useMemo(() => (id ? getContinueEntry(id) : null), [id])
  const catalogPoster = item && !isWeakPosterUrl(item.poster) ? item.poster || '' : ''
  const poster = catalogPoster || fallbackPoster || item?.poster || ''

  useEffect(() => {
    if (!item) return
    // Movies open here for synopsis → Watch. Series/anime keep the episode list.
    if (!isShowBrowseItem(item) && item.category !== 'movies') {
      navigate(`/watch/${item.id}`, { replace: true, state: { from: returnTo } })
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setPlayError(null)
    // Keep prior episode rows visible while refreshing — wiping to [] made Android
    // One Piece show "0 episodes" under a mid-play error if TMDB was slow.
    setSynopsis('')
    setNetworks([])

    if (item.category === 'movies' && !isShowBrowseItem(item)) {
      const local = String(item.description || '').trim()
      if (local && !/^https?:\/\//i.test(local)) setSynopsis(local)
      void (async () => {
        if (!needsRicherMovieSynopsis(item.description)) {
          if (!cancelled) setLoading(false)
          return
        }
        const detail = await fetchYtsMovieSynopsis(item.detailUrl || item.url)
        if (cancelled) return
        if (detail?.synopsis) {
          setSynopsis(detail.synopsis)
          const patch: Partial<StreamItem> = { description: detail.synopsis }
          if (detail.runtimeSeconds && detail.runtimeSeconds !== item.runtimeSeconds) {
            patch.runtimeSeconds = detail.runtimeSeconds
          }
          void upsertTorrentItems([{ ...item, ...patch }])
        }
        setLoading(false)
      })()
      return () => {
        cancelled = true
      }
    }

    // Depend on item.id only — catalog array identity changes during sync and
    // was re-fetching episodes (and fighting Back navigation) on every upsert.
    void resolveShowEpisodes(item, items)
      .then((result) => {
        if (cancelled) return
        if (result.episodes.length > 0) {
          setEpisodes(result.episodes)
          setError(null)
        } else {
          // Keep any previously loaded rows (Android TMDB blips mid-watch).
          setError(result.error || 'No episodes found.')
        }
        setNetworks(result.networks || [])
        const patch: Partial<StreamItem> = {}
        if (result.description?.trim() && result.description.trim() !== item.description) {
          setSynopsis(result.description.trim())
          patch.description = result.description.trim()
        } else if (result.description?.trim()) {
          setSynopsis(result.description.trim())
        }
        if (isM2BoxCatalogItem(item) && result.m2boxSubjectId && result.m2boxSubjectId !== item.m2boxSubjectId) {
          patch.m2boxSubjectId = result.m2boxSubjectId
        }
        if (isNetMirrorCatalogItem(item)) {
          if (result.netmirrorPostId && result.netmirrorPostId !== item.netmirrorPostId) {
            patch.netmirrorPostId = result.netmirrorPostId
          }
          if (result.netmirrorTmdbId && result.netmirrorTmdbId !== item.netmirrorTmdbId) {
            patch.netmirrorTmdbId = result.netmirrorTmdbId
          }
        }
        if (isYmoviesCatalogItem(item) && result.ymoviesId && result.ymoviesId !== item.ymoviesId) {
          patch.ymoviesId = result.ymoviesId
        }
        if (isCinetaroCatalogItem(item)) {
          if (result.cinetaroTmdbId && result.cinetaroTmdbId !== item.cinetaroTmdbId) {
            patch.cinetaroTmdbId = result.cinetaroTmdbId
          }
          if (result.rivestreamTmdbId && result.rivestreamTmdbId !== item.rivestreamTmdbId) {
            patch.rivestreamTmdbId = result.rivestreamTmdbId
          }
        }
        if (
          isTmdbTvCatalogItem(item) &&
          result.rivestreamTmdbId &&
          result.rivestreamTmdbId !== item.rivestreamTmdbId
        ) {
          patch.rivestreamTmdbId = result.rivestreamTmdbId
        }
        if (Object.keys(patch).length > 0) {
          void upsertTorrentItems([{ ...item, ...patch }])
        }
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        // Don't wipe a previously loaded list on a flaky refresh.
        setError(err instanceof Error ? err.message : 'Could not load episodes.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when the show id changes
  }, [item?.id, navigate, returnTo])

  useEffect(() => {
    if (!item || catalogPoster) {
      setFallbackPoster('')
      return
    }
    let cancelled = false
    void resolveCatalogPoster(item.title, item.category).then((url) => {
      if (!cancelled) setFallbackPoster(url)
    })
    return () => {
      cancelled = true
    }
  }, [item?.id, item?.title, item?.category, catalogPoster])

  async function playEpisode(index: number) {
    if (!item) {
      setPlayError('Title not found.')
      return
    }
    const chosen = episodes[index]
    if (!chosen) return
    const playGen = ++playGenRef.current
    setPlayingIndex(index)
    setPlayError(null)
    setPrepareStatus('Getting episode ready…')
    const keepOthers = awaitingAdd || slots.length > 1 || mode === 'multi'
    const stillCurrent = () => playGenRef.current === playGen
    const isDeadSwarm = (msg: string) =>
      /no peers|no reachable seeds|no seeds found|swarm may be dead|unavailable/i.test(msg)

    const tryPlayFromNyaa = async (season: number, episode: number): Promise<boolean> => {
      if (!isTorrentPlaybackAvailable()) return false
      setPrepareStatus('Searching for episode…')
      const showName = cleanShowDisplayTitle(item.title) || item.title
      const nyaa = await resolveNyaaEpisodePlay({
        showTitle: showName,
        season,
        episode,
      })
      if (!nyaa.ok) return false
      const candidates = nyaaTorrentCandidates(nyaa.choice)
      if (candidates.length === 0) return false
      setPrepareStatus('Opening source…')
      let result: TorrentStreamResult | null = null
      let usedUri = candidates[0]
      let lastError = 'Could not start source'
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]
        usedUri = candidate
        setPrepareStatus(
          candidates.length > 1
            ? `Opening source… (${i + 1}/${candidates.length})`
            : 'Opening source…',
        )
        try {
          const attempt = await withTimeout(
            torrentStream(candidate, {
              keepOthers,
              preferJapaneseAudio: shouldPreferRivestreamJapaneseAudio(item),
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
        if (!isDeadSwarm(lastError) && i === candidates.length - 1) break
      }
      if (!result?.ok || !result.url) {
        // Weak Nyaa swarm — fall through so caller can try another path.
        return false
      }
      if (!stillCurrent()) return false
      const playlist: StreamPlaylistItem[] = nyaa.episodes.map((ep, i) =>
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
      )
      play(
        {
          ...item,
          title: `${showName} · ${nyaa.choice.key}`,
          description: nyaa.choice.title || item.description,
          url: result.url,
          playlist,
          torrentUri: usedUri,
          transport: 'direct',
          sourceKind: 'torrent',
          source: 'Torrent',
          tags: [...new Set([...(item.tags ?? []), 'nyaa', 'torrent', 'anime'])],
          torrentInfoHash: result.infoHash,
          subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
          subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
        },
        { forceFull: true, returnTo: `/show/${item.id}` },
      )
      return true
    }

    /** TMDB → Movy Direct HLS in native Player; caller falls back to Nyaa. */
    const tryPlayMovyNative = async (
      season: number,
      episode: number,
      knownTmdbId?: string,
    ): Promise<boolean> => {
      setPrepareStatus('Opening stream…')
      // Prefer the id ShowPage already resolved — re-running resolveAnimeTmdbTvId
      // only re-fetches genres and can flicker status back to "Looking up show…".
      let tmdbId = String(knownTmdbId || rivestreamTmdbIdFromItem(item) || '').trim()
      if (item.category === 'anime') {
        if (!tmdbId) {
          tmdbId = (await resolveAnimeTmdbTvId(item.title, tmdbId)) || ''
        }
      } else if (!tmdbId) {
        tmdbId = (await lookupRivestreamTmdbId(item.title)) || ''
      }
      if (!tmdbId) return false
      void upsertTorrentItems([{ ...item, rivestreamTmdbId: tmdbId }])
      const showName = cleanShowDisplayTitle(item.title) || item.title
      const yearMatch = /\b(19|20)\d{2}\b/.exec(String(item.description || item.title || ''))
      let movy: Awaited<ReturnType<typeof resolveMovyPlay>>
      try {
        movy = await withTimeout(
          resolveMovyPlay({
            tmdbId,
            title: showName,
            mediaType: 'tv',
            season,
            episode,
            year: yearMatch?.[0],
          }),
          // Anime long-runners (One Piece) need more probe time on Android.
          item.category === 'anime' ? 35_000 : 20_000,
          'Source lookup timed out.',
        )
      } catch {
        return false
      }
      if (!movy.ok) return false
      if (movy.backend === 'atlantic') setPrepareStatus('Opening alternate stream…')
      let subtitleUrl = movy.subtitleUrl
      let subtitleKind = movy.subtitleKind
      if (!subtitleUrl) {
        setPrepareStatus('Finding subtitles…')
        try {
          const soft = await withTimeout(
            ensureEpisodeSoftSubtitles({
              title: showName,
              item: { ...item, rivestreamTmdbId: tmdbId },
              tmdbId,
              season,
              episode,
              force: true,
            }),
            14_000,
            'Subtitle lookup timed out.',
          )
          if (soft.subtitleUrl) {
            subtitleUrl = soft.subtitleUrl
            subtitleKind = soft.subtitleKind
          }
          if (soft.originalLanguage && soft.originalLanguage !== item.originalLanguage) {
            void upsertTorrentItems([
              { ...item, rivestreamTmdbId: tmdbId, originalLanguage: soft.originalLanguage },
            ])
          }
        } catch {
          /* play without captions — Player may still try Nyaa / OpenSubtitles */
        }
      }
      if (!stillCurrent()) return false
      if (window.signalDesktop?.setPlaybackHeaders) {
        void window.signalDesktop.setPlaybackHeaders({
          url: movy.url,
          referrer: movy.referer,
        })
      }
      const playlist: StreamPlaylistItem[] = episodes.map((ep, i) =>
        i === index
          ? {
              title: ep.title,
              url: movy.url,
              episodeKey: ep.key,
              subtitleUrl,
              subtitleKind,
            }
          : { title: ep.title, url: '', episodeKey: ep.key },
      )
      play(
        {
          ...item,
          rivestreamTmdbId: tmdbId,
          title: `${showName} · ${chosen.key}`,
          description: chosen.title || item.description,
          url: movy.url,
          httpReferrer: movy.referer,
          playlist,
          subtitleUrl,
          subtitleKind,
          transport: 'direct',
          tags: [
            ...new Set([
              ...(item.tags ?? []),
              movy.backend === 'atlantic' ? 'atlantic' : 'movy',
              'hls',
              movy.provider,
              ...(subtitleUrl ? ['softsub'] : []),
            ]),
          ],
        },
        { forceFull: true, returnTo: `/show/${item.id}` },
      )
      return true
    }

    const tryPlayBilibiliNative = async (
      season: number,
      episode: number,
    ): Promise<boolean> => {
      setPrepareStatus('Checking Bilibili…')
      const showName = cleanShowDisplayTitle(item.title) || item.title
      let bili: Awaited<ReturnType<typeof resolveBilibiliPlay>>
      try {
        bili = await withTimeout(
          resolveBilibiliPlay({
            title: showName,
            season,
            episode,
            episodeCountHint: episodes.length || undefined,
            seasonId: item.bilibiliSeasonId,
          }),
          22_000,
          'Bilibili lookup timed out.',
        )
      } catch {
        return false
      }
      if (!bili.ok) return false
      if (!stillCurrent()) return false
      if (bili.seasonId && bili.seasonId !== item.bilibiliSeasonId) {
        void upsertTorrentItems([{ ...item, bilibiliSeasonId: bili.seasonId }])
      }
      // Official play page — Premium / DASH / empty playurl (plan v1).
      if (bili.mode === 'embed' || bili.mode === 'dash') {
        setPrepareStatus(bili.premium ? 'Opening Bilibili (Premium)…' : 'Opening Bilibili…')
        navigate(`/web?url=${encodeURIComponent(bili.url)}`, {
          state: {
            from: `/show/${item.id}`,
            playerMode: 'embed',
            pipOnBack: true,
            continueWatch: {
              id: item.id,
              title: showName,
              poster: item.poster,
              category: item.category,
              playlistIndex: index,
              episodeTitle: chosen.key,
              detailUrl: item.detailUrl || item.url,
              playUrl: bili.url,
              transport: item.transport,
              sourceKind: item.sourceKind,
              source: item.source,
            },
          },
        })
        recordWebEmbedContinue({
          id: item.id,
          title: showName,
          poster: item.poster,
          category: item.category,
          playlistIndex: index,
          episodeTitle: chosen.key,
          detailUrl: item.detailUrl || item.url,
          playUrl: bili.url,
          transport: item.transport,
          sourceKind: item.sourceKind,
          source: item.source,
        })
        return true
      }
      if (window.signalDesktop?.setPlaybackHeaders) {
        void window.signalDesktop.setPlaybackHeaders({
          url: bili.url,
          referrer: bili.referer || BILIBILI_TV_PLAY_REFERER,
        })
      }
      const playlist: StreamPlaylistItem[] = episodes.map((ep, i) =>
        i === index
          ? {
              title: ep.title,
              url: bili.url,
              episodeKey: ep.key,
            }
          : { title: ep.title, url: '', episodeKey: ep.key },
      )
      play(
        {
          ...item,
          bilibiliSeasonId: bili.seasonId,
          title: `${showName} · ${chosen.key}`,
          description: chosen.title || item.description,
          url: bili.url,
          httpReferrer: bili.referer || BILIBILI_TV_PLAY_REFERER,
          playlist,
          transport: 'direct',
          tags: [...new Set([...(item.tags ?? []), 'bilibili', 'hls', bili.provider])],
        },
        { forceFull: true, returnTo: `/show/${item.id}` },
      )
      return true
    }

    try {
      if (isM2BoxCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        const resolved = await resolveM2BoxPlay(item.detailUrl || item.url, {
          subjectId: item.m2boxSubjectId,
          season,
          episode,
        })
        if (!resolved.ok) {
          setPlayError(resolved.error || 'Could not resolve stream')
          return
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: resolved.url,
            referrer: resolved.referer,
          })
        }
        const showName = cleanShowDisplayTitle(item.title) || item.title
        setPrepareStatus('Finding subtitles…')
        let subtitleUrl: string | undefined
        let subtitleKind: 'file' | undefined
        let tmdbId = rivestreamTmdbIdFromItem(item)
        let originalLanguage = item.originalLanguage
        try {
          const soft = await withTimeout(
            ensureEpisodeSoftSubtitles({
              title: showName,
              item,
              season,
              episode,
              force: true,
            }),
            14_000,
            'Subtitle lookup timed out.',
          )
          tmdbId = soft.tmdbId || tmdbId
          originalLanguage = soft.originalLanguage || originalLanguage
          subtitleUrl = soft.subtitleUrl
          subtitleKind = soft.subtitleKind
        } catch {
          /* Player may still try softsubs once playback starts */
        }
        const catalogPatch = {
          ...(tmdbId && tmdbId !== item.rivestreamTmdbId ? { rivestreamTmdbId: tmdbId } : {}),
          ...(originalLanguage && originalLanguage !== item.originalLanguage
            ? { originalLanguage }
            : {}),
        }
        if (Object.keys(catalogPatch).length > 0) {
          void upsertTorrentItems([{ ...item, ...catalogPatch }])
        }
        const playlist: StreamPlaylistItem[] = episodes.map((ep, i) =>
          i === index
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
        play(
          {
            ...item,
            ...catalogPatch,
            title: `${showName} · ${chosen.key}`,
            description: chosen.title || item.description,
            url: resolved.url,
            httpReferrer: resolved.referer,
            playlist,
            subtitleUrl,
            subtitleKind,
            transport: 'direct',
            tags: [
              ...new Set([
                ...(item.tags ?? []),
                'm2box',
                resolved.format,
                ...(subtitleUrl ? ['softsub'] : []),
              ]),
            ],
            runtimeSeconds: mergeRuntimeSeconds(resolved.durationSeconds, item.runtimeSeconds),
            m2boxSubjectId: resolved.subjectId || item.m2boxSubjectId,
          },
          { forceFull: true, returnTo: `/show/${item.id}` },
        )
        return
      }

      if (
        isTmdbTvCatalogItem(item) ||
        isNetMirrorCatalogItem(item) ||
        isYmoviesCatalogItem(item)
      ) {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        let tmdbId = rivestreamTmdbIdFromItem(item)
        if (item.category === 'anime') {
          setPrepareStatus('Looking up show…')
          tmdbId = (await resolveAnimeTmdbTvId(item.title, tmdbId)) || ''
          if (tmdbId) {
            void upsertTorrentItems([{ ...item, rivestreamTmdbId: tmdbId }])
          }
        } else if (!tmdbId && isYmoviesCatalogItem(item)) {
          setPrepareStatus('Looking up show…')
          tmdbId = (await lookupRivestreamTmdbId(item.title)) || ''
          if (tmdbId) {
            void upsertTorrentItems([{ ...item, rivestreamTmdbId: tmdbId }])
          }
        }
        if (tmdbId) {
          const tmdbPatch = {
            rivestreamTmdbId: tmdbId,
            ...(item.netmirrorTmdbId || isTmdbTvCatalogItem(item)
              ? {}
              : { netmirrorTmdbId: tmdbId }),
          }
          if (!item.rivestreamTmdbId) {
            void upsertTorrentItems([{ ...item, ...tmdbPatch }])
          }
          const movyOk = await tryPlayMovyNative(season, episode, tmdbId)
          if (movyOk) return
          const biliOk = await tryPlayBilibiliNative(season, episode)
          if (biliOk) return
          if (shouldTryNyaaForItem(item)) {
            const played = await tryPlayFromNyaa(season, episode)
            if (played) return
          }
          // TMDB series/anime/kids: Movy + Bilibili + Nyaa (no Zenox embed).
          if (isTmdbTvCatalogItem(item)) {
            setPlayError(`Could not find a stream for ${chosen.key || 'this episode'}.`)
            return
          }
        } else if (shouldTryNyaaForItem(item)) {
          const played = await tryPlayFromNyaa(season, episode)
          if (played) return
        }
        if (isTmdbTvCatalogItem(item)) {
          setPlayError(`Could not find a stream for ${chosen.key || 'this episode'}.`)
          return
        }
      }

      if (isNetMirrorCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        setPrepareStatus('Opening episode…')
        const resolved = await resolveNetMirrorPlay(item.detailUrl || item.url, {
          postId: item.netmirrorPostId,
          tmdbId: item.netmirrorTmdbId,
          season,
          episode,
        })
        if (!resolved.ok) {
          setPlayError(resolved.error || 'Could not open this source')
          return
        }
        if (resolved.postId && resolved.postId !== item.netmirrorPostId) {
          void upsertTorrentItems([
            {
              ...item,
              netmirrorPostId: resolved.postId,
              netmirrorTmdbId: resolved.tmdbId || item.netmirrorTmdbId,
            },
          ])
        }
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          state: {
            from: `/show/${item.id}`,
            playerMode: 'embed',
            pipOnBack: item.category === 'series',
            continueWatch: {
              id: item.id,
              title: cleanShowDisplayTitle(item.title) || item.title,
              poster: item.poster,
              category: item.category,
              playlistIndex: index,
              episodeTitle: chosen.key,
              detailUrl: item.detailUrl || item.url,
              playUrl: resolved.url,
              transport: item.transport,
              sourceKind: item.sourceKind,
              source: item.source,
            },
          },
        })
        recordWebEmbedContinue({
          id: item.id,
          title: cleanShowDisplayTitle(item.title) || item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex: index,
          episodeTitle: chosen.key,
          detailUrl: item.detailUrl || item.url,
          playUrl: resolved.url,
          transport: item.transport,
          sourceKind: item.sourceKind,
          source: item.source,
        })
        return
      }

      if (isYmoviesCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        setPrepareStatus('Opening player…')
        const resolved = await resolveYmoviesPlay(item.detailUrl || item.url, {
          ymoviesId: item.ymoviesId,
          season,
          episode,
        })
        if (!resolved.ok) {
          setPlayError(resolved.error || 'Could not open this source')
          return
        }
        if (resolved.ymoviesId && resolved.ymoviesId !== item.ymoviesId) {
          void upsertTorrentItems([
            {
              ...item,
              ymoviesId: resolved.ymoviesId,
            },
          ])
        }
        // Embed player — no M2Box-style direct HLS; maximize in-app chrome like native.
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          state: {
            from: `/show/${item.id}`,
            playerMode: 'embed',
            pipOnBack: item.category === 'series',
            continueWatch: {
              id: item.id,
              title: cleanShowDisplayTitle(item.title) || item.title,
              poster: item.poster,
              category: item.category,
              playlistIndex: index,
              episodeTitle: chosen.key,
              detailUrl: item.detailUrl || item.url,
              playUrl: resolved.url,
              transport: item.transport,
              sourceKind: item.sourceKind,
              source: item.source,
            },
          },
        })
        recordWebEmbedContinue({
          id: item.id,
          title: cleanShowDisplayTitle(item.title) || item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex: index,
          episodeTitle: chosen.key,
          detailUrl: item.detailUrl || item.url,
          playUrl: resolved.url,
          transport: item.transport,
          sourceKind: item.sourceKind,
          source: item.source,
        })
        return
      }

      if (isCinetaroCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        let tmdbId = String(item.cinetaroTmdbId || item.rivestreamTmdbId || '').trim()
        if (item.category === 'anime') {
          setPrepareStatus('Looking up show…')
          tmdbId = (await resolveAnimeTmdbTvId(item.title, tmdbId)) || ''
        } else if (!tmdbId) {
          setPrepareStatus('Looking up show…')
          tmdbId = (await lookupRivestreamTmdbId(item.title)) || ''
        }
        if (tmdbId) {
          if (!item.rivestreamTmdbId || !item.cinetaroTmdbId) {
            void upsertTorrentItems([
              {
                ...item,
                cinetaroTmdbId: item.cinetaroTmdbId || tmdbId,
                rivestreamTmdbId: item.rivestreamTmdbId || tmdbId,
              },
            ])
          }
          const movyOk = await tryPlayMovyNative(season, episode, tmdbId)
          if (movyOk) return
          const biliOk = await tryPlayBilibiliNative(season, episode)
          if (biliOk) return
        }
        setPrepareStatus('Opening player…')
        const resolved = await resolveCinetaroPlay(item.detailUrl || item.url, {
          tmdbId: tmdbId || item.cinetaroTmdbId || item.rivestreamTmdbId,
          season,
          episode,
        })
        if (!resolved.ok) {
          setPlayError(resolved.error || 'Could not open this source')
          return
        }
        if (resolved.tmdbId && resolved.tmdbId !== item.cinetaroTmdbId) {
          void upsertTorrentItems([
            {
              ...item,
              cinetaroTmdbId: resolved.tmdbId,
              rivestreamTmdbId: item.rivestreamTmdbId || resolved.tmdbId,
            },
          ])
        }
        navigate(`/web?url=${encodeURIComponent(resolved.url)}`, {
          state: {
            from: `/show/${item.id}`,
            playerMode: 'embed',
            pipOnBack: item.category === 'series',
            continueWatch: {
              id: item.id,
              title: cleanShowDisplayTitle(item.title) || item.title,
              poster: item.poster,
              category: item.category,
              playlistIndex: index,
              episodeTitle: chosen.key,
              detailUrl: item.detailUrl || item.url,
              playUrl: resolved.url,
              transport: item.transport,
              sourceKind: item.sourceKind,
              source: item.source,
              rivestreamTmdbId: resolved.tmdbId || tmdbId || undefined,
              season,
              episode,
              playlistLength: episodes.length,
            },
          },
        })
        recordWebEmbedContinue({
          id: item.id,
          title: cleanShowDisplayTitle(item.title) || item.title,
          poster: item.poster,
          category: item.category,
          playlistIndex: index,
          episodeTitle: chosen.key,
          detailUrl: item.detailUrl || item.url,
          playUrl: resolved.url,
          transport: item.transport,
          sourceKind: item.sourceKind,
          source: item.source,
        })
        return
      }

      if (!isTorrentPlaybackAvailable()) {
        setPlayError('Playback needs the Jiyu desktop app or Android source engine.')
        return
      }

      {
        const seMatch = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        // Anime / Nyaa-eligible: Movy Direct before magnets.
        if (
          shouldTryNyaaForItem(item) ||
          item.torrentSourceId === NYAA_SEARCH_SOURCE_ID ||
          /^nyaa$/i.test(String(item.source || '')) ||
          item.tags?.some((t) => /^nyaa$/i.test(String(t)))
        ) {
          const movyOk = await tryPlayMovyNative(season, episode)
          if (movyOk) return
          const biliOk = await tryPlayBilibiliNative(season, episode)
          if (biliOk) return
          const played = await tryPlayFromNyaa(season, episode)
          if (played) return
        }
      }

      const useTorrentio =
        TORRENTIO_TV_TRIAL && (item.category === 'series' || item.category === 'kids')
      const useDebrid = useTorrentio && hasRealDebridToken()
      if (useDebrid) setPrepareStatus('Checking ready sources…')
      else if (useTorrentio) setPrepareStatus('Checking more sources…')
      else setPrepareStatus('Getting episode ready…')

      const candidates = await torrentUrisForEpisodeWithTorrentio(chosen, item.title, {
        enabled: useTorrentio,
      })
      let result: TorrentStreamResult | null = null
      let usedUri = chosen.torrentUri
      let lastError = 'Could not start source'
      let deadCount = 0
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]
        usedUri = candidate
        if (isDebridHttpPlayUrl(candidate)) {
          if (candidates.length > 1) {
            setPrepareStatus(`Opening ready source (${i + 1}/${candidates.length})…`)
          } else {
            setPrepareStatus('Opening ready source…')
          }
          result = { ok: true, url: candidate }
          break
        }
        if (candidates.length > 1) {
          setPrepareStatus(`Opening source… (${i + 1}/${candidates.length})`)
        } else {
          setPrepareStatus('Opening source…')
        }
        try {
          const attempt = await withTimeout(
            torrentStream(candidate, {
              keepOthers,
              preferJapaneseAudio: shouldPreferRivestreamJapaneseAudio(item),
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
        if (isDeadSwarm(lastError)) {
          deadCount += 1
          continue
        }
      }
      if (!result?.ok || !result.url) {
        const seMatchFail = /^S(\d{1,2})E(\d{1,4})$/i.exec(chosen.key)
        const seasonFail = seMatchFail ? Number(seMatchFail[1]) : 1
        const episodeFail = seMatchFail ? Number(seMatchFail[2]) : index + 1
        if (
          item.category === 'anime' ||
          shouldTryNyaaForItem(item) ||
          item.tags?.some((t) => /anime|nyaa/i.test(String(t)))
        ) {
          const movyOk = await tryPlayMovyNative(seasonFail, episodeFail)
          if (movyOk) return
          const biliOk = await tryPlayBilibiliNative(seasonFail, episodeFail)
          if (biliOk) return
        }
        setPlayError(
          deadCount > 0 && deadCount === candidates.length
            ? candidates.length > 1
              ? 'No working sources for any release of this episode. Try another quality.'
              : 'No working sources for this episode. Try another quality.'
            : lastError,
        )
        return
      }

      const playlist: StreamPlaylistItem[] = episodes.map((ep, i) =>
        i === index
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
      )

      const showName = cleanShowDisplayTitle(item.title) || item.title
      const playable: StreamItem = {
        ...item,
        title: chosen.key ? `${showName} · ${chosen.key}` : showName,
        description: result.fileName || chosen.title || item.description,
        url: result.url,
        subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
        subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
        playlist,
        torrentUri: usedUri,
        transport: 'direct',
        sourceKind: item.sourceKind || 'torrent',
        runtimeSeconds: mergeRuntimeSeconds(result.runtimeSeconds, item.runtimeSeconds),
        torrentInfoHash: isDebridHttpPlayUrl(usedUri || '') ? undefined : result.infoHash,
      }
      if (!stillCurrent()) return
      setPlayError(null)
      play(playable, {
        forceFull: true,
        returnTo: `/show/${item.id}`,
      })
    } catch (err) {
      if (!stillCurrent()) return
      setPlayError(err instanceof Error ? err.message : 'Playback failed')
    } finally {
      if (stillCurrent()) {
        setPlayingIndex(null)
        setPrepareStatus(null)
      }
    }
  }

  if (!raw && !item) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>Title not found.</p>
          <Link className="ghost-btn" to="/">
            Back home
          </Link>
        </div>
      </div>
    )
  }

  const display = item ?? raw!
  const isMovieDetail =
    display.category === 'movies' && !isShowBrowseItem(display)
  const displayDescription = synopsis || display.description || ''
  const preparingEpisode =
    playingIndex != null ? episodes[playingIndex] ?? null : null
  const preparingTitle = preparingEpisode
    ? `${cleanShowDisplayTitle(display.title) || display.title} · ${
        preparingEpisode.key || formatEpisodeListLabel(preparingEpisode)
      }`
    : cleanShowDisplayTitle(display.title) || display.title

  function startMovieWatch() {
    if (!item) return
    navigate(`/watch/${item.id}`, {
      state: { from: returnTo, autoPlay: true },
    })
  }

  return (
    <div className="page show-page">
      {playingIndex != null && (
        <PlaybackLoadingScreen
          title={preparingTitle}
          status={prepareStatus || 'Getting episode ready…'}
          variant="page"
        />
      )}
      <header className="page-header show-page-header">
        <div className="show-page-heading">
          <Link className="ghost-btn" to={returnTo}>
            ← Back
          </Link>
          <div className="show-page-title-block">
            <p className="eyebrow">
              {display.category === 'anime'
                ? 'Anime'
                : display.category === 'kids'
                  ? 'Kids'
                  : display.category === 'movies'
                    ? 'Movie'
                    : 'TV Series'}
            </p>
            {networks.length > 0 && (
              <div className="show-page-networks" aria-label="Networks">
                {networks.slice(0, 3).map((net) => (
                  <span key={net.name} className="show-page-network" title={net.name}>
                    {net.logoUrl ? (
                      <img src={net.logoUrl} alt="" loading="lazy" />
                    ) : null}
                    <span>{net.name}</span>
                  </span>
                ))}
              </div>
            )}
            <h1>{cleanShowDisplayTitle(display.title) || display.title}</h1>
            {loading && isMovieDetail ? (
              <p className="show-page-summary">Loading synopsis…</p>
            ) : displayDescription && !/^https?:\/\//i.test(displayDescription.trim()) ? (
              <p className="show-page-summary">{displayDescription}</p>
            ) : isMovieDetail ? (
              <p className="show-page-summary">No synopsis available for this title.</p>
            ) : null}
            {isMovieDetail && (
              <div className="show-movie-actions">
                <button type="button" className="primary-btn" onClick={startMovieWatch}>
                  {continueEntry && continueEntry.currentTime >= 5 ? 'Continue watching' : 'Watch'}
                </button>
              </div>
            )}
            {item && (canSaveToWatchlist(item) || canQueueWatchNext(item)) && (
              <div className="show-page-quick-actions">
                {canSaveToWatchlist(item) && (
                  <button
                    type="button"
                    className={`ghost-btn show-save-btn${saved ? ' is-saved' : ''}`}
                    onClick={() => setSaved(toggleWatchlist(item))}
                    title={saved ? 'Remove from Saved' : 'Save for later'}
                    aria-pressed={saved}
                  >
                    {saved ? '♥ Saved' : '♡ Save'}
                  </button>
                )}
                {canQueueWatchNext(item) && (
                  <button
                    type="button"
                    className={`ghost-btn show-play-next-btn${queued ? ' is-queued' : ''}`}
                    onClick={() => {
                      if (queued) clearWatchNext()
                      else setWatchNext(item)
                    }}
                    title={
                      queued
                        ? 'Clear up next'
                        : 'Play this show after the current title finishes'
                    }
                  >
                    {queued ? 'Queued as up next' : 'Play next'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="show-page-art" aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" />
          ) : (
            <span className="media-card-fallback">{display.title.slice(0, 1)}</span>
          )}
        </div>
      </header>

      {isMovieDetail ? null : (
      <section className="section-block show-episode-section">
        <div className="section-head">
          <h2>Episodes</h2>
          <p>
            {loading
              ? 'Loading episode list…'
              : `${episodes.length.toLocaleString()} episode${episodes.length === 1 ? '' : 's'}`}
            {!loading &&
            episodes.length > 0 &&
            isEztvSource(display.detailUrl || display.url || '', display.source) &&
            episodes.every((ep) => (ep.seeders ?? 0) > 0)
              ? ' · ready'
              : ''}
            {continueEntry?.episodeTitle
              ? ` · Continue ${continueEntry.episodeTitle}`
              : continueEntry
                ? ' · Continue watching'
                : ''}
          </p>
        </div>

        {error && (
          <div className="empty-state">
            <p>{error}</p>
          </div>
        )}

        {playError && (
          <div className="empty-state" style={{ marginBottom: '0.75rem' }}>
            <p>{playError}</p>
          </div>
        )}

        {!loading && !error && episodes.length > 0 && (
          <ol className="show-episode-list">
            {episodes.map((ep, index) => {
              const isContinue = continueEntry?.playlistIndex === index
              const busy = playingIndex === index
              return (
                <li key={ep.key || `${ep.title}-${index}`}>
                  <button
                    type="button"
                    className={`show-episode-row${isContinue ? ' is-continue' : ''}`}
                    disabled={playingIndex === index}
                    onClick={() => void playEpisode(index)}
                  >
                    <span className="show-episode-key">{ep.key}</span>
                    <span className="show-episode-name" title={ep.title}>
                      {isM2BoxCatalogItem(display)
                        ? ep.title
                        : formatEpisodeListLabel(ep)}
                    </span>
                    <span className="show-episode-meta">
                      {[
                        typeof ep.seeders === 'number' && ep.seeders > 0
                          ? `ready (${ep.seeders})`
                          : '',
                        isContinue ? 'Resume' : '',
                        busy ? 'Connecting…' : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      )}
    </div>
  )
}
