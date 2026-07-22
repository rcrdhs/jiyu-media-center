import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { useMainScrollRestore } from '../hooks/useMainScrollRestore'
import { getSectionSourcePrefs, setSectionSourcePrefs } from '../lib/sectionPrefs'
import { getMainStage, getSectionView, setSectionView } from '../lib/viewState'
import type { CategoryId, StreamItem } from '../types'

const PAGE = 120
const MIXED_SECTIONS = new Set<CategoryId>(['movies', 'series', 'anime'])

function sourceRank(item: StreamItem, torrentFirst: boolean): number {
  const kind = item.sourceKind ?? (item.transport === 'torrent' ? 'torrent' : 'iptv')
  if (!torrentFirst) {
    if (kind === 'iptv') return 0
    if (kind === 'torrent') return 1
    return 2
  }
  if (kind === 'torrent') return 0
  if (kind === 'builtin') return 1
  return 2
}

function isYtsItem(item: StreamItem): boolean {
  const source = `${item.source ?? ''} ${(item.tags ?? []).join(' ')}`
  return /\b(?:yts|yify)(?:[-.]|$)/i.test(source)
}

function sortSectionItems(
  items: StreamItem[],
  torrentFirst: boolean,
  newestFirst: boolean,
  category: CategoryId,
) {
  return [...items].sort((a, b) => {
    // YTS/YIFY provides consistently named movie entries with real posters,
    // so keep those ahead of other movie sources.
    if (category === 'movies') {
      const ytsRank = Number(isYtsItem(b)) - Number(isYtsItem(a))
      if (ytsRank !== 0) return ytsRank
    }
    const rank = sourceRank(a, torrentFirst) - sourceRank(b, torrentFirst)
    if (rank !== 0) return rank
    if (newestFirst) {
      const date = (b.releasedAt ?? 0) - (a.releasedAt ?? 0)
      if (date !== 0) return date
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })
}

export function SectionPage() {
  const { id } = useParams<{ id: string }>()
  const { byCategory, ready, englishOnly, torrentCount, torrentSyncMessage } = useCatalog()
  const meta = CATEGORIES.find((c) => c.id === id)
  const saved = id ? getSectionView(id) : undefined
  const sentinelRef = useRef<HTMLDivElement>(null)
  const showSourceTools = Boolean(meta && MIXED_SECTIONS.has(meta.id))

  const [query, setQuery] = useState(saved?.query ?? '')
  const [visible, setVisible] = useState(saved?.visible ?? PAGE)
  const [autoCheck, setAutoCheck] = useState(saved?.autoCheck ?? true)
  const [listReady, setListReady] = useState(false)
  const [sourcePrefs, setSourcePrefsState] = useState(getSectionSourcePrefs)

  const items = byCategory((meta?.id ?? 'series') as CategoryId)

  const filtered = useMemo(() => {
    let list = items
    if (showSourceTools && sourcePrefs.hideIptv) {
      list = list.filter(
        (item) =>
          item.sourceKind === 'torrent' ||
          item.transport === 'torrent' ||
          item.sourceKind === 'builtin',
      )
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.tags?.some((t) => t.toLowerCase().includes(q)) ||
          item.source?.toLowerCase().includes(q),
      )
    }
    if (showSourceTools) {
      list = sortSectionItems(
        list,
        sourcePrefs.torrentFirst,
        sourcePrefs.newestFirst,
        (meta?.id ?? 'series') as CategoryId,
      )
    }
    return list
  }, [items, query, showSourceTools, sourcePrefs, meta?.id])

  const effectiveVisible = Math.min(
    Math.max(visible, PAGE),
    Math.max(filtered.length, PAGE),
  )
  const shown = filtered.slice(0, Math.min(effectiveVisible, filtered.length || effectiveVisible))
  const remaining = filtered.length - shown.length

  useEffect(() => {
    if (!id) return
    setSectionView(id, {
      query,
      visible: effectiveVisible,
      autoCheck,
    })
  }, [id, query, effectiveVisible, autoCheck])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || remaining <= 0) return

    const root = getMainStage()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setVisible((v) => Math.min(v + PAGE, filtered.length))
      },
      {
        root: root ?? null,
        rootMargin: '400px 0px',
        threshold: 0,
      },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [remaining, filtered.length, shown.length, id])

  useEffect(() => {
    if (!ready || !meta) {
      setListReady(false)
      return
    }
    const frame = requestAnimationFrame(() => setListReady(true))
    return () => cancelAnimationFrame(frame)
  }, [ready, meta, shown.length, id])

  useMainScrollRestore(id ? `/section/${id}` : '', listReady)

  function updateSourcePrefs(patch: Partial<typeof sourcePrefs>) {
    const next = { ...sourcePrefs, ...patch }
    setSourcePrefsState(next)
    setSectionSourcePrefs(next)
    setVisible(PAGE)
  }

  if (!meta) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>Unknown section.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header" style={{ ['--accent' as string]: meta.accent }}>
        <p className="eyebrow">Section</p>
        <h1>{meta.label}</h1>
        <p className="lede">
          {meta.blurb}{' '}
          <span className="count-chip">
            {filtered.length.toLocaleString()} title{filtered.length === 1 ? '' : 's'}
          </span>
          {torrentCount > 0 && showSourceTools && (
            <span className="lede-note">
              {' '}
              · {torrentCount.toLocaleString()} torrent titles in catalog
            </span>
          )}
          {meta.id !== 'anime' && englishOnly && (
            <span className="lede-note"> · English only (toggle in sidebar)</span>
          )}
          {meta.id === 'anime' && (
            <span className="lede-note"> · All languages (Anime)</span>
          )}
        </p>
        {torrentSyncMessage && showSourceTools && (
          <p className="fine-print">{torrentSyncMessage}</p>
        )}
        <div className="section-tools">
          <input
            className="search-input"
            type="search"
            placeholder={`Search ${meta.label.toLowerCase()}…`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setVisible(PAGE)
            }}
          />
          <label className="check-toggle tool-toggle">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => setAutoCheck(e.target.checked)}
            />
            Auto-check visible streams
          </label>
          {showSourceTools && (
            <>
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.hideIptv}
                  onChange={(e) => updateSourcePrefs({ hideIptv: e.target.checked })}
                />
                Hide IPTV / M3U
              </label>
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.torrentFirst}
                  onChange={(e) => updateSourcePrefs({ torrentFirst: e.target.checked })}
                />
                Torrents first
              </label>
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.newestFirst}
                  onChange={(e) => updateSourcePrefs({ newestFirst: e.target.checked })}
                />
                Newest first
              </label>
            </>
          )}
        </div>
      </header>

      <ContinueWatching category={meta.id} />
      <CatalogGrid
        items={shown}
        autoCheck={autoCheck}
        emptyHint={`No ${meta.label.toLowerCase()} streams yet. Import an M3U in Library, or add a torrent website under Torrents to fill this shelf.`}
      />
      {remaining > 0 && (
        <div ref={sentinelRef} className="infinite-scroll-sentinel" aria-hidden>
          <p className="fine-print">
            Showing {shown.length.toLocaleString()} of {filtered.length.toLocaleString()} — scroll for more
          </p>
        </div>
      )}
    </div>
  )
}
