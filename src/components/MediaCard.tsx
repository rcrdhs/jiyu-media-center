import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useStreamHealth } from '../context/StreamHealthContext'
import { getMainStage, setMainScroll } from '../lib/viewState'
import { isShowBrowseItem, isSeriesWebCatalogItem } from '../lib/torrents'
import { isWebBrowserOnlyUrl, isYouTubeUrl } from '../lib/webBrowser'
import { isWeakPosterUrl, resolveCatalogPoster } from '../lib/posterFallback'
import {
  canQueueWatchNext,
  clearWatchNext,
  isWatchNext,
  setWatchNext,
  subscribeWatchNext,
} from '../lib/watchNext'
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
  // Web-browser titles (M2Box, NetMirror, YouTube, …) aren't probeable HLS — hide health chrome.
  const skipHealth =
    isTorrent || isSeriesWebCatalogItem(item) || isWebBrowserOnlyUrl(item.url)
  const status = skipHealth ? 'online' : getStatus(item.id)
  const entry = skipHealth ? undefined : getEntry(item.id)

  const [previewing, setPreviewing] = useState(false)
  const [previewDone, setPreviewDone] = useState(false)
  const [fallbackPoster, setFallbackPoster] = useState('')
  const [queued, setQueued] = useState(() => isWatchNext(item.id))
  const hoverTimer = useRef<number | null>(null)
  const catalogPoster = isWeakPosterUrl(item.poster) ? '' : item.poster || ''
  const poster = catalogPoster || fallbackPoster || item.poster || ''
  const queueable = canQueueWatchNext(item)

  useEffect(() => subscribeWatchNext((entry) => setQueued(entry?.id === item.id)), [item.id])

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
    !skipHealth &&
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
          {!skipHealth && (
            <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
          )}
        </div>
        <div className="media-card-body">
          <h3>{item.title}</h3>
          {(() => {
            const sourceKey = (item.source || '').trim()
            let description = (item.description || '').trim()
            if (!description || /^https?:\/\//i.test(description)) return null
            // Strip website / release-group names from card copy (SubsPlease, eztvx.to, …).
            if (sourceKey) {
              const escaped = sourceKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              description = description
                .replace(new RegExp(`(^|[·|,\\-–—\\s]+)${escaped}(?=$|[·|,\\-–—\\s]+)`, 'ig'), ' · ')
                .replace(/\s*·\s*·\s*/g, ' · ')
                .replace(/^[·\s,|\-–—]+|[·\s,|\-–—]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim()
            }
            description = description
              .replace(/\bsubsplease\b/gi, '')
              .replace(/\s*·\s*·\s*/g, ' · ')
              .replace(/^[·\s,|\-–—]+|[·\s,|\-–—]+$/g, '')
              .trim()
            if (!description) return null
            if (/\.(to|com|org|net|gg|ch|re|ag|tv|io|xyz)\b/i.test(description)) return null
            return <p>{description}</p>
          })()}
          {(() => {
            const sourceKey = (item.source || '').trim().toLowerCase()
            const visibleTags = (item.tags ?? []).filter((tag) => {
              const t = tag.trim()
              if (!t) return false
              if (/^https?:\/\//i.test(t) || /^#?\d+$/.test(t)) return false
              if (t.toLowerCase() === 'torrent' || t.toLowerCase() === 'subsplease') return false
              // Shelf plumbing — not for card chrome.
              if (
                /^(series|movies|anime|full-shows|new-releases|trending-airing|popular-movies|new-movies)$/i.test(
                  t,
                )
              ) {
                return false
              }
              // Never show the website / playlist source on cards (e.g. eztvx.to).
              if (sourceKey && t.toLowerCase() === sourceKey) return false
              if (/\.(to|com|org|net|gg|ch|re|ag|tv|io|xyz)\b/i.test(t)) return false
              return true
            })
            if (visibleTags.length === 0) return null
            return (
              <ul className="tag-row">
                {visibleTags.slice(0, 3).map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            )
          })()}
        </div>
      </Link>
      {(queueable || !skipHealth) && (
        <div className="media-card-actions">
          {queueable && (
            <button
              type="button"
              className={`card-check-btn${queued ? ' is-queued' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (queued) clearWatchNext()
                else setWatchNext(item)
              }}
              title={
                queued
                  ? 'Clear up next'
                  : 'Play after the current title finishes (replaces any queued title)'
              }
            >
              {queued ? 'Queued' : 'Play next'}
            </button>
          )}
          {!skipHealth && (
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
      )}
    </div>
  )
}
