import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import {
  getContinueEntry,
  mergeRuntimeSeconds,
  streamItemFromContinueEntry,
  type ContinueWatchingEntry,
} from '../lib/continueWatching'
import {
  getConnectionDownlinkMbps,
  isTorrentInput,
  buildEpisodeChoices,
  isShowBrowseItem,
  parseEpisodeKey,
  pickBestEpisodeIndex,
  pickBestStream,
  resolveShowEpisodes,
  scrapePage,
  torrentUrisForEpisode,
  type EpisodeChoice,
} from '../lib/torrents'
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

  useEffect(() => {
    if (!item) return
    if (isYouTubeUrl(item.url)) {
      navigate(`/web?url=${encodeURIComponent(item.url)}`, { replace: true })
      return
    }

    let cancelled = false

    async function start() {
      setError(null)

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
            item!.category === 'series' || item!.category === 'anime'

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

          const candidates = episodeAlternates
            ? torrentUrisForEpisode(episodeAlternates)
            : [uri].filter(Boolean)
          // Multi-view add must not destroy the first tile's swarm while we resolve.
          const keepOthers = awaitingAdd || slots.length > 1 || mode === 'multi'
          let result: TorrentStreamResult | null = null
          let usedUri = uri
          let lastError = 'Could not start torrent stream'
          for (const candidate of candidates) {
            usedUri = candidate
            const attempt = await window.signalDesktop.torrentStream(candidate, {
              keepOthers,
            })
            if (cancelled) return
            if (attempt.ok && attempt.url) {
              result = attempt
              break
            }
            lastError = attempt.error || lastError
          }
          if (!result?.ok || !result.url) {
            setError(lastError)
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

          const playable: StreamItem = {
            ...item!,
            title: title || result.name || result.fileName || item!.title,
            description: result.fileName ?? item!.description,
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
    awaitingAdd,
    slots.length,
    mode,
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
        <>
          <img
            className="watch-loading-logo"
            src="./jiyu-logo.png"
            alt={`Loading ${display.title}`}
            width={224}
            height={224}
          />
          <div className="watch-loading-line" role="progressbar" aria-label={`Loading ${display.title}`}>
            <span />
          </div>
        </>
      )}
    </div>
  )
}
