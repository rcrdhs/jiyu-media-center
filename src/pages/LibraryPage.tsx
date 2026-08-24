import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchPlaylistContent, useCatalog } from '../context/CatalogContext'
import { useEpg } from '../context/EpgContext'
import {
  clearActivityLog,
  formatActivityTime,
  listActivityLog,
  type ActivityEntry,
} from '../lib/activityLog'
import { buildXtreamPlaylistUrl, normalizeIptvPlaylistUrl, type IptvOutput } from '../lib/iptv'
import { probeStreamUrl } from '../lib/streamHealth'
import {
  ensurePerformanceProfile,
  getPerformanceMode,
  onPerformanceProfile,
  performanceModeLabel,
  setPerformanceMode,
  type PerformanceKnobs,
  type PerformanceMode,
} from '../lib/deviceProfile'
import {
  getRealDebridToken,
  REAL_DEBRID_TOKEN_URL,
  setRealDebridToken,
} from '../lib/debridSettings'
import {
  getViewingQuality,
  setViewingQuality,
  type ViewingQuality,
} from '../lib/viewingQuality'
import {
  hasKidsModePin,
  isKidsModeEnabled,
  setKidsModeEnabled,
  setKidsModePin,
  subscribeKidsMode,
  verifyKidsModePin,
} from '../lib/kidsMode'
import type { CategoryId, StreamHealthState } from '../types'
import { TorrentsPage } from './TorrentsPage'

const SECTIONS: { id: CategoryId; label: string }[] = [
  { id: 'sports', label: 'Sports' },
  { id: 'movies', label: 'Movies' },
  { id: 'anime', label: 'Anime' },
  { id: 'series', label: 'TV Series' },
  { id: 'news', label: 'News' },
  { id: 'kids', label: 'Kids' },
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
  const [debridToken, setDebridToken] = useState(getRealDebridToken)
  const [perfMode, setPerfMode] = useState<PerformanceMode>(getPerformanceMode)
  const [perfSummary, setPerfSummary] = useState('')
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [kidsPinDraft, setKidsPinDraft] = useState('')
  const [kidsPinConfirm, setKidsPinConfirm] = useState('')
  const [kidsUnlockPin, setKidsUnlockPin] = useState('')
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
  const [activity, setActivity] = useState<ActivityEntry[]>(() => listActivityLog())
  const fileRef = useRef<HTMLInputElement>(null)
  const [searchParams] = useSearchParams()

  useEffect(() => {
    if (searchParams.get('section') !== 'websites') return
    const el = document.getElementById('websites')
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [searchParams])

  useEffect(() => {
    const apply = (knobs: PerformanceKnobs) => setPerfSummary(knobs.summary)
    void ensurePerformanceProfile().then(apply)
    return onPerformanceProfile(apply)
  }, [])

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

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
        <h1>{kidsMode ? 'Kids mode lock' : 'Streams, IPTV & websites'}</h1>
        <p className="lede">
          {kidsMode
            ? 'Enter the PIN below to unlock Sports, Movies, and the rest of the library.'
            : 'Add M3U / IPTV sources and catalog websites — each stays active together. No need to replace the previous list.'}
        </p>
      </header>

      <div className="library-grid">
        <div className="library-side">
          <section className="panel">
            <h2>{kidsMode ? 'Exit Kids mode' : 'Preferences & EPG'}</h2>
            {!kidsMode && (
              <>
            <label className="field-label" htmlFor="performance-mode">
              Performance
            </label>
            <select
              id="performance-mode"
              className="url-input"
              value={perfMode}
              onChange={(event) => {
                const next = event.target.value as PerformanceMode
                setPerfMode(next)
                setPerformanceMode(next)
              }}
              aria-label="Performance mode for this device"
            >
              <option value="auto">{performanceModeLabel('auto')}</option>
              <option value="high">{performanceModeLabel('high')}</option>
              <option value="balanced">{performanceModeLabel('balanced')}</option>
              <option value="lite">{performanceModeLabel('lite')}</option>
            </select>
            {perfSummary ? (
              <p className="field-hint" style={{ marginTop: '0.35rem', opacity: 0.75 }}>
                {perfSummary}
              </p>
            ) : null}
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
                  raw === '480'
                    ? 480
                    : raw === '720'
                      ? 720
                      : raw === '1080'
                        ? 1080
                        : raw === '2160'
                          ? 2160
                          : 'auto'
                setQuality(next)
                setViewingQuality(next)
              }}
              aria-label="Preferred viewing quality"
            >
              <option value="auto">Auto (internet + device)</option>
              <option value="480">480p</option>
              <option value="720">720p</option>
              <option value="1080">1080p</option>
              <option value="2160">4K</option>
            </select>
            <p className="field-hint" style={{ marginTop: '0.35rem', opacity: 0.75 }}>
              Auto picks lower quality on slow connections (480p when available).
            </p>
            <label className="field-label" htmlFor="realdebrid-token">
              Real-Debrid API key{' '}
              <span className="optional-tag">optional · TV streams</span>
            </label>
            <input
              id="realdebrid-token"
              className="url-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste token from real-debrid.com/apitoken"
              value={debridToken}
              onChange={(event) => setDebridToken(event.target.value)}
              onBlur={() => {
                setRealDebridToken(debridToken)
                if (debridToken.trim()) reportOk('Real-Debrid key saved for TV streams')
                else reportOk('Real-Debrid key cleared — using peer torrents only')
              }}
              aria-label="Real-Debrid API key"
            />
            <p className="field-hint" style={{ marginTop: '0.35rem', opacity: 0.75 }}>
              When set, TV episodes try cached Torrentio debrid links first, then magnets.{' '}
              <a href={REAL_DEBRID_TOKEN_URL} target="_blank" rel="noreferrer">
                Get API key
              </a>
            </p>
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

            <h3 className="field-label" style={{ marginTop: '1.25rem' }}>
              Kids mode
            </h3>
            <p className="field-hint" style={{ marginTop: '0.25rem', opacity: 0.75 }}>
              Locks Browse to the Kids section (under 13). Set a PIN before turning it on so you
              can exit later.
            </p>
            <label className="field-label" htmlFor="kids-pin-set">
              PIN {hasKidsModePin() ? '(change)' : '(set)'}
            </label>
            <input
              id="kids-pin-set"
              className="url-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="4–8 digits"
              value={kidsPinDraft}
              onChange={(e) => setKidsPinDraft(e.target.value.replace(/\D/g, '').slice(0, 8))}
            />
            <label className="field-label" htmlFor="kids-pin-confirm">
              Confirm PIN
            </label>
            <input
              id="kids-pin-confirm"
              className="url-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Repeat PIN"
              value={kidsPinConfirm}
              onChange={(e) => setKidsPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 8))}
            />
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (kidsPinDraft.length < 4) {
                    reportErr(new Error('PIN must be at least 4 digits'))
                    return
                  }
                  if (kidsPinDraft !== kidsPinConfirm) {
                    reportErr(new Error('PIN confirmation does not match'))
                    return
                  }
                  setKidsModePin(kidsPinDraft)
                  setKidsPinDraft('')
                  setKidsPinConfirm('')
                  reportOk('Kids mode PIN saved')
                }}
              >
                Save PIN
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (!hasKidsModePin() && kidsPinDraft.length < 4) {
                    reportErr(new Error('Set a 4–8 digit PIN first'))
                    return
                  }
                  if (kidsPinDraft.length >= 4) {
                    if (kidsPinDraft !== kidsPinConfirm) {
                      reportErr(new Error('PIN confirmation does not match'))
                      return
                    }
                    setKidsModePin(kidsPinDraft)
                    setKidsPinDraft('')
                    setKidsPinConfirm('')
                  }
                  setKidsModeEnabled(true)
                  reportOk('Kids mode on — Browse locked to Kids')
                }}
              >
                Turn Kids mode on
              </button>
            </div>
            <label className="field-label" htmlFor="epg-url">
              EPG / XMLTV URL(s)
            </label>
            <form
              className="iptv-form"
              onSubmit={(e) => {
                e.preventDefault()
                setManualUrl(epgDraft)
                void refreshEpg(epgDraft.trim() || undefined).then(() => {
                  if (epgDraft.trim()) reportOk('EPG URL saved — guide refreshing')
                  else reportOk('Manual EPG cleared — using built-in US/JM guides')
                })
              }}
            >
              <textarea
                id="epg-url"
                className="url-input"
                rows={3}
                placeholder="https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz"
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
                : ' · built-in US + Jamaica XMLTV when blank'}
              {epgData ? ` · ${epgData.programmes.length.toLocaleString()} programmes` : ''}
              . One URL per line, or comma-separated.
            </p>
            {epgError && <p className="toast toast-error">{epgError}</p>}
              </>
            )}
            {kidsMode && (
              <>
                <p className="fine-print" style={{ marginTop: '0.5rem' }}>
                  Kids mode is on. Enter the PIN to unlock the full app.
                </p>
                <label className="field-label" htmlFor="kids-unlock-pin">
                  PIN to exit
                </label>
                <input
                  id="kids-unlock-pin"
                  className="url-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="4–8 digits"
                  value={kidsUnlockPin}
                  onChange={(e) => setKidsUnlockPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    if (!verifyKidsModePin(kidsUnlockPin)) {
                      reportErr(new Error('Wrong PIN'))
                      return
                    }
                    setKidsModeEnabled(false)
                    setKidsUnlockPin('')
                    reportOk('Kids mode off — full library unlocked')
                  }}
                >
                  Exit Kids mode
                </button>
              </>
            )}
          </section>

          {!kidsMode && (
          <>
          <section className="panel library-activity-panel">
            <details
              className="library-activity"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) {
                  setActivity(listActivityLog())
                }
              }}
            >
              <summary>Activity log</summary>
              <p className="fine-print library-privacy-note">
                Jiyu does not ship analytics or ad trackers. Catalog sync messages are masked so
                shelves never show origin sites. Torrent playback may still contact BitTorrent
                trackers listed inside a magnet (normal peer discovery — not app telemetry).
              </p>
              {activity.length === 0 ? (
                <p className="fine-print">No activity recorded yet.</p>
              ) : (
                <ul className="activity-log-list">
                  {activity.map((entry) => (
                    <li key={entry.id}>
                      <time dateTime={new Date(entry.at).toISOString()}>
                        {formatActivityTime(entry.at)}
                      </time>
                      <span className={`activity-kind activity-kind-${entry.kind}`}>
                        {entry.kind}
                      </span>
                      <span>{entry.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {activity.length > 0 && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    clearActivityLog()
                    setActivity([])
                  }}
                >
                  Clear log
                </button>
              )}
            </details>
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
          </>
          )}
          {kidsMode && (message || error) && (
            <section className="panel">
              {message && <p className="toast">{message}</p>}
              {error && <p className="toast toast-error">{error}</p>}
            </section>
          )}
        </div>

        {!kidsMode && (
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
        )}
      </div>

      {!kidsMode && (
        <section className="panel library-websites-panel">
          <TorrentsPage embedded />
        </section>
      )}
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
