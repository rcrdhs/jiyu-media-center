import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useStreamHealth } from '../context/StreamHealthContext'
import { eventBadgeForItem } from '../lib/eventTimer'
import { getMainStage, setMainScroll, setSectionFocusItem } from '../lib/viewState'
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
  const [nowMs, setNowMs] = useState(() => Date.now())
  const hoverTimer = useRef<number | null>(null)
  const catalogPoster = (() => {
    const raw = item.poster || ''
    if (raw.startsWith('data:image/')) return raw
    return isWeakPosterUrl(raw) ? '' : raw
  })()
  const poster = catalogPoster || fallbackPoster || item.poster || ''
  const queueable = canQueueWatchNext(item)
  const eventBadge = eventBadgeForItem(item, nowMs)
  const posterFrame =
    item.category === 'anime' ||
    item.category === 'movies' ||
    item.category === 'series' ||
    item.category === 'kids'

  useEffect(() => subscribeWatchNext((entry) => setQueued(entry?.id === item.id)), [item.id])

  useEffect(() => {
    const start = Number(item.eventStartsAt) || 0
    // Only tick for upcoming countdowns — live badges are static.
    if (!start || start <= Date.now()) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [item.eventStartsAt])

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
      data-item-id={item.id}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <Link
        to={
          isShowBrowseItem(item) || item.category === 'movies'
            ? `/show/${item.id}`
            : `/watch/${item.id}`
        }
        className={`media-card${item.category === 'sports' ? ' is-sports' : ''}`}
        state={{ from: `${location.pathname}${location.search}` }}
        title={
          entry
            ? `${STATUS_LABEL[status]} · ${entry.latencyMs}ms${entry.error ? ` · ${entry.error}` : ''}`
            : item.category === 'sports'
              ? [item.title, item.description].filter(Boolean).join(' — ')
              : STATUS_LABEL[status]
        }
        onClick={() => {
          const stage = getMainStage()
          if (stage) setMainScroll(location.pathname, stage.scrollTop)
          const sectionMatch = /^\/section\/([^/?#]+)/.exec(location.pathname)
          if (sectionMatch?.[1]) setSectionFocusItem(sectionMatch[1], item.id)
        }}
      >
        <div className={`media-card-art${posterFrame ? ' is-poster' : ''}`} aria-hidden={!poster}>
          {poster ? (
            <img src={poster} alt="" loading="lazy" />
          ) : (
            <span className="media-card-fallback">{item.title.slice(0, 1)}</span>
          )}
          {previewing && <CardPreview url={item.url} onEnd={endPreview} />}
          {/* Sports meta (league + viewers/countdown) lives in the card body like PPV.st */}
          {eventBadge && item.category !== 'sports' ? (
            <span
              className={`event-badge event-${eventBadge.kind}${eventBadge.viewers ? ' has-viewers' : ''}`}
            >
              {eventBadge.viewers ? <i className="event-live-dot" aria-hidden /> : null}
              {eventBadge.label}
            </span>
          ) : null}
          {!skipHealth && (
            <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
          )}
        </div>
        <div className="media-card-body">
          <h3>{item.title}</h3>
          {item.category === 'sports' && (item.eventSport || eventBadge) ? (
            <div className="media-card-sport-meta">
              {item.eventSport ? (
                <span className="media-card-sport">{item.eventSport}</span>
              ) : (
                <span className="media-card-sport" />
              )}
              {eventBadge ? (
                <span
                  className={`event-meta event-${eventBadge.kind}${eventBadge.viewers ? ' has-viewers' : ''}`}
                >
                  {eventBadge.viewers ? <i className="event-live-dot" aria-hidden /> : null}
                  {eventBadge.label}
                </span>
              ) : null}
            </div>
          ) : null}
          {item.category === 'sports' && (() => {
            const detail = (item.description || '').trim()
            if (!detail || /^https?:\/\//i.test(detail)) return null
            // Drop pieces already shown as title / sport chip to avoid clutter.
            const sport = (item.eventSport || '').trim()
            const parts = detail
              .split(/\s*·\s*/)
              .map((p) => p.trim())
              .filter(Boolean)
              .filter((p) => {
                if (sport && p.toLowerCase() === sport.toLowerCase()) return false
                if (p.toLowerCase() === item.title.trim().toLowerCase()) return false
                return true
              })
            if (parts.length === 0) return null
            return <p className="media-card-match-detail">{parts.join(' · ')}</p>
          })()}
          {item.category !== 'sports' && (() => {
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
          {item.category !== 'sports' && (() => {
            const sourceKey = (item.source || '').trim().toLowerCase()
            const visibleTags = (item.tags ?? []).filter((tag) => {
              const t = tag.trim()
              if (!t) return false
              if (/^https?:\/\//i.test(t) || /^#?\d+$/.test(t)) return false
              if (t.toLowerCase() === 'torrent' || t.toLowerCase() === 'subsplease') return false
              // Shelf plumbing — not for card chrome.
              if (
                /^(series|movies|anime|full-shows|new-releases|trending-airing|popular-series|airing-series|trending-series|popular-movies|new-movies|live|streamed|ppv\.st|live-now|always-live|upcoming|popular)$/i.test(
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
