import { useEffect, useMemo, useState, type UIEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCatalog } from '../context/CatalogContext'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import { normalizeTitleKey } from '../lib/dedupe'
import {
  formatEpgTime,
  nowNext,
  programmesForDay,
  startOfLocalDay,
} from '../lib/epg'

export function GuidePage() {
  const navigate = useNavigate()
  const { items } = useCatalog()
  const { data, loading, error, activeUrl, refresh } = useEpg()
  const { mode, item: playing, resumeItem, resumePrevious } = usePlayback()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const dayStart = startOfLocalDay()
  const canReturnToStream = Boolean(resumeItem || (mode === 'pip' && playing))

  function goBackToStream() {
    const target = resumePrevious()
    if (target) {
      navigate(`/watch/${target.id}`)
      return
    }
    navigate(-1)
  }

  // Load on demand only (never on app startup — large guides freeze the UI)
  useEffect(() => {
    if (!activeUrl || data || loading) return
    void refresh()
  }, [activeUrl, data, loading, refresh])

  const guideChannels = useMemo(() => {
    if (!data) return []

    const byTvg = new Map<string, (typeof items)[0]>()
    const byTitle = new Map<string, (typeof items)[0]>()
    for (const item of items) {
      if (item.tvgId) {
        byTvg.set(item.tvgId, item)
        byTvg.set(item.tvgId.toLowerCase(), item)
      }
      const key = normalizeTitleKey(item.title)
      if (key && !byTitle.has(key)) byTitle.set(key, item)
    }

    const rows: Array<{
      item: (typeof items)[0]
      epgId: string
      nowTitle?: string
      nextTitle?: string
    }> = []
    const seen = new Set<string>()

    for (const ch of data.channels) {
      const item =
        byTvg.get(ch.id) ||
        byTvg.get(ch.id.toLowerCase()) ||
        byTitle.get(normalizeTitleKey(ch.name))
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      const { now, next } = nowNext(data, ch.id)
      rows.push({
        item,
        epgId: ch.id,
        nowTitle: now?.title,
        nextTitle: next?.title,
      })
    }

    rows.sort((a, b) => a.item.title.localeCompare(b.item.title))
    return rows
  }, [items, data])

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return guideChannels
    return guideChannels.filter(
      (r) =>
        r.item.title.toLowerCase().includes(q) ||
        (r.nowTitle?.toLowerCase().includes(q) ?? false),
    )
  }, [guideChannels, query])

  // Render in chunks so huge guides stay snappy; more rows load as you scroll
  const CHUNK = 300
  const [visibleCount, setVisibleCount] = useState(CHUNK)
  useEffect(() => {
    setVisibleCount(CHUNK)
  }, [query, data])

  const filtered = useMemo(() => matching.slice(0, visibleCount), [matching, visibleCount])

  function onChannelListScroll(e: UIEvent<HTMLElement>) {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && visibleCount < matching.length) {
      setVisibleCount((n) => Math.min(n + CHUNK, matching.length))
    }
  }

  const selected = filtered.find((r) => r.item.id === selectedId) ?? filtered[0]
  const dayProgrammes = useMemo(() => {
    if (!data || !selected) return []
    return programmesForDay(data, selected.epgId, dayStart)
  }, [data, selected, dayStart])

  return (
    <div className="page guide-page">
      <header className="page-header">
        <p className="eyebrow">Schedule</p>
        <h1>Guide</h1>
        <p className="lede">
          Now/next and today’s timeline from XMLTV. Set an EPG URL in Library or import a playlist
          with <code>url-tvg</code>. Large guides load in the background — give Refresh a moment.
        </p>
      </header>

      <div className="guide-toolbar">
        {canReturnToStream && (
          <button type="button" className="ghost-btn guide-toolbar-btn" onClick={goBackToStream}>
            ← Back to stream
          </button>
        )}
        <button
          type="button"
          className="primary-btn guide-toolbar-btn"
          disabled={loading || !activeUrl}
          onClick={() => void refresh()}
        >
          {loading ? 'Loading…' : 'Refresh guide'}
        </button>
        <input
          className="search-input guide-search"
          type="search"
          placeholder="Filter channels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter guide channels"
        />
        <Link className="ghost-btn guide-toolbar-btn" to="/library">
          Library
        </Link>
      </div>

      {error && <p className="toast toast-error">{error}</p>}
      {loading && <p className="fine-print">Downloading / parsing guide… the app stays responsive.</p>}

      {!loading && !error && !!data && guideChannels.length === 0 && (
        <div className="empty-state">
          <p>
            No catalog channels matched the guide yet. Import an IPTV playlist that includes{' '}
            <code>tvg-id</code> attributes, or add a compatible XMLTV URL in Library.
          </p>
        </div>
      )}

      {!loading && !error && !data && !activeUrl && (
        <div className="empty-state">
          <p>Add an EPG URL in Library to load schedules.</p>
          <Link className="primary-btn" to="/library">
            Open Library
          </Link>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="guide-layout">
          <aside
            className="guide-channel-list"
            aria-label="Channels with schedule"
            onScroll={onChannelListScroll}
          >
            {filtered.map((row) => (
              <button
                key={row.item.id}
                type="button"
                className={`guide-channel-btn ${selected?.item.id === row.item.id ? 'active' : ''}`}
                onClick={() => setSelectedId(row.item.id)}
              >
                <strong>{row.item.title}</strong>
                <span>{row.nowTitle ? `Now: ${row.nowTitle}` : 'No programme now'}</span>
              </button>
            ))}
            {visibleCount < matching.length && (
              <p className="fine-print guide-list-more">
                Scroll for more… ({matching.length - visibleCount} remaining)
              </p>
            )}
          </aside>

          <section className="guide-timeline">
            {selected && (
              <>
                <div className="guide-timeline-head">
                  <h2>{selected.item.title}</h2>
                  <p>
                    {selected.nowTitle ? (
                      <>
                        <em>Now</em> {selected.nowTitle}
                        {selected.nextTitle ? (
                          <>
                            {' '}
                            · <em>Next</em> {selected.nextTitle}
                          </>
                        ) : null}
                      </>
                    ) : (
                      'No current programme'
                    )}
                  </p>
                  <Link className="primary-btn" to={`/watch/${selected.item.id}`} state={{ from: '/guide' }}>
                    Watch
                  </Link>
                </div>
                <ul className="guide-programme-list">
                  {dayProgrammes.length === 0 && <li className="fine-print">No listings for today.</li>}
                  {dayProgrammes.map((p) => {
                    const live = p.start <= Date.now() && Date.now() < p.stop
                    return (
                      <li key={`${p.channelId}-${p.start}`} className={live ? 'is-live' : ''}>
                        <time>
                          {formatEpgTime(p.start)} – {formatEpgTime(p.stop)}
                        </time>
                        <div>
                          <strong>{p.title}</strong>
                          {p.description && <p>{p.description}</p>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
