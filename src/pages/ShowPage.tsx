import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { resolvePlayableItem } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { getContinueEntry } from '../lib/continueWatching'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import {
  cleanShowDisplayTitle,
  isShowBrowseItem,
  labelQuality,
  resolveShowEpisodes,
  type EpisodeChoice,
} from '../lib/torrents'
import type { StreamItem, StreamPlaylistItem } from '../types'

export function ShowPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { getById, items } = useCatalog()
  const { play } = usePlayback()
  const raw = id ? getById(id) : undefined
  const item = useMemo(() => resolvePlayableItem(raw, items), [raw, items])

  const [episodes, setEpisodes] = useState<EpisodeChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
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
      setPlayError('Torrent playback needs the Jiyu desktop app.')
      return
    }
    const chosen = episodes[index]
    if (!chosen) return
    setPlayingIndex(index)
    setPlayError(null)
    try {
      const result = await Promise.race([
        window.signalDesktop.torrentStream(chosen.torrentUri),
        new Promise<{ ok: false; error: string }>((resolve) => {
          window.setTimeout(
            () =>
              resolve({
                ok: false,
                error: 'Taking too long to start — the swarm may be dead. Try another episode.',
              }),
            60_000,
          )
        }),
      ])
      if (!result.ok || !('url' in result && result.url)) {
        setPlayError(
          ('error' in result && result.error) ||
            'Could not start torrent stream',
        )
        setPlayingIndex(null)
        return
      }

      const playlist: StreamPlaylistItem[] | undefined =
        episodes.length > 1
          ? episodes.map((ep, epIndex) =>
              epIndex === index
                ? {
                    title: ep.title,
                    url: result.url!,
                    torrentUri: ep.torrentUri,
                    subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                    subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                    fileName: result.fileName,
                  }
                : {
                    title: ep.title,
                    url: '',
                    torrentUri: ep.torrentUri,
                  },
            )
          : undefined

      const playable: StreamItem = {
        ...item,
        title: chosen.title || result.name || result.fileName || item.title,
        description: result.fileName ?? item.description,
        url: result.url,
        subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
        subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
        playlist,
        torrentUri: chosen.torrentUri,
        transport: 'direct',
      }
      play(playable, {
        forceFull: true,
        returnTo: `/show/${item.id}`,
      })
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : 'Torrent playback failed')
    } finally {
      setPlayingIndex(null)
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

  return (
    <div className="page show-page">
      <header className="page-header show-page-header">
        <div className="show-page-heading">
          <Link className="ghost-btn" to={returnTo}>
            ← Back
          </Link>
          <div className="show-page-title-block">
            <p className="eyebrow">{display.category === 'anime' ? 'Anime' : 'TV Series'}</p>
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
                    <span className="show-episode-name">{ep.title}</span>
                    <span className="show-episode-meta">
                      {ep.quality > 0 ? labelQuality(ep.quality) : ''}
                      {isContinue ? ' · Resume' : ''}
                      {busy ? ' · Starting…' : ''}
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
