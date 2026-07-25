import { useEffect, useMemo, useState, type UIEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCatalog } from '../context/CatalogContext'
import { useEpg } from '../context/EpgContext'
import { usePlayback } from '../context/PlaybackContext'
import {
  formatEpgTime,
  matchEpgChannelId,
  nowNext,
  programmesForDay,
  startOfLocalDay,
} from '../lib/epg'

export function GuidePage() {
  const navigate = useNavigate()
  const { items } = useCatalog()
  const { data, loading, error, activeUrls, refresh } = useEpg()
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
    if (activeUrls.length === 0 || data || loading) return
    void refresh()
  }, [activeUrls, data, loading, refresh])

  // Walk playable catalog streams and attach XMLTV when ids/titles match.
  const guideChannels = useMemo(() => {
    if (!data) return []

    const rows: Array<{
      item: (typeof items)[0]
      epgId: string
      nowTitle?: string
      nextTitle?: string
    }> = []

    for (const item of items) {
      // Guide is for live IPTV / builtin streams — skip torrent VOD rows.
      if (item.sourceKind === 'torrent' || item.transport === 'torrent') continue
      const epgId = matchEpgChannelId(item, data)
      if (!epgId) continue
      const { now, next } = nowNext(data, epgId)
      rows.push({
        item,
        epgId,
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
        <p className="eyebrow">What’s on</p>
        <h1>Guide</h1>
        <p className="lede">
          See what’s playing now and up next on your live channels. Pick a channel for today’s
          full lineup — tap Refresh if listings look stale.
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
          disabled={loading || activeUrls.length === 0}
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
            Guide downloaded ({data.channels.length.toLocaleString()} XMLTV channels) but none
            matched your current IPTV streams. US/JM brands match best; add a playlist with{' '}
            <code>tvg-id</code>s or another XMLTV URL in Library.
          </p>
        </div>
      )}

      {!loading && !error && !data && (
        <div className="empty-state">
          <p>Guide hasn’t loaded yet. Tap Refresh, or set an EPG URL in Library.</p>
          <button
            type="button"
            className="primary-btn"
            disabled={activeUrls.length === 0 || loading}
            onClick={() => void refresh()}
          >
            Refresh guide
          </button>
          <Link className="ghost-btn" to="/library">
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
