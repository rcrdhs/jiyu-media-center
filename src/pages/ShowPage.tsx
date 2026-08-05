import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PlaybackLoadingScreen } from '../components/PlaybackLoadingScreen'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { getContinueEntry, mergeRuntimeSeconds } from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import { hasRealDebridToken } from '../lib/debridSettings'
import {
  cleanShowDisplayTitle,
  formatEpisodeListLabel,
  isDebridHttpPlayUrl,
  isEztvSource,
  isShowBrowseItem,
  resolveShowEpisodes,
  torrentUrisForEpisodeWithTorrentio,
  type EpisodeChoice,
} from '../lib/torrents'
import { TORRENTIO_TV_TRIAL } from '../lib/torrentio'
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const [prepareStatus, setPrepareStatus] = useState<string | null>(null)
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [fallbackPoster, setFallbackPoster] = useState('')

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
    void resolveShowEpisodes(item, items).then((result) => {
      if (cancelled) return
      setEpisodes(result.episodes)
      setError(result.episodes.length === 0 ? result.error || 'No episodes found.' : null)
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
    if (!item || !window.signalDesktop?.torrentStream) {
      setPlayError('Playback needs the Jiyu desktop app.')
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
      const useTorrentio =
        TORRENTIO_TV_TRIAL && (item.category === 'series' || item.category === 'kids')
      const useDebrid = useTorrentio && hasRealDebridToken()
      if (useDebrid) setPrepareStatus('Checking debrid streams…')
      else if (useTorrentio) setPrepareStatus('Checking more sources…')
      const candidates = await torrentUrisForEpisodeWithTorrentio(chosen, item.title, {
        enabled: useTorrentio,
      })
      let result: TorrentStreamResult | null = null
      let usedUri = chosen.torrentUri
      let lastError = 'Could not start torrent stream'
      let deadCount = 0
      for (let i = 0; i < candidates.length; i++) {
        const uri = candidates[i]
        usedUri = uri
        if (isDebridHttpPlayUrl(uri)) {
          setPrepareStatus(
            candidates.length > 1
              ? `Starting debrid stream (${i + 1}/${candidates.length})…`
              : 'Starting debrid stream…',
          )
          result = { ok: true, url: uri }
          break
        }
        setPrepareStatus(
          candidates.length > 1
            ? `Connecting to peers (${i + 1}/${candidates.length})…`
            : 'Connecting to peers…',
        )
        const attempt = await Promise.race([
          window.signalDesktop.torrentStream(uri, { keepOthers }),
          new Promise<TorrentStreamResult>((resolve) => {
            window.setTimeout(
              () =>
                resolve({
                  ok: false,
                  error:
                    'Taking too long to start — this release may be unavailable. Try another episode or quality.',
                }),
              35_000,
            )
          }),
        ])
        if (attempt.ok && attempt.url) {
          result = attempt
          break
        }
        lastError = attempt.error || 'Could not start torrent stream'
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
              ? 'No peers found for any release of this episode. Try another episode.'
              : 'No peers found for this episode. Try another episode or quality.'
            : lastError,
        )
        setPlayingIndex(null)
        setPrepareStatus(null)
        return
      }
      setPrepareStatus('Starting player…')

      const playlist: StreamPlaylistItem[] | undefined =
        episodes.length > 1
          ? episodes.map((ep, epIndex) =>
              epIndex === index
                ? {
                    title: ep.title,
                    url: result.url!,
                    torrentUri: usedUri,
                    torrentAlternates: ep.alternates,
                    episodeKey: ep.key,
                    subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                    subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                    fileName: result.fileName,
                  }
                : {
                    title: ep.title,
                    url: '',
                    torrentUri: ep.torrentUri,
                    torrentAlternates: ep.alternates,
                    episodeKey: ep.key,
                  },
            )
          : undefined

      const showName = cleanShowDisplayTitle(item.title) || item.title
      const playable: StreamItem = {
        ...item,
        // Human title for chrome / loading — keep release name in description.
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
            {display.description && !/^https?:\/\//i.test(display.description.trim()) && (
              <p className="show-page-summary">{display.description}</p>
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
                <li key={`${ep.key}-${ep.torrentUri}`}>
                  <button
                    type="button"
                    className={`show-episode-row${isContinue ? ' is-continue' : ''}`}
                    disabled={playingIndex != null}
                    onClick={() => void playEpisode(index)}
                  >
                    <span className="show-episode-key">{ep.key}</span>
                    <span className="show-episode-name" title={ep.title}>
                      {formatEpisodeListLabel(ep)}
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
