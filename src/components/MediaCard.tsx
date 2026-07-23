import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useStreamHealth } from '../context/StreamHealthContext'
import { getMainStage, setMainScroll } from '../lib/viewState'
import { isYouTubeUrl } from '../lib/webBrowser'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import { isShowBrowseItem } from '../lib/torrents'
import { CardPreview } from './CardPreview'
import type { StreamHealthState, StreamItem } from '../types'

interface MediaCardProps {
  item: StreamItem
}

const STATUS_LABEL: Record<StreamHealthState, string> = {
  idle: 'Not checked',
  checking: 'Checking…',
  online: 'Online',
  offline: 'Offline',
  timeout: 'Timeout',
}

const PREVIEW_HOVER_DELAY_MS = 700

export function MediaCard({ item }: MediaCardProps) {
  const location = useLocation()
  const { getStatus, getEntry, checkOne } = useStreamHealth()
  const isTorrent = item.transport === 'torrent' || item.sourceKind === 'torrent'
  const status = isTorrent ? 'online' : getStatus(item.id)
  const entry = isTorrent ? undefined : getEntry(item.id)

  const [previewing, setPreviewing] = useState(false)
  const [previewDone, setPreviewDone] = useState(false)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const hoverTimer = useRef<number | null>(null)
  const catalogPoster = isWeakPosterUrl(item.poster) ? '' : item.poster || ''
  const poster = catalogPoster || fallbackPoster || item.poster || ''

  useEffect(() => {
    let cancelled = false
    setFallbackPoster('')
    if (catalogPoster) return
    if (item.category !== 'anime' && item.category !== 'movies' && item.category !== 'series') {
      return
    }
    void resolveCatalogPoster(item.title, item.category).then((url) => {
      if (!cancelled) setFallbackPoster(url)
    })
    return () => {
      cancelled = true
    }
  }, [item.id, item.title, item.poster, item.category, catalogPoster])

  const canPreview =
    !isTorrent &&
    !isYouTubeUrl(item.url) &&
    status !== 'offline' &&
    status !== 'timeout'

  function onEnter() {
    if (!canPreview || previewDone || previewing) return
    hoverTimer.current = window.setTimeout(() => setPreviewing(true), PREVIEW_HOVER_DELAY_MS)
  }

  function onLeave() {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setPreviewing(false)
    setPreviewDone(false)
  }

  const endPreview = useCallback(() => {
    setPreviewing(false)
    // Don't restart until the pointer leaves and comes back
    setPreviewDone(true)
  }, [])

  useEffect(() => {
    return () => {
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    }
  }, [])

  return (
    <div
      className={`media-card-wrap status-${status}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <Link
        to={isShowBrowseItem(item) ? `/show/${item.id}` : `/watch/${item.id}`}
        className="media-card"
        state={{ from: `${location.pathname}${location.search}` }}
        title={
          entry
            ? `${STATUS_LABEL[status]} · ${entry.latencyMs}ms${entry.error ? ` · ${entry.error}` : ''}`
            : STATUS_LABEL[status]
        }
        onClick={() => {
          const stage = getMainStage()
          if (stage) setMainScroll(location.pathname, stage.scrollTop)
        }}
      >
        <div className="media-card-art" aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" loading="lazy" />
          ) : (
            <span className="media-card-fallback">{item.title.slice(0, 1)}</span>
          )}
          {previewing && <CardPreview url={item.url} onEnd={endPreview} />}
          {!isTorrent && (
            <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
          )}
        </div>
        <div className="media-card-body">
          <h3>{item.title}</h3>
          {item.description && !/^https?:\/\//i.test(item.description.trim()) && (
            <p>{item.description}</p>
          )}
          {item.tags && item.tags.length > 0 && (
            <ul className="tag-row">
              {item.tags
                .filter(
                  (tag) =>
                    !/^https?:\/\//i.test(tag) &&
                    !/^#?\d+$/.test(tag) &&
                    tag.toLowerCase() !== 'torrent',
                )
                .slice(0, 3)
                .map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
            </ul>
          )}
        </div>
      </Link>
      {!isTorrent && (
        <button
          type="button"
          className="card-check-btn"
          disabled={status === 'checking'}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void checkOne(item)
          }}
        >
          {status === 'checking' ? 'Checking…' : 'Check'}
        </button>
      )}
    </div>
  )
}
