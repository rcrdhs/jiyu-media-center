import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORIES, LOCAL_CHANNELS, resolveLocalChannels } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { RecommendedShelf } from '../components/RecommendedShelf'
import { NewTitlesDialog } from '../components/NewTitlesDialog'
import { WatchNextStrip } from '../components/WatchNextStrip'
import { WatchHistory } from '../components/WatchHistory'
import { LocalChannelLive } from '../components/LocalChannelLive'
import { filterShelfVisibleItems, isSeriesWebCatalogItem } from '../lib/torrents'
import { isLikelyEnglish, shouldApplyEnglishFilter } from '../lib/language'
import { VOD_CATEGORIES } from '../lib/continueWatching'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import {
  getCatalogGrowth,
  recordCatalogTitleCount,
  type SectionGrowth,
} from '../lib/libraryGrowth'
import { catalogNewTitleItems } from '../lib/newTitlesList'
import {
  favoriteTeamMatches,
  readFavoriteTeams,
  subscribeFavoriteTeams,
} from '../lib/favoriteTeams'

export function HomePage() {
  const { byCategory, items, ready, englishOnly } = useCatalog()
  const { item: playingItem, mode } = usePlayback()
  const [homeQuery, setHomeQuery] = useState('')
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [catalogGrowth, setCatalogGrowth] = useState<SectionGrowth>(() =>
    getCatalogGrowth(items.length),
  )
  const [newTitlesOpen, setNewTitlesOpen] = useState(false)
  const [favoriteTeams, setFavoriteTeams] = useState(readFavoriteTeams)

  useEffect(() => subscribeFavoriteTeams(() => setFavoriteTeams(readFavoriteTeams())), [])

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
      setCatalogGrowth(
        recordCatalogTitleCount(
          items.length,
          items.map((item) => ({ id: item.id, releasedAt: item.releasedAt })),
        ),
      )
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [ready, items.length, items])

  const newTodayItems = useMemo(
    () => catalogNewTitleItems(items, 'today', catalogGrowth.newToday),
    [items, catalogGrowth.newToday],
  )

  const localChannels = useMemo(() => resolveLocalChannels(items), [items])
  const tvjChannel = localChannels.find((c) => c.id === 'local-tvj') ?? LOCAL_CHANNELS[0]
  const cvmChannel = localChannels.find((c) => c.id === 'local-cvm') ?? LOCAL_CHANNELS[1]
  const nationwideChannel =
    localChannels.find((c) => c.id === 'local-nationwide') ?? LOCAL_CHANNELS[2]
  const tvjPlayingElsewhere = playingItem?.id === tvjChannel.id && mode !== 'off'
  const cvmPlayingElsewhere = playingItem?.id === cvmChannel.id && mode !== 'off'
  const nationwidePlayingElsewhere =
    playingItem?.id === nationwideChannel.id && mode !== 'off'

  const favoriteMatches = useMemo(
    () => (kidsMode ? [] : favoriteTeamMatches(items, favoriteTeams)),
    [items, favoriteTeams, kidsMode],
  )

  const searchHits = useMemo(() => {
    const q = homeQuery.trim().toLowerCase()
    if (!q) return []
    return filterShelfVisibleItems(items)
      .filter((item) => {
        if (item.category === 'series' && !isSeriesWebCatalogItem(item)) return false
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
        <div className="hero-panel">
          <div className="hero-glow" aria-hidden />
          <div className="hero-frame">
            <span>Total titles</span>
            <strong>{catalogGrowth.today.toLocaleString()}</strong>
            {catalogGrowth.newToday > 0 ? (
              <button
                type="button"
                className="growth-hit"
                onClick={() => setNewTitlesOpen(true)}
              >
                Added today {catalogGrowth.newToday.toLocaleString()}
              </button>
            ) : (
              <em>Added today 0</em>
            )}
          </div>
        </div>
      </header>

      {newTitlesOpen ? (
        <NewTitlesDialog
          title="Added today"
          items={newTodayItems}
          onClose={() => setNewTitlesOpen(false)}
        />
      ) : null}

      {!homeQuery.trim() && !kidsMode && favoriteMatches.length > 0 && (
        <section className="section-block favorite-matches">
          <div className="section-head">
            <h2>Your teams</h2>
            <p>Live and upcoming matches for your teams, plus recent replays (last 3 days).</p>
          </div>
          <CatalogGrid
            items={favoriteMatches}
            showToolbar={false}
            showHealthFilters={false}
            emptyHint="No matches for your teams right now."
          />
        </section>
      )}

      {!homeQuery.trim() &&
        homeVodCategories.map((category) => (
          <ContinueWatching key={category} category={category} />
        ))}

      {!homeQuery.trim() && <RecommendedShelf />}

      {!homeQuery.trim() && <WatchNextStrip />}

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
          {(tvjPlayingElsewhere || cvmPlayingElsewhere || nationwidePlayingElsewhere) && (
            <p className="fine-print local-channel-note">
              {(tvjPlayingElsewhere
                ? tvjChannel.title
                : cvmPlayingElsewhere
                  ? cvmChannel.title
                  : nationwideChannel.title) +
                ' is playing in the corner — browse or search for another stream below.'}
            </p>
          )}
          {(!tvjPlayingElsewhere || !cvmPlayingElsewhere || !nationwidePlayingElsewhere) && (
            <div className="local-channel-live-row">
              {!tvjPlayingElsewhere && <LocalChannelLive item={tvjChannel} />}
              {!cvmPlayingElsewhere && <LocalChannelLive item={cvmChannel} />}
              {!nationwidePlayingElsewhere && <LocalChannelLive item={nationwideChannel} />}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
