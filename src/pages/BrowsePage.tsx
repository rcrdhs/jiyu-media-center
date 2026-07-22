import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { fetchPlaylistContent, useCatalog } from '../context/CatalogContext'
import { normalizeIptvPlaylistUrl } from '../lib/iptv'

/** Starter prompts — user pastes their own licensed / public playlist URLs */
const DISCOVER_HINTS = [
  {
    title: 'Xtream / get.php panel',
    blurb: 'Paste a host or full get.php URL in Library, with or without credentials.',
    example: 'http://host:port/get.php?type=m3u_plus&output=hls',
  },
  {
    title: 'Direct M3U / M3U8 file',
    blurb: 'Any https link ending in .m3u or .m3u8 that you are allowed to use.',
    example: 'https://example.com/channels.m3u',
  },
  {
    title: 'Multi-link paste',
    blurb: 'In Library, add several playlist URLs at once — one per line.',
    example: 'Library → Multiple playlist URLs',
  },
]

export function BrowsePage() {
  const { items, sources, addPlaylist, ready } = useCatalog()
  const [query, setQuery] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 40)
    return items
      .filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.tags?.some((t) => t.toLowerCase().includes(q)) ||
          item.source?.toLowerCase().includes(q),
      )
      .slice(0, 80)
  }, [items, query])

  async function onQuickAdd(e: FormEvent) {
    e.preventDefault()
    const url = normalizeIptvPlaylistUrl(urlDraft.trim())
    if (!url) return
    setBusy(true)
    setError(null)
    try {
      const content = await fetchPlaylistContent(url)
      const count = await addPlaylist({
        kind: /get\.php|username=/i.test(url) ? 'iptv' : 'url',
        label: url,
        url,
        content,
      })
      setMessage(`Added ${count.toLocaleString()} streams from playlist`)
      setUrlDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMessage(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <p className="eyebrow">Discover</p>
        <h1>Browse sources</h1>
        <p className="lede">
          Search channels already in Jiyu, add more M3U / IPTV playlist links, and jump to Library for
          multi-import. Use only playlists you have the right to access.
        </p>
      </header>

      <section className="panel browse-search-panel">
        <label className="field-label" htmlFor="browse-search">
          Search your catalog
        </label>
        <input
          id="browse-search"
          className="search-input browse-search"
          type="search"
          placeholder="Channel, group, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="fine-print">
          {matches.length.toLocaleString()} result{matches.length === 1 ? '' : 's'}
          {sources.length > 0 ? ` · ${sources.length} playlist source${sources.length === 1 ? '' : 's'}` : ''}
        </p>
        <div className="browse-results">
          {matches.map((item) => (
            <Link key={item.id} to={`/watch/${item.id}`} className="browse-result">
              <strong>{item.title}</strong>
              <span>
                {item.category} · {item.description}
              </span>
            </Link>
          ))}
          {matches.length === 0 && <p className="empty-state">No channels match that search.</p>}
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>Add a playlist link</h2>
          <p>Drop in one M3U / IPTV URL to expand your shelves.</p>
        </div>
        <form className="url-form" onSubmit={onQuickAdd}>
          <input
            type="url"
            className="url-input"
            placeholder="https://…/playlist.m3u or get.php?…"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            disabled={busy || !ready}
          />
          <button type="submit" className="primary-btn" disabled={busy || !ready || !urlDraft.trim()}>
            {busy ? 'Adding…' : 'Add link'}
          </button>
        </form>
        {message && <p className="toast">{message}</p>}
        {error && <p className="toast toast-error">{error}</p>}
        <div className="hero-actions" style={{ marginTop: '1rem' }}>
          <Link className="ghost-btn" to="/library">
            Open Library for multi-URL & IPTV providers
          </Link>
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>How to find more</h2>
          <p>Common ways people wire legal or subscribed sources into Jiyu.</p>
        </div>
        <div className="section-tiles browse-hints">
          {DISCOVER_HINTS.map((hint) => (
            <article key={hint.title} className="section-tile" style={{ ['--accent' as string]: '#f0b429' }}>
              <h3>{hint.title}</h3>
              <p>{hint.blurb}</p>
              <span>{hint.example}</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
