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
  parseEpisodeKey,
  pickBestEpisodeIndex,
  pickBestStream,
  resolveShowEpisodes,
  scrapePage,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import { getViewingQuality } from '../lib/viewingQuality'
import { isYouTubeUrl } from '../lib/webBrowser'
import { isVimeoLiveEventUrl, resolveVimeoLiveHls } from '../lib/vimeoLive'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

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

  return Math.min(Math.max(0, saved.playlistIndex), max)
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
  const playingIdRef = useRef(playing?.id)
  playingIdRef.current = playing?.id

  useEffect(() => {
    if (!item) return
    if (isYouTubeUrl(item.url)) {
      navigate(`/web?url=${encodeURIComponent(item.url)}`, { replace: true })
      return
    }

    let cancelled = false

    async function start() {
      setError(null)

      // Already owning this title (full / PiP / multi) — do not call play() again.
      // Re-entry with forceFull was clearing Multi-view arm and snapping PiP back to full.
      if (playingIdRef.current === item!.id) return

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
      // Anime / TV Series show cards: episode picker (unless resuming).
      if (item!.transport === 'torrent' || item!.sourceKind === 'torrent') {
        if (!window.signalDesktop?.torrentStream) {
          setError('Torrent playback needs the Jiyu desktop app.')
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
          const isShowShelf =
            item!.category === 'series' ||
            item!.category === 'anime' ||
            (item!.category === 'kids' && isShowBrowseItem(item!))

          if (isShowShelf && isShowBrowseItem(item!)) {
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
            const resolved = await resolveShowEpisodes(item!, items)
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
            episodePlaylist = episodes.map((ep) => ({
              title: ep.title,
              url: '',
              torrentUri: ep.torrentUri,
              torrentAlternates: ep.alternates,
              episodeKey: ep.key,
            }))
          } else if (!uri || !isTorrentInput(uri)) {
            const detail = item!.detailUrl || item!.url
            const outcome = await scrapePage(detail, item!.source || 'torrent')
            if (cancelled) return
            if (outcome.results.length === 0) {
              setError(outcome.error || 'No magnet or torrent link found on that page.')
              return
            }
            const requestedQuality = preference === 'auto' ? 720 : preference
            const episodes = buildEpisodeChoices(outcome.results, downlink, requestedQuality)

            if (episodes.length > 1) {
              const saved = getContinueEntry(item!.id)
              startEpisodeIndex =
                resolveContinueEpisodeIndex(episodes, saved) ?? pickBestEpisodeIndex(episodes)
              const chosen = episodes[startEpisodeIndex]
              episodeAlternates = chosen
              uri = chosen.torrentUri
              title = chosen.title || title
              episodePlaylist = episodes.map((ep) => ({
                title: ep.title,
                url: '',
                torrentUri: ep.torrentUri,
                torrentAlternates: ep.alternates,
                episodeKey: ep.key,
              }))
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
              setError(`Connecting to peers (${i + 1}/${candidates.length})…`)
            }
            const attempt = await window.signalDesktop.torrentStream(candidate, {
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
                  `No peers — trying another release (${i + 2}/${candidates.length})…`,
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
            playlist = playlist.map((entry, index) =>
              index === startEpisodeIndex
                ? {
                    ...entry,
                    url: result.url!,
                    torrentUri: usedUri,
                    subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                    subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                    fileName: result.fileName,
                  }
                : entry,
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
            runtimeSeconds: mergeRuntimeSeconds(
              result.runtimeSeconds,
              item!.runtimeSeconds,
            ),
            torrentInfoHash: result.infoHash,
          }
          play(playable, {
            forceFull: true,
            returnTo: returnTo ?? `/section/${item!.category}`,
          })
          return
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Torrent playback failed')
          }
          return
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
    items,
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
          status="Getting episode ready…"
          variant="page"
        />
      )}
    </div>
  )
}
