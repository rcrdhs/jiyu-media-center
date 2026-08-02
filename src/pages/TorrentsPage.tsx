import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import {
  deleteTorrentItemsForSource,
  loadTorrentCatalogMeta,
} from '../lib/torrentCatalogStore'
import {
  getTorrentSyncStatus,
  subscribeTorrentSyncMessage,
} from '../lib/torrentSyncStatus'
import {
  buildEpisodeChoices,
  buildSearchUrl,
  formatSize,
  getConnectionDownlinkMbps,
  isTorrentInput,
  isSubsPleaseUrl,
  labelQuality,
  loadTorrentSources,
  loadTorrentSourcesAsync,
  normalizeShowKey,
  normalizeWebsiteUrl,
  parseEpisodeKey,
  pickBestStream,
  saveTorrentSources,
  scrapePage,
  scrapeWebsite,
  type TorrentPageLink,
  type TorrentResult,
  type TorrentSource,
} from '../lib/torrents'
import { guessVodCategory } from '../lib/continueWatching'
import { getViewingQuality } from '../lib/viewingQuality'
import type { StreamItem, StreamPlaylistItem, TorrentInfo } from '../types'

type TorrentsPageProps = {
  /** When true, render as a Library subsection (no page chrome). */
  embedded?: boolean
}

export function TorrentsPage({ embedded = false }: TorrentsPageProps) {
  const { play } = usePlayback()
  const { syncTorrentWebsite, reloadTorrentCatalog, torrentCount } = useCatalog()
  const torrentSyncStatus = useSyncExternalStore(
    subscribeTorrentSyncMessage,
    getTorrentSyncStatus,
    getTorrentSyncStatus,
  )
  const torrentSyncMessage = torrentSyncStatus.message
  const desktop = Boolean(window.signalDesktop?.torrentStream)
  const returnTo = embedded ? '/library' : '/torrents'

  const [sources, setSources] = useState<TorrentSource[]>(loadTorrentSources)
  const [draftUrl, setDraftUrl] = useState('')
  const [syncingId, setSyncingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadTorrentSourcesAsync().then((rows) => {
      if (!cancelled) setSources(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [browsingId, setBrowsingId] = useState<string | null>(null)
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const [results, setResults] = useState<TorrentResult[]>([])
  const [pageLinks, setPageLinks] = useState<TorrentPageLink[]>([])
  const [pageTitle, setPageTitle] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [pageHistory, setPageHistory] = useState<string[]>([])
  const [pageQuery, setPageQuery] = useState('')
  const [nextPage, setNextPage] = useState<string | null>(null)
  const [prevPage, setPrevPage] = useState<string | null>(null)
  const [searchTemplate, setSearchTemplate] = useState<string | null>(null)
  const [scrapeError, setScrapeError] = useState<string | null>(null)

  const [torrentDraft, setTorrentDraft] = useState('')
  const [preparing, setPreparing] = useState<string | null>(null)
  const [autoInfo, setAutoInfo] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [active, setActive] = useState<TorrentInfo[]>([])

  function persistSources(next: TorrentSource[]) {
    setSources(next)
    saveTorrentSources(next)
  }

  function addSource(e: FormEvent) {
    e.preventDefault()
    const url = normalizeWebsiteUrl(draftUrl)
    if (!url) return
    let label = url
    try {
      label = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* keep url as label */
    }
    try {
      const parsed = new URL(url)
      if (/(^|\.)subsplease\.org$/i.test(parsed.hostname)) {
        label = /^\/shows\/?$/i.test(parsed.pathname)
          ? 'subsplease.org · Full Shows'
          : parsed.pathname === '/' || parsed.pathname === ''
            ? 'subsplease.org · New Releases'
            : label
      }
    } catch {
      /* keep hostname label */
    }
    const source: TorrentSource = { id: `src-${Date.now()}`, label, url }
    persistSources([...sources, source])
    setDraftUrl('')
    void browseSource(source)
    // Permanently extract Movies / Series / Anime into the main shelves
    setSyncingId(source.id)
    void syncTorrentWebsite(source.id).finally(() => setSyncingId(null))
  }

  const browseSource = useCallback(async (source: TorrentSource) => {
    setActiveSourceId(source.id)
    setBrowsingId(source.id)
    setScrapeError(null)
    setResults([])
    setPageLinks([])
    setPageHistory([])
    setPageQuery('')
    try {
      const outcome = await scrapeWebsite(source)
      setResults(outcome.results)
      setPageLinks(outcome.links)
      setPageTitle(outcome.pageTitle)
      setPageUrl(outcome.pageUrl)
      setNextPage(outcome.nextPage)
      setPrevPage(outcome.prevPage)
      setSearchTemplate(outcome.searchTemplate)
      setScrapeError(outcome.error)
      // Browse is a preview; shelves only update after sync. Kick one off when
      // this site has nothing shelved yet (common for YTS after the API switch).
      if (outcome.links.length > 0) {
        const shelved =
          loadTorrentCatalogMeta().bySource[source.id]?.count ?? 0
        if (shelved === 0) {
          setSyncingId(source.id)
          void syncTorrentWebsite(source.id).finally(() => setSyncingId(null))
        }
      }
    } finally {
      setBrowsingId(null)
    }
  }, [syncTorrentWebsite])

  const browsePage = useCallback(
    async (url: string, source: TorrentSource, addToHistory = true) => {
      setBrowsingId(source.id)
      setScrapeError(null)
      if (addToHistory && pageUrl) setPageHistory((history) => [...history, pageUrl])
      setPageQuery('')
      const stage = document.querySelector('.main-stage')
      if (stage) stage.scrollTop = 0
      try {
        const outcome = await scrapePage(url, source.label)
        setResults(outcome.results)
        setPageLinks(outcome.links)
        setPageTitle(outcome.pageTitle)
        setPageUrl(outcome.pageUrl)
        setNextPage(outcome.nextPage)
        setPrevPage(outcome.prevPage)
        // Detail pages often have no search form; keep the last known template
        if (outcome.searchTemplate) setSearchTemplate(outcome.searchTemplate)
        setScrapeError(outcome.error)
        return outcome
      } finally {
        setBrowsingId(null)
      }
    },
    [pageUrl],
  )

  // Click a movie card → open its page and immediately stream the best quality
  // for the current connection. If the page has no playable link, just browse it.
  async function openCard(link: TorrentPageLink, source: TorrentSource) {
    if (preparing) return
    setAutoInfo(null)
    // API-backed listings (e.g. EZTV) already carry the magnet — play it now
    const direct = link.torrentUri || (isTorrentInput(link.url) ? link.url : '')
    if (direct) {
      void streamTorrent(direct, link.title)
      return
    }
    const outcome = await browsePage(link.url, source)
    if (!outcome || !window.signalDesktop?.torrentStream) return
    const preference = getViewingQuality()
    const requestedQuality = preference === 'auto' ? 720 : preference
    const downlink = getConnectionDownlinkMbps()
    const episodes = buildEpisodeChoices(outcome.results, downlink, requestedQuality)
    if (episodes.length > 1) {
      const startIndex = 0
      const chosen = episodes[startIndex]
      setAutoInfo(
        `Playing episode ${startIndex + 1} of ${episodes.length} · ${labelQuality(chosen.quality)}.`,
      )
      void streamTorrent(chosen.torrentUri, chosen.title, {
        episodePlaylist: episodes.map((ep) => ({
          title: ep.title,
          url: '',
          torrentUri: ep.torrentUri,
        })),
        startIndex,
      })
      return
    }
    const pick = pickBestStream(outcome.results, downlink, requestedQuality)
    if (!pick) return
    setAutoInfo(
      `Auto-selected ${labelQuality(pick.quality)} for your connection (target ${labelQuality(
        pick.target,
      )}).`,
    )
    void streamTorrent(pick.result.uri, pick.result.title)
  }

  const refreshActive = useCallback(async () => {
    if (!window.signalDesktop?.torrentStatus) return
    const status = await window.signalDesktop.torrentStatus()
    if (status.ok) setActive(status.torrents)
  }, [])

  useEffect(() => {
    void refreshActive()
    const timer = window.setInterval(() => void refreshActive(), 4000)
    return () => window.clearInterval(timer)
  }, [refreshActive])

  async function streamTorrent(
    uri: string,
    title: string,
    options?: { episodePlaylist?: StreamPlaylistItem[]; startIndex?: number },
  ) {
    if (!window.signalDesktop?.torrentStream || preparing) return
    setStreamError(null)
    setPreparing(uri)
    try {
      await window.signalDesktop.torrentStop?.()
      const result = await window.signalDesktop.torrentStream(uri)
      if (!result.ok || !result.url) {
        setStreamError(result.error || 'Could not start playback')
        return
      }
      const category = guessVodCategory(title || result.name || '', pageUrl || uri)
      const startIndex = options?.startIndex ?? 0
      let playlist = options?.episodePlaylist
      if (playlist && playlist.length > 1) {
        playlist = playlist.map((entry, index) =>
          index === startIndex
            ? {
                ...entry,
                url: result.url!,
                subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
                subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
                fileName: result.fileName,
              }
            : entry,
        )
      } else if (result.playlist && result.playlist.length > 1) {
        playlist = result.playlist
      }
      const item: StreamItem = {
        id: `torrent-${result.infoHash ?? Date.now()}`,
        title: title || result.name || result.fileName || 'Stream',
        description: result.fileName ?? '',
        category,
        url: result.url,
        subtitleUrl: result.subtitleUrl ?? result.playlist?.[0]?.subtitleUrl,
        subtitleKind: result.subtitleKind ?? result.playlist?.[0]?.subtitleKind,
        source: 'torrent',
        sourceKind: 'torrent',
        transport: 'torrent',
        torrentUri: uri,
        detailUrl: pageUrl || undefined,
        playlist,
      }
      play(item, { forceFull: true, returnTo })
      void refreshActive()
    } finally {
      setPreparing(null)
    }
  }

  function streamPastedTorrent(e: FormEvent) {
    e.preventDefault()
    const uri = torrentDraft.trim()
    setAutoInfo(null)
    if (isTorrentInput(uri)) {
      void streamTorrent(uri, '')
      return
    }
    // A normal web page was pasted — browse it for playable links instead
    if (/^https?:\/\//i.test(uri) || /^[\w-]+\.[\w.-]+\//.test(uri)) {
      const url = normalizeWebsiteUrl(uri)
      let label = url
      try {
        label = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        /* keep url */
      }
      const source: TorrentSource = { id: `src-${Date.now()}`, label, url }
      setStreamError(null)
      setTorrentDraft('')
      setActiveSourceId(source.id)
      setPageUrl('')
      setPageHistory([])
      void browsePage(url, source, false)
      return
    }
    setStreamError('Paste a link or web page address')
  }

  async function stopAll() {
    await window.signalDesktop?.torrentStop?.()
    void refreshActive()
  }

  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null
  const filteredResults = useMemo(() => {
    const q = pageQuery.trim().toLowerCase()
    if (!q) return results
    return results.filter((r) => r.title.toLowerCase().includes(q))
  }, [results, pageQuery])
  const filteredPageLinks = useMemo(() => {
    const q = pageQuery.trim().toLowerCase()
    if (!q) return pageLinks
    return pageLinks.filter(
      (link) =>
        link.title.toLowerCase().includes(q) || link.summary.toLowerCase().includes(q),
    )
  }, [pageLinks, pageQuery])

  const heading = (
    <>
      {embedded ? (
        <header className="page-header library-websites-header" id="websites">
          <h2>Websites</h2>
          <p className="lede">
            Add catalog sites to browse and fill Movies, TV Series, and Anime. Only use sites and
            content you have the right to access.
            {torrentCount > 0 && (
              <>
                {' '}
                <span className="count-chip">
                  {torrentCount.toLocaleString()} title{torrentCount === 1 ? '' : 's'} in catalog
                </span>
              </>
            )}
          </p>
        </header>
      ) : (
        <header className="page-header">
          <p className="eyebrow">Sources</p>
          <h1>Websites</h1>
          <p className="lede">
            Add catalog sites to browse and fill Movies, TV Series, and Anime. Only use sites and
            content you have the right to access.
            {torrentCount > 0 && (
              <>
                {' '}
                <span className="count-chip">
                  {torrentCount.toLocaleString()} title{torrentCount === 1 ? '' : 's'} in catalog
                </span>
              </>
            )}
          </p>
        </header>
      )}
    </>
  )

  return (
    <div className={embedded ? 'library-websites torrents-page' : 'page torrents-page'}>
      {heading}

      {!desktop && (
        <p className="toast toast-error">
          Website playback needs the desktop app — quit and relaunch Jiyu with{' '}
          <code>npm run dev:desktop</code>.
        </p>
      )}

      {torrentSyncMessage && (
        <p className="toast" role="status">
          {torrentSyncStatus.percent != null
            ? `${torrentSyncMessage} · ${torrentSyncStatus.percent}%`
            : torrentSyncMessage}
        </p>
      )}

      <form className="guide-toolbar" onSubmit={addSource}>
        <input
          className="search-input guide-search"
          type="text"
          placeholder="Add a website (e.g. yts.mx or torlock.com)…"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          aria-label="Add a website"
        />
        <button type="submit" className="primary-btn guide-toolbar-btn" disabled={!draftUrl.trim()}>
          Add
        </button>
      </form>

      {sources.length > 0 && (
        <section className="torrent-sources">
          <div className="torrent-sources-head">
            <h2>Your websites</h2>
          </div>
          <ul className="torrent-source-list">
            {sources.map((s) => (
              <li key={s.id} className={s.id === activeSourceId ? 'is-active' : ''}>
                <div>
                  <strong>{s.label}</strong>
                  <span>{s.url}</span>
                </div>
                <div className="torrent-source-actions">
                  <button
                    type="button"
                    className="ghost-btn control-btn"
                    disabled={browsingId === s.id}
                    onClick={() => void browseSource(s)}
                  >
                    {browsingId === s.id ? 'Loading…' : 'Browse'}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn control-btn"
                    disabled={syncingId === s.id}
                    onClick={() => {
                      setSyncingId(s.id)
                      void syncTorrentWebsite(s.id).finally(() => setSyncingId(null))
                    }}
                  >
                    {syncingId === s.id ? 'Syncing…' : 'Sync to shelves'}
                  </button>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => {
                      persistSources(sources.filter((x) => x.id !== s.id))
                      void deleteTorrentItemsForSource(s.id).then(() => reloadTorrentCatalog())
                      if (activeSourceId === s.id) {
                        setActiveSourceId(null)
                        setResults([])
                        setPageLinks([])
                        setPageHistory([])
                        setScrapeError(null)
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {streamError && <p className="toast toast-error">{streamError}</p>}
      {scrapeError && <p className="fine-print">{scrapeError}</p>}

      {autoInfo && <p className="fine-print">{autoInfo}</p>}
      {preparing && (
        <p className="fine-print">
          Connecting to peers and fetching metadata — this can take up to a minute…
        </p>
      )}

      {activeSource &&
        (results.length > 0 || pageLinks.length > 0 || browsingId === activeSource.id) && (
        <section>
          <div className="torrent-page-head">
            <div>
              <h2 className="torrent-results-heading">
                {browsingId === activeSource.id ? `Loading…` : pageTitle || activeSource.label}
              </h2>
              {pageUrl && <span>{pageUrl}</span>}
            </div>
            {pageHistory.length > 0 && (
              <button
                type="button"
                className="ghost-btn control-btn"
                disabled={Boolean(browsingId)}
                onClick={() => {
                  const previous = pageHistory[pageHistory.length - 1]
                  setPageHistory((history) => history.slice(0, -1))
                  void browsePage(previous, activeSource, false)
                }}
              >
                ← Back
              </button>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const query = pageQuery.trim()
              if (!query || !searchTemplate || browsingId) return
              void browsePage(buildSearchUrl(searchTemplate, query), activeSource)
            }}
          >
            <input
              className="search-input torrent-page-search"
              type="search"
              placeholder={
                searchTemplate
                  ? 'Type to filter this page — press Enter to search the whole site…'
                  : 'Search this page…'
              }
              value={pageQuery}
              onChange={(e) => setPageQuery(e.target.value)}
              aria-label="Search this site"
            />
          </form>
          {results.length > 0 && (
            <p className="fine-print">
              {filteredResults.length} playable link
              {filteredResults.length === 1 ? '' : 's'}
            </p>
          )}
          <ul className="torrent-results">
            {filteredResults.map((r) => (
              <li key={r.uri}>
                <div className="torrent-result-meta">
                  <strong>{r.title}</strong>
                  <span>
                    {formatSize(r.sizeBytes)}
                    {r.seeders > 0 ? ` · ${r.seeders} seeds` : ''} · {r.sourceLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={!desktop || Boolean(preparing)}
                  onClick={() => {
                    setAutoInfo(null)
                    const preference = getViewingQuality()
                    const requestedQuality = preference === 'auto' ? 720 : preference
                    const showKey = normalizeShowKey(r.title)
                    const sameShow = results.filter(
                      (row) => normalizeShowKey(row.title) === showKey,
                    )
                    const episodes = buildEpisodeChoices(
                      sameShow,
                      getConnectionDownlinkMbps(),
                      requestedQuality,
                    )
                    if (episodes.length > 1) {
                      const currentKey = parseEpisodeKey(r.title)
                      let startIndex = currentKey
                        ? episodes.findIndex((ep) => ep.key === currentKey)
                        : episodes.findIndex((ep) => ep.torrentUri === r.uri)
                      if (startIndex < 0) startIndex = 0
                      void streamTorrent(episodes[startIndex].torrentUri, r.title, {
                        episodePlaylist: episodes.map((ep) => ({
                          title: ep.title,
                          url: '',
                          torrentUri: ep.torrentUri,
                        })),
                        startIndex,
                      })
                      return
                    }
                    void streamTorrent(r.uri, r.title)
                  }}
                >
                  {preparing === r.uri ? 'Starting…' : 'Stream'}
                </button>
              </li>
            ))}
          </ul>
          {pageLinks.length > 0 && (
            <>
              <p className="fine-print">
                {filteredPageLinks.length} title{filteredPageLinks.length === 1 ? '' : 's'} — click
                one to start playing at the best quality for your connection
              </p>
              <div className="catalog-grid torrent-card-grid">
                {filteredPageLinks.map((link) => (
                  <button
                    key={link.url}
                    type="button"
                    className="media-card torrent-card"
                    disabled={Boolean(browsingId) || Boolean(preparing)}
                    title={link.title}
                    onClick={() => void openCard(link, activeSource)}
                  >
                    <div className="media-card-art">
                      {link.poster ? (
                        <img src={link.poster} alt="" loading="lazy" />
                      ) : (
                        <span className="media-card-fallback">{link.title.slice(0, 1)}</span>
                      )}
                    </div>
                    <div className="media-card-body">
                      <h3>{link.title}</h3>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
          {(prevPage || nextPage) && (
            <div className="torrent-pagination">
              <button
                type="button"
                className="ghost-btn"
                disabled={!prevPage || Boolean(browsingId)}
                onClick={() => prevPage && void browsePage(prevPage, activeSource)}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={!nextPage || Boolean(browsingId)}
                onClick={() => nextPage && void browsePage(nextPage, activeSource)}
              >
                Next →
              </button>
            </div>
          )}
        </section>
      )}

      <section className="torrent-magnet-paste">
        <h2>Have a link or page?</h2>
        <form className="guide-toolbar" onSubmit={streamPastedTorrent}>
          <input
            className="search-input guide-search"
            placeholder="Paste a link or page URL…"
            value={torrentDraft}
            onChange={(e) => setTorrentDraft(e.target.value)}
            aria-label="Link or page URL"
          />
          <button
            type="submit"
            className="primary-btn guide-toolbar-btn"
            disabled={!desktop || Boolean(preparing) || !torrentDraft.trim()}
          >
            {isTorrentInput(torrentDraft.trim()) ? 'Play' : 'Open page'}
          </button>
        </form>
      </section>

      {active.length > 0 && (
        <section className="torrent-active">
          <div className="torrent-sources-head">
            <h2>Active downloads</h2>
            <button type="button" className="ghost-btn" onClick={() => void stopAll()}>
              Stop all
            </button>
          </div>
          <ul className="torrent-results">
            {active.map((t) => (
              <li key={t.infoHash}>
                <div className="torrent-result-meta">
                  <strong>{t.name || t.infoHash}</strong>
                  <span>
                    {Math.round(t.progress * 100)}% · {formatSize(t.downloadSpeed)}/s ·{' '}
                    {t.numPeers} peers
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
