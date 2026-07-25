import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { useMainScrollRestore } from '../hooks/useMainScrollRestore'
import { isVodCategory } from '../lib/continueWatching'
import { getSectionSourcePrefs, setSectionSourcePrefs } from '../lib/sectionPrefs'
import { collapseEpisodeRowsToShows, isYtsLabel } from '../lib/torrents'
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
  return isYtsLabel(source)
}

/**
 * Sort key for newest → earliest. Prefer a year in the title (theatrical
 * release) over torrent upload timestamps that may be stored in releasedAt.
 */
function releaseSortKey(item: StreamItem): number {
  const yearMatch = /\b((?:19|20)\d{2})\b/.exec(item.title)
  if (yearMatch) {
    const year = Number(yearMatch[1])
    if (item.releasedAt && item.releasedAt > 0) {
      const releasedYear = new Date(item.releasedAt).getUTCFullYear()
      if (releasedYear === year) return item.releasedAt
    }
    return Date.UTC(year, 0, 1)
  }
  if (item.releasedAt && item.releasedAt > 0) return item.releasedAt
  return 0
}

function sortSectionItems(
  items: StreamItem[],
  torrentFirst: boolean,
  newestFirst: boolean,
  category: CategoryId,
) {
  return [...items].sort((a, b) => {
    // Movies: always newest release → earliest (theatrical year / added date).
    if (category === 'movies') {
      const date = releaseSortKey(b) - releaseSortKey(a)
      if (date !== 0) return date
      const ytsRank = Number(isYtsItem(b)) - Number(isYtsItem(a))
      if (ytsRank !== 0) return ytsRank
      const rank = sourceRank(a, torrentFirst) - sourceRank(b, torrentFirst)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }

    const rank = sourceRank(a, torrentFirst) - sourceRank(b, torrentFirst)
    if (rank !== 0) return rank
    if (newestFirst) {
      const date = releaseSortKey(b) - releaseSortKey(a)
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

  const categoryId = (meta?.id ?? 'series') as CategoryId
  const items = byCategory(categoryId)

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
    // TV Series / Anime: one shelf card per show (not every SxxExx release).
    if (categoryId === 'series' || categoryId === 'anime') {
      list = collapseEpisodeRowsToShows(list)
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
        categoryId,
      )
    }
    return list
  }, [items, query, showSourceTools, sourcePrefs, categoryId])

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
              · {torrentCount.toLocaleString()} titles from websites
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
      </header>

      {isVodCategory(meta.id) && (
        <ContinueWatching category={meta.id} variant="section" />
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
              Playlists last
            </label>
            <label className="check-toggle tool-toggle">
              <input
                type="checkbox"
                checked={sourcePrefs.torrentFirst}
                onChange={(e) => updateSourcePrefs({ torrentFirst: e.target.checked })}
              />
              Websites first
            </label>
            {meta.id !== 'movies' && (
              <label className="check-toggle tool-toggle">
                <input
                  type="checkbox"
                  checked={sourcePrefs.newestFirst}
                  onChange={(e) => updateSourcePrefs({ newestFirst: e.target.checked })}
                />
                Newest first
              </label>
            )}
          </>
        )}
      </div>

      <CatalogGrid
        items={shown}
        autoCheck={autoCheck}
        emptyHint={`No ${meta.label.toLowerCase()} titles yet. Import a playlist or add a website in Library to fill this shelf.`}
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
