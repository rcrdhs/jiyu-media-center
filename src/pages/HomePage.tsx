import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORIES, LOCAL_CHANNELS, resolveLocalChannels } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { WatchHistory } from '../components/WatchHistory'
import { LocalChannelLive } from '../components/LocalChannelLive'
import { LocalYoutubeLiveNow } from '../components/LocalYoutubeLiveNow'
import { isLikelyEnglish, shouldApplyEnglishFilter } from '../lib/language'
import { VOD_CATEGORIES } from '../lib/continueWatching'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import {
  getCatalogGrowth,
  recordCatalogTitleCount,
  type SectionGrowth,
} from '../lib/libraryGrowth'

export function HomePage() {
  const { byCategory, items, ready, englishOnly } = useCatalog()
  const { item: playingItem, mode } = usePlayback()
  const [homeQuery, setHomeQuery] = useState('')
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [catalogGrowth, setCatalogGrowth] = useState<SectionGrowth>(() =>
    getCatalogGrowth(items.length),
  )

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  const homeCategories = useMemo(
    () => (kidsMode ? CATEGORIES.filter((cat) => cat.id === 'kids') : CATEGORIES),
    [kidsMode],
  )
  const homeVodCategories = useMemo(
    () => (kidsMode ? VOD_CATEGORIES.filter((id) => id === 'kids') : VOD_CATEGORIES),
    [kidsMode],
  )

  useEffect(() => {
    if (!ready) return
    // Wait for the catalog to finish the daily load/sync before snapshotting,
    // so a partial cold start isn't stored as today's baseline.
    const timer = window.setTimeout(() => {
      setCatalogGrowth(recordCatalogTitleCount(items.length))
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [ready, items.length])

  const localChannels = useMemo(() => resolveLocalChannels(items), [items])
  const tvjChannel = localChannels.find((c) => c.id === 'local-tvj') ?? LOCAL_CHANNELS[0]
  const cvmChannel = localChannels.find((c) => c.id === 'local-cvm') ?? LOCAL_CHANNELS[1]
  const tvjPlayingElsewhere = playingItem?.id === tvjChannel.id && mode !== 'off'
  const cvmPlayingElsewhere = playingItem?.id === cvmChannel.id && mode !== 'off'

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
            {kidsMode
              ? 'Kids mode is on — curated movies, shows, and live channels for under 13.'
              : 'Browse Sports, Movies, Anime, Series, News, and Kids — click a title, play the stream. Import M3U playlists for live TV and VOD you already have access to.'}
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
        </div>
        <div className="hero-panel" aria-hidden>
          <div className="hero-glow" />
          <div className="hero-frame">
            <span>Total titles</span>
            <strong>{catalogGrowth.today.toLocaleString()}</strong>
            <em>
              Added today{' '}
              {catalogGrowth.newToday > 0
                ? catalogGrowth.newToday.toLocaleString()
                : '0'}
            </em>
          </div>
        </div>
      </header>

      {!homeQuery.trim() &&
        homeVodCategories.map((category) => (
          <ContinueWatching key={category} category={category} />
        ))}

      {!homeQuery.trim() && !kidsMode && <WatchHistory />}

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
          {homeCategories.map((cat) => {
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

      {!kidsMode && (
        <section className="section-block">
          <div className="section-head">
            <h2>Local channels</h2>
          </div>
          {(tvjPlayingElsewhere || cvmPlayingElsewhere) && (
            <p className="fine-print local-channel-note">
              {(tvjPlayingElsewhere ? tvjChannel.title : cvmChannel.title) +
                ' is playing in the corner — browse or search for another stream below.'}
            </p>
          )}
          {(!tvjPlayingElsewhere || !cvmPlayingElsewhere) && (
            <div className="local-channel-live-row">
              {!tvjPlayingElsewhere && <LocalChannelLive item={tvjChannel} />}
              {!cvmPlayingElsewhere && <LocalChannelLive item={cvmChannel} />}
            </div>
          )}
          <LocalYoutubeLiveNow />
          <CatalogGrid items={localChannels} autoCheck showToolbar autoHideUnresponsive={false} />
        </section>
      )}
    </div>
  )
}
