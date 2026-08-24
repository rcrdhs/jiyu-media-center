import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PlaybackLoadingScreen } from '../components/PlaybackLoadingScreen'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { getContinueEntry, mergeRuntimeSeconds } from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import { hasRealDebridToken } from '../lib/debridSettings'
import { upsertTorrentItems } from '../lib/torrentCatalogStore'
import {
  cleanShowDisplayTitle,
  formatEpisodeListLabel,
  isDebridHttpPlayUrl,
  isEztvSource,
  isM2BoxCatalogItem,
  isNetMirrorCatalogItem,
  isShowBrowseItem,
  resolveShowEpisodes,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { resolveM2BoxPlay } from '../lib/m2box'
import { resolveNetMirrorPlay } from '../lib/netmirror'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
import {
  canQueueWatchNext,
  clearWatchNext,
  isWatchNext,
  setWatchNext,
  subscribeWatchNext,
} from '../lib/watchNext'
import type { StreamItem, StreamPlaylistItem, TorrentStreamResult } from '../types'

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const [prepareStatus, setPrepareStatus] = useState<string | null>(null)
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const [queued, setQueued] = useState(() => (id ? isWatchNext(id) : false))

  useEffect(() => {
    if (!id) return
    return subscribeWatchNext((entry) => setQueued(entry?.id === id))
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
    if (!isShowBrowseItem(item)) {
      navigate(`/watch/${item.id}`, { replace: true, state: { from: returnTo } })
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPlayError(null)
    setEpisodes([])
    setSynopsis('')
    void resolveShowEpisodes(item, items).then((result) => {
      if (cancelled) return
      setEpisodes(result.episodes)
      setError(result.episodes.length === 0 ? result.error || 'No episodes found.' : null)
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
      if (Object.keys(patch).length > 0) {
        void upsertTorrentItems([{ ...item, ...patch }])
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [item, items, navigate, returnTo])

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
    setPlayingIndex(index)
    setPlayError(null)
    setPrepareStatus('Getting episode ready…')
    const keepOthers = awaitingAdd || slots.length > 1 || mode === 'multi'
    const isDeadSwarm = (msg: string) =>
      /no peers|no reachable seeds|no seeds found|swarm may be dead|unavailable/i.test(msg)

    try {
      if (isM2BoxCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(chosen.key)
        const season = seMatch ? Number(seMatch[1]) : 1
        const episode = seMatch ? Number(seMatch[2]) : index + 1
        const resolved = await resolveM2BoxPlay(item.detailUrl || item.url, {
          subjectId: item.m2boxSubjectId,
          season,
          episode,
        })
        if (!resolved.ok) {
          setPlayError(resolved.error || 'Could not resolve M2Box stream')
          return
        }
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: resolved.url,
            referrer: resolved.referer,
          })
        }
        const showName = cleanShowDisplayTitle(item.title) || item.title
        const playlist: StreamPlaylistItem[] = episodes.map((ep, i) =>
          i === index
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
        play(
          {
            ...item,
            title: `${showName} · ${chosen.key}`,
            description: chosen.title || item.description,
            url: resolved.url,
            httpReferrer: resolved.referer,
            playlist,
            transport: 'direct',
            tags: [...new Set([...(item.tags ?? []), 'm2box', resolved.format])],
            runtimeSeconds: mergeRuntimeSeconds(resolved.durationSeconds, item.runtimeSeconds),
            m2boxSubjectId: resolved.subjectId || item.m2boxSubjectId,
          },
          { forceFull: true, returnTo: `/show/${item.id}` },
        )
        return
      }

      if (isNetMirrorCatalogItem(item)) {
        const seMatch = /^S(\d{1,2})E(\d{1,3})$/i.exec(chosen.key)
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
          setPlayError(resolved.error || 'Could not resolve NetMirror player')
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
          state: { from: `/show/${item.id}` },
        })
        return
      }

      if (!window.signalDesktop?.torrentStream) {
        setPlayError('Playback needs the Jiyu desktop app.')
        return
      }

      const useTorrentio =
        TORRENTIO_TV_TRIAL && (item.category === 'series' || item.category === 'kids')
      const useDebrid = useTorrentio && hasRealDebridToken()
      if (useDebrid) setPrepareStatus('Checking debrid streams…')
      else if (useTorrentio) setPrepareStatus('Checking more sources…')
      else setPrepareStatus('Getting episode ready…')

      const candidates = await torrentUrisForEpisodeWithTorrentio(chosen, item.title, {
        enabled: useTorrentio,
      })
      let result: TorrentStreamResult | null = null
      let usedUri = chosen.torrentUri
      let lastError = 'Could not start torrent stream'
      let deadCount = 0
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]
        usedUri = candidate
        if (isDebridHttpPlayUrl(candidate)) {
          if (candidates.length > 1) {
            setPrepareStatus(`Starting debrid stream (${i + 1}/${candidates.length})…`)
          } else {
            setPrepareStatus('Starting debrid stream…')
          }
          result = { ok: true, url: candidate }
          break
        }
        if (candidates.length > 1) {
          setPrepareStatus(`Connecting to peers (${i + 1}/${candidates.length})…`)
        }
        const attempt = await window.signalDesktop.torrentStream(candidate, { keepOthers })
        if (attempt.ok && attempt.url) {
          result = attempt
          break
        }
        lastError = attempt.error || lastError
        if (isDeadSwarm(lastError)) {
          deadCount += 1
          if (i < candidates.length - 1) {
            setPrepareStatus(
              `No peers — trying another release (${i + 2}/${candidates.length})…`,
            )
          }
          continue
        }
      }
      if (!result?.ok || !result.url) {
        setPlayError(
          deadCount > 0 && deadCount === candidates.length
            ? candidates.length > 1
              ? 'No peers found for any release of this episode. Try another quality.'
              : 'No peers found for this episode. Try another quality.'
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
        runtimeSeconds: mergeRuntimeSeconds(result.runtimeSeconds, item.runtimeSeconds),
        torrentInfoHash: isDebridHttpPlayUrl(usedUri || '') ? undefined : result.infoHash,
      }
      setPlayError(null)
      play(playable, {
        forceFull: true,
        returnTo: `/show/${item.id}`,
      })
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : 'Playback failed')
    } finally {
      setPlayingIndex(null)
      setPrepareStatus(null)
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
  const displayDescription = synopsis || display.description || ''
  const preparingEpisode =
    playingIndex != null ? episodes[playingIndex] ?? null : null
  const preparingTitle = preparingEpisode
    ? `${cleanShowDisplayTitle(display.title) || display.title} · ${
        preparingEpisode.key || formatEpisodeListLabel(preparingEpisode)
      }`
    : cleanShowDisplayTitle(display.title) || display.title

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
                  : 'TV Series'}
            </p>
            <h1>{cleanShowDisplayTitle(display.title) || display.title}</h1>
            {displayDescription && !/^https?:\/\//i.test(displayDescription.trim()) && (
              <p className="show-page-summary">{displayDescription}</p>
            )}
            {item && canQueueWatchNext(item) && (
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
        </div>
        <div className="show-page-art" aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" />
          ) : (
            <span className="media-card-fallback">{display.title.slice(0, 1)}</span>
          )}
        </div>
      </header>

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
                    disabled={playingIndex != null}
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
    </div>
  )
}
