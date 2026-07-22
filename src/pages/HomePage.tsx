import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORIES, LOCAL_CHANNELS, resolveLocalChannels } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { LocalChannelLive } from '../components/LocalChannelLive'
import { LocalYoutubeLiveNow } from '../components/LocalYoutubeLiveNow'
import { isLikelyEnglish, shouldApplyEnglishFilter } from '../lib/language'
import { VOD_CATEGORIES } from '../lib/continueWatching'

export function HomePage() {
  const { byCategory, items, importedCount, englishOnly } = useCatalog()
  const { item: playingItem, mode } = usePlayback()
  const [homeQuery, setHomeQuery] = useState('')

  const localChannels = useMemo(() => resolveLocalChannels(items), [items])
  const tvjChannel = localChannels[0] ?? LOCAL_CHANNELS[0]
  const tvjPlayingElsewhere = playingItem?.id === tvjChannel.id && mode !== 'off'

  const searchHits = useMemo(() => {
    const q = homeQuery.trim().toLowerCase()
    if (!q) return []
    return items
      .filter((item) => {
        if (englishOnly && shouldApplyEnglishFilter(item.category) && !isLikelyEnglish(item)) {
          return false
        }
        return (
          item.title.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.tags?.some((t) => t.toLowerCase().includes(q))
        )
      })
      .slice(0, 48)
  }, [items, homeQuery, englishOnly])

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Freedom to watch · your way</p>
          <h1>Jiyu</h1>
          <p className="lede">
            Browse Sports, Movies, Anime, Series, and News — click a title, play the stream.
            Import M3U playlists for live TV and VOD you already have access to.
          </p>
          <div className="home-search-wrap">
            <label className="sr-only" htmlFor="home-search">
              Search
            </label>
            <input
              id="home-search"
              className="search-input home-search"
              type="search"
              placeholder="Search channels, movies, news…"
              value={homeQuery}
              onChange={(e) => setHomeQuery(e.target.value)}
            />
          </div>
          <div className="hero-actions">
            <Link className="primary-btn" to="/browse">
              Browse sources
            </Link>
            <Link className="ghost-btn" to="/library">
              Import playlist
            </Link>
          </div>
        </div>
        <div className="hero-panel" aria-hidden>
          <div className="hero-glow" />
          <div className="hero-frame">
            <span>Live</span>
            <strong>{items.length}</strong>
            <em>titles ready{importedCount > 0 ? ` · ${importedCount} imported` : ''}</em>
          </div>
        </div>
      </header>

      {!homeQuery.trim() &&
        VOD_CATEGORIES.map((category) => (
          <ContinueWatching key={category} category={category} />
        ))}

      {homeQuery.trim() && (
        <section className="section-block">
          <div className="section-head">
            <h2>Search results</h2>
            <p>
              {searchHits.length.toLocaleString()} match{searchHits.length === 1 ? '' : 'es'} for “
              {homeQuery.trim()}”
            </p>
          </div>
          <CatalogGrid
            items={searchHits}
            autoCheck
            showToolbar={false}
            emptyHint="Nothing matched. Try another word or browse sources."
          />
        </section>
      )}

      <section className="section-block">
        <div className="section-head">
          <h2>Sections</h2>
          <p>Pick a shelf — each one opens streams mapped to that category.</p>
        </div>
        <div className="section-tiles">
          {CATEGORIES.map((cat) => {
            const count = byCategory(cat.id).length
            return (
              <Link
                key={cat.id}
                to={`/section/${cat.id}`}
                className="section-tile"
                style={{ ['--accent' as string]: cat.accent }}
              >
                <h3>{cat.label}</h3>
                <p>{cat.blurb}</p>
                <span>
                  {count} stream{count === 1 ? '' : 's'}
                </span>
              </Link>
            )
          })}
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2>Local channel</h2>
          <p>TVJ live now — CVM and Nationwide appear here when they’re live on YouTube.</p>
        </div>
        {!tvjPlayingElsewhere ? (
          <LocalChannelLive item={tvjChannel} />
        ) : (
          <p className="fine-print local-channel-note">
            TVJ is playing in the corner — browse or search for another stream below.
          </p>
        )}
        <LocalYoutubeLiveNow />
        <CatalogGrid items={localChannels} autoCheck showToolbar autoHideUnresponsive={false} />
      </section>
    </div>
  )
}
