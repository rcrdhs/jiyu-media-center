import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchPlaylistContent, useCatalog } from '../context/CatalogContext'
import { useEpg } from '../context/EpgContext'
import { buildXtreamPlaylistUrl, normalizeIptvPlaylistUrl, type IptvOutput } from '../lib/iptv'
import { probeStreamUrl } from '../lib/streamHealth'
import {
  getViewingQuality,
  setViewingQuality,
  type ViewingQuality,
} from '../lib/viewingQuality'
import type { CategoryId, StreamHealthState } from '../types'
import { TorrentsPage } from './TorrentsPage'

const SECTIONS: { id: CategoryId; label: string }[] = [
  { id: 'sports', label: 'Sports' },
  { id: 'movies', label: 'Movies' },
  { id: 'anime', label: 'Anime' },
  { id: 'series', label: 'TV Series' },
  { id: 'news', label: 'News' },
]

export function LibraryPage() {
  const {
    ready,
    addPlaylist,
    importedCount,
    clearImported,
    byCategory,
    sources,
    removeSource,
    refreshSource,
    refreshAllRemote,
    hideDuplicates,
    setHideDuplicates,
    englishOnly,
    setEnglishOnly,
  } = useCatalog()
  const {
    manualUrl,
    setManualUrl,
    discoveredUrls,
    activeUrl,
    refresh: refreshEpg,
    loading: epgLoading,
    error: epgError,
    data: epgData,
  } = useEpg()
  const [quality, setQuality] = useState<ViewingQuality>(getViewingQuality)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [remoteUrls, setRemoteUrls] = useState('')
  const [epgDraft, setEpgDraft] = useState(manualUrl)
  const [iptvServer, setIptvServer] = useState('')
  const [iptvUser, setIptvUser] = useState('')
  const [iptvPass, setIptvPass] = useState('')
  const [iptvOutput, setIptvOutput] = useState<IptvOutput>('hls')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [sourceHealth, setSourceHealth] = useState<Record<string, StreamHealthState>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const [searchParams] = useSearchParams()

  useEffect(() => {
    if (searchParams.get('section') !== 'websites') return
    const el = document.getElementById('websites')
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [searchParams])

  function reportOk(text: string) {
    setError(null)
    setMessage(text)
  }

  function reportErr(err: unknown) {
    setMessage(null)
    setError(err instanceof Error ? err.message : String(err))
  }

  async function importRemote(url: string, kind: 'url' | 'iptv', label: string) {
    const normalized = normalizeIptvPlaylistUrl(url)
    const content = await fetchPlaylistContent(normalized)
    if (!looksLikePlaylist(content)) {
      throw new Error(`Not a playlist: ${normalized}`)
    }
    return addPlaylist({ kind, label, url: normalized, content })
  }

  async function importFromDesktop() {
    if (!window.signalDesktop?.openPlaylist) {
      fileRef.current?.click()
      return
    }
    const result = await window.signalDesktop.openPlaylist()
    if (!result?.files?.length) return
    setBusy(true)
    try {
      let total = 0
      for (let i = 0; i < result.files.length; i++) {
        const file = result.files[i]
        setProgress(`File ${i + 1}/${result.files.length}`)
        total += await addPlaylist({
          kind: 'file',
          label: file.path.split(/[/\\]/).pop() || file.path,
          content: file.content,
        })
      }
      reportOk(
        `Added ${total.toLocaleString()} streams from ${result.files.length.toLocaleString()} file(s) · ${sources.length + result.files.length} source(s) total`,
      )
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setBusy(true)
    try {
      let total = 0
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setProgress(`File ${i + 1}/${files.length}`)
        const text = await file.text()
        total += await addPlaylist({
          kind: 'file',
          label: file.name,
          content: text,
        })
      }
      reportOk(`Added ${total.toLocaleString()} streams from ${files.length.toLocaleString()} file(s)`)
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
      setProgress(null)
      e.target.value = ''
    }
  }

  async function onPasteImport() {
    if (!paste.trim()) return
    setBusy(true)
    try {
      const count = await addPlaylist({
        kind: 'paste',
        label: `Paste ${new Date().toLocaleString()}`,
        content: paste,
      })
      reportOk(`Added ${count.toLocaleString()} streams from pasted playlist`)
      setPaste('')
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
    }
  }

  async function onUrlImport(e?: FormEvent) {
    e?.preventDefault()
    const urls = parseUrlList(remoteUrls)
    if (urls.length === 0) return
    setBusy(true)
    let total = 0
    let ok = 0
    const failures: string[] = []
    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        setProgress(`Link ${i + 1}/${urls.length}`)
        try {
          total += await importRemote(url, 'url', url)
          ok++
        } catch (err) {
          failures.push(`${url} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (ok > 0) {
        reportOk(
          `Added/updated ${ok.toLocaleString()} playlist link${ok === 1 ? '' : 's'} (${total.toLocaleString()} streams). Sources stack — keep adding more anytime.`,
        )
        setRemoteUrls('')
      }
      if (failures.length > 0) {
        setError(`Failed ${failures.length}: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`)
        if (ok === 0) setMessage(null)
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function onXtreamImport(e?: FormEvent) {
    e?.preventDefault()
    if (!iptvServer.trim()) return
    setBusy(true)
    setProgress('Fetching IPTV playlist…')
    try {
      const playlistUrl = buildXtreamPlaylistUrl({
        server: iptvServer,
        username: iptvUser,
        password: iptvPass,
        output: iptvOutput,
      })
      const userBit = iptvUser.trim() ? `${iptvUser.trim()}@` : ''
      const label = `IPTV ${userBit}${iptvServer.trim()}`
      const count = await importRemote(playlistUrl, 'iptv', label)
      reportOk(
        `Added IPTV source (${count.toLocaleString()} channels). Add another anytime — they all stay active.`,
      )
      setIptvPass('')
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function onRefresh(id: string) {
    setBusy(true)
    try {
      const count = await refreshSource(id)
      reportOk(`Refreshed — ${count.toLocaleString()} streams`)
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
    }
  }

  async function onRefreshAll() {
    setBusy(true)
    setProgress('Refreshing all remote playlists…')
    try {
      const result = await refreshAllRemote()
      reportOk(
        `Refreshed ${result.refreshed} source(s) (${result.totalStreams.toLocaleString()} streams)${result.failed ? ` · ${result.failed} failed` : ''}`,
      )
    } catch (err) {
      reportErr(err)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function onCheckSource(id: string, url?: string) {
    if (!url) return
    setSourceHealth((prev) => ({ ...prev, [id]: 'checking' }))
    try {
      const result = await probeStreamUrl(url)
      setSourceHealth((prev) => ({ ...prev, [id]: result.state }))
      reportOk(
        result.ok
          ? `Playlist reachable (${result.latencyMs}ms)`
          : `Playlist check failed: ${result.error || result.state}`,
      )
    } catch (err) {
      setSourceHealth((prev) => ({ ...prev, [id]: 'offline' }))
      reportErr(err)
    }
  }

  const remoteSourceCount = sources.filter((s) => s.url).length
  const urlCount = parseUrlList(remoteUrls).length

  return (
    <div className="page">
      <header className="page-header">
        <p className="eyebrow">Library</p>
        <h1>Streams, IPTV &amp; websites</h1>
        <p className="lede">
          Add M3U / IPTV sources and catalog websites — each stays active together. No need to
          replace the previous list.
        </p>
      </header>

      <div className="library-grid">
        <div className="library-side">
          <section className="panel">
            <h2>Preferences &amp; EPG</h2>
            <label className="field-label" htmlFor="viewing-quality">
              Viewing quality
            </label>
            <select
              id="viewing-quality"
              className="url-input"
              value={quality === 'auto' ? 'auto' : String(quality)}
              onChange={(event) => {
                const raw = event.target.value
                const next: ViewingQuality =
                  raw === '720' ? 720 : raw === '1080' ? 1080 : raw === '2160' ? 2160 : 'auto'
                setQuality(next)
                setViewingQuality(next)
              }}
              aria-label="Preferred viewing quality"
            >
              <option value="auto">Auto (internet speed)</option>
              <option value="720">720p</option>
              <option value="1080">1080p</option>
              <option value="2160">4K</option>
            </select>
            <label className="check-toggle">
              <input
                type="checkbox"
                checked={englishOnly}
                onChange={(e) => setEnglishOnly(e.target.checked)}
              />
              English only
              <span className="optional-tag">except Anime</span>
            </label>
            <label className="check-toggle">
              <input
                type="checkbox"
                checked={hideDuplicates}
                onChange={(e) => setHideDuplicates(e.target.checked)}
              />
              Hide duplicates
            </label>
            <p className="fine-print">
              Collapses same-title / same-URL entries across playlists (default on).
            </p>
            <label className="field-label" htmlFor="epg-url">
              EPG / XMLTV URL
            </label>
            <form
              className="iptv-form"
              onSubmit={(e) => {
                e.preventDefault()
                setManualUrl(epgDraft)
                void refreshEpg(epgDraft.trim() || undefined).then(() => {
                  if (epgDraft.trim()) reportOk('EPG URL saved — guide refreshing')
                  else reportOk('Manual EPG URL cleared')
                })
              }}
            >
              <input
                id="epg-url"
                className="url-input"
                type="url"
                placeholder="https://example.com/epg.xml"
                value={epgDraft}
                onChange={(e) => setEpgDraft(e.target.value)}
                spellCheck={false}
              />
              <div className="hero-actions">
                <button type="submit" className="primary-btn" disabled={epgLoading}>
                  {epgLoading ? 'Loading…' : 'Save & load'}
                </button>
              </div>
            </form>
            <p className="fine-print">
              Active: {activeUrl || 'none'}
              {discoveredUrls.length > 0
                ? ` · ${discoveredUrls.length} url-tvg from playlists`
                : ''}
              {epgData ? ` · ${epgData.programmes.length.toLocaleString()} programmes` : ''}
            </p>
            {epgError && <p className="toast toast-error">{epgError}</p>}
          </section>

          <section className="panel">
            <h2>Shelf counts</h2>
            <ul className="count-list">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <span>{s.label}</span>
                  <strong>{byCategory(s.id).length.toLocaleString()}</strong>
                </li>
              ))}
              <li>
                <span>Imported total</span>
                <strong>{importedCount.toLocaleString()}</strong>
              </li>
              <li>
                <span>Active sources</span>
                <strong>{sources.length.toLocaleString()}</strong>
              </li>
            </ul>

            <div className="sources-head">
              <h2>Sources ({sources.length})</h2>
              <div className="sources-head-actions">
                {remoteSourceCount > 0 && (
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={busy}
                    onClick={() => void onRefreshAll()}
                  >
                    Refresh all remote
                  </button>
                )}
                {importedCount > 0 && (
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={busy}
                    onClick={() => {
                      void clearImported().then(() => reportOk('Cleared all imported sources'))
                    }}
                  >
                    Clear {importedCount.toLocaleString()} imported
                  </button>
                )}
              </div>
            </div>
            {sources.length === 0 ? (
              <p className="fine-print">
                No imported sources yet. Add several links above — they all stack.
              </p>
            ) : (
              <ul className="source-list">
                {sources.map((source) => (
                  <li key={source.id}>
                    <div>
                      <strong title={source.label}>{source.label}</strong>
                      <span>
                        {source.kind.toUpperCase()} · {source.itemCount.toLocaleString()} entries
                        {sourceHealth[source.id] ? ` · ${sourceHealth[source.id]}` : ''}
                      </span>
                    </div>
                    <div className="source-actions">
                      {source.url && (
                        <>
                          <button
                            type="button"
                            className="text-btn"
                            disabled={busy || sourceHealth[source.id] === 'checking'}
                            onClick={() => void onCheckSource(source.id, source.url)}
                          >
                            Check
                          </button>
                          <button
                            type="button"
                            className="text-btn"
                            disabled={busy}
                            onClick={() => void onRefresh(source.id)}
                          >
                            Refresh
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="text-btn"
                        disabled={busy}
                        onClick={() =>
                          void removeSource(source.id).then(() => reportOk('Removed source'))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine-print">
              Use only IPTV services and streams you subscribe to or otherwise have the right to
              watch.
            </p>
          </section>
        </div>

        <section className="panel library-import">
          <h2>IPTV providers</h2>
          <p>
            Enter a panel host, open playlist URL, or <code>get.php</code> link. Username and
            password are optional — leave them blank for no-auth / public M3U sources.
          </p>
          <form className="iptv-form" onSubmit={onXtreamImport}>
            <label className="field-label" htmlFor="iptv-server">
              Server or playlist URL
            </label>
            <input
              id="iptv-server"
              className="url-input"
              placeholder="http://host:port · or https://example.com/list.m3u"
              value={iptvServer}
              onChange={(e) => setIptvServer(e.target.value)}
              disabled={busy || !ready}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="iptv-creds">
              <div>
                <label className="field-label" htmlFor="iptv-user">
                  Username <span className="optional-tag">(optional)</span>
                </label>
                <input
                  id="iptv-user"
                  className="url-input"
                  placeholder="Optional"
                  value={iptvUser}
                  onChange={(e) => setIptvUser(e.target.value)}
                  disabled={busy || !ready}
                  autoComplete="username"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="iptv-pass">
                  Password <span className="optional-tag">(optional)</span>
                </label>
                <input
                  id="iptv-pass"
                  type="password"
                  className="url-input"
                  placeholder="Optional"
                  value={iptvPass}
                  onChange={(e) => setIptvPass(e.target.value)}
                  disabled={busy || !ready}
                  autoComplete="current-password"
                />
              </div>
            </div>
            <label className="field-label" htmlFor="iptv-output">
              Stream output
            </label>
            <select
              id="iptv-output"
              className="url-input"
              value={iptvOutput}
              onChange={(e) => setIptvOutput(e.target.value as IptvOutput)}
              disabled={busy || !ready}
            >
              <option value="hls">HLS (.m3u8) — best for this app</option>
              <option value="ts">MPEG-TS — classic IPTV</option>
            </select>
            <button
              type="submit"
              className="primary-btn"
              disabled={busy || !ready || !iptvServer.trim()}
            >
              {busy ? 'Working…' : 'Add IPTV source'}
            </button>
          </form>

          <h2>Multiple playlist URLs</h2>
          <p>
            Paste one or many M3U / M3U+ / <code>get.php</code> links — <strong>one URL per line</strong>.
            All of them are imported and kept as separate sources.
          </p>
          <form className="iptv-form" onSubmit={onUrlImport}>
            <label className="field-label" htmlFor="remote-urls">
              Playlist links
            </label>
            <textarea
              id="remote-urls"
              className="paste-box"
              rows={6}
              placeholder={[
                'https://example.com/playlist1.m3u',
                'https://example.com/playlist2.m3u8',
                'http://host:port/get.php?username=u&password=p&type=m3u_plus&output=hls',
              ].join('\n')}
              value={remoteUrls}
              onChange={(e) => setRemoteUrls(e.target.value)}
              disabled={busy || !ready}
              spellCheck={false}
            />
            <button type="submit" className="primary-btn" disabled={busy || !ready || urlCount === 0}>
              {busy
                ? progress || 'Working…'
                : `Add ${urlCount || ''} link${urlCount === 1 ? '' : 's'}`.replace(/\s+/g, ' ').trim()}
            </button>
          </form>

          <h2>Files or paste</h2>
          <p>Select multiple .m3u files at once, or paste playlist body text. Each appends as another source.</p>
          <div className="hero-actions">
            <button type="button" className="primary-btn" onClick={importFromDesktop} disabled={busy || !ready}>
              Choose playlist file(s)
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain,*/*"
            className="sr-only"
            onChange={onFileChange}
          />
          <label className="field-label" htmlFor="paste-m3u">
            Paste playlist text
          </label>
          <textarea
            id="paste-m3u"
            className="paste-box"
            rows={8}
            placeholder={'#EXTM3U\n#EXTINF:-1 tvg-logo="" group-title="Sports",Example HD\nhttp://example.com/live/user/pass/1'}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            disabled={busy}
          />
          <button type="button" className="ghost-btn" onClick={onPasteImport} disabled={busy || !paste.trim()}>
            Import paste
          </button>
          {progress && <p className="toast">{progress}</p>}
          {message && <p className="toast">{message}</p>}
          {error && <p className="toast toast-error">{error}</p>}
        </section>
      </div>

      <section className="panel library-websites-panel">
        <TorrentsPage embedded />
      </section>
    </div>
  )
}

function parseUrlList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Allow "label | url" or bare url
    const maybeUrl = trimmed.includes('|') ? trimmed.split('|').pop()!.trim() : trimmed
    if (!/^https?:\/\//i.test(maybeUrl) && !/^[a-z0-9.-]+:\d+/i.test(maybeUrl) && !maybeUrl.includes('/')) {
      continue
    }
    const normalized = normalizeIptvPlaylistUrl(maybeUrl)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function looksLikePlaylist(content: string): boolean {
  const head = content.slice(0, 4000)
  return (
    /#EXTM3U/i.test(head) ||
    /#EXTINF:/i.test(head) ||
    /^https?:\/\//im.test(head)
  )
}
