import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORIES, LOCAL_CHANNELS, resolveLocalChannels } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import { CatalogGrid } from '../components/CatalogGrid'
import { ContinueWatching } from '../components/ContinueWatching'
import { FavoriteMatchesShelf } from '../components/FavoriteMatchesShelf'
import { RecommendedShelf } from '../components/RecommendedShelf'
import { NewTitlesDialog } from '../components/NewTitlesDialog'
import { WatchNextStrip } from '../components/WatchNextStrip'
import { WatchHistory } from '../components/WatchHistory'
import { useUrlOverlay } from '../hooks/useUrlOverlay'
import { LocalChannelLive } from '../components/LocalChannelLive'
import { filterShelfVisibleItems, isSeriesWebCatalogItem } from '../lib/torrents'
import { HIDE_KEYWORDS_EVENT } from '../lib/hideKeywords'
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
  filterKnownPlayable,
  PLAYABILITY_CHANGED,
  queuePlayabilityChecks,
} from '../lib/playability'
import {
  getWatchlist,
  resolveWatchlistItems,
  subscribeWatchlist,
} from '../lib/watchlist'

const HOME_PANELS = ['added', 'saved'] as const

export function HomePage() {
  const { byCategory, items, ready, englishOnly } = useCatalog()
  const { item: playingItem, mode } = usePlayback()
  const [homeQuery, setHomeQuery] = useState('')
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [catalogGrowth, setCatalogGrowth] = useState<SectionGrowth>(() =>
    getCatalogGrowth(items.length),
  )
  // In the URL (?panel=added|saved) so Back from a title reopens the sheet.
  const [homePanel, openHomePanel, closeHomePanel] = useUrlOverlay('panel', HOME_PANELS)
  const newTitlesOpen = homePanel === 'added'
  const savedOpen = homePanel === 'saved'
  const [savedCount, setSavedCount] = useState(() => getWatchlist().length)
  const [hideKeywordsTick, setHideKeywordsTick] = useState(0)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])
  useEffect(() => {
    const bump = () => setHideKeywordsTick((n) => n + 1)
    window.addEventListener(HIDE_KEYWORDS_EVENT, bump)
    return () => window.removeEventListener(HIDE_KEYWORDS_EVENT, bump)
  }, [])
  useEffect(
    () =>
      subscribeWatchlist(() => {
        setSavedCount(getWatchlist().length)
      }),
    [],
  )
  useEffect(() => {
    setSavedCount(getWatchlist().length)
  }, [kidsMode])

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

  const [playabilityTick, setPlayabilityTick] = useState(0)
  useEffect(() => {
    const bump = () => setPlayabilityTick((n) => n + 1)
    window.addEventListener(PLAYABILITY_CHANGED, bump)
    return () => window.removeEventListener(PLAYABILITY_CHANGED, bump)
  }, [])

  const newTodayAll = useMemo(() => {
    // Only titles first added to a shelf today — never pad with older releases.
    const n = Math.max(0, catalogGrowth.newToday)
    if (n <= 0) return []
    return catalogNewTitleItems(items, 'today', n)
  }, [items, catalogGrowth.newToday])

  // Check TMDB-routed kids/series rows in the background; hide ones with no source.
  useEffect(() => {
    if (newTodayAll.length > 0) queuePlayabilityChecks(newTodayAll)
  }, [newTodayAll])

  const newTodayItems = useMemo(() => {
    void playabilityTick
    return filterKnownPlayable(newTodayAll)
  }, [newTodayAll, playabilityTick])
  const addedTodayCount = newTodayItems.length

  const savedItems = useMemo(() => resolveWatchlistItems(items), [items, savedCount])

  const localChannels = useMemo(() => resolveLocalChannels(items), [items])
  const tvjChannel = localChannels.find((c) => c.id === 'local-tvj') ?? LOCAL_CHANNELS[0]
  const cvmChannel = localChannels.find((c) => c.id === 'local-cvm') ?? LOCAL_CHANNELS[1]
  const nationwideChannel =
    localChannels.find((c) => c.id === 'local-nationwide') ?? LOCAL_CHANNELS[2]
  const tvjPlayingElsewhere = playingItem?.id === tvjChannel.id && mode !== 'off'
  const cvmPlayingElsewhere = playingItem?.id === cvmChannel.id && mode !== 'off'
  const nationwidePlayingElsewhere =
    playingItem?.id === nationwideChannel.id && mode !== 'off'

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
  }, [items, homeQuery, englishOnly, hideKeywordsTick])

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
        <div className="hero-aside">
          <div className="hero-panel">
            <div className="hero-glow" aria-hidden />
            <div className="hero-frame">
              <span>Total titles</span>
              <strong>{catalogGrowth.today.toLocaleString()}</strong>
              {addedTodayCount > 0 ? (
                <button
                  type="button"
                  className="growth-hit"
                  onClick={() => openHomePanel('added')}
                >
                  Added today {addedTodayCount.toLocaleString()}
                </button>
              ) : (
                <em>Added today 0</em>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`growth-hit hero-saved-hit${savedCount > 0 ? '' : ' is-disabled'}`}
            onClick={() => openHomePanel('saved')}
          >
            Saved {savedCount.toLocaleString()}
          </button>
        </div>
      </header>

      {newTitlesOpen ? (
        <NewTitlesDialog
          title="Added today"
          items={newTodayItems}
          restoreKey="home:added"
          onClose={closeHomePanel}
        />
      ) : null}

      {savedOpen ? (
        <NewTitlesDialog
          title="Saved"
          items={savedItems}
          emptyHint="Nothing saved yet — tap ♡ on a movie, series, anime, or kids title."
          restoreKey="home:saved"
          onClose={closeHomePanel}
        />
      ) : null}

      {!homeQuery.trim() ? (
        <FavoriteMatchesShelf items={items} hidden={kidsMode} />
      ) : null}

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
          {/* Always show all three cards. Hiding the playing one made a channel whose
              player failed (e.g. Nationwide's YouTube Error 153) vanish from Home
              until the stuck PiP was closed. */}
          <div className="local-channel-live-row">
            <LocalChannelLive item={tvjChannel} playingElsewhere={tvjPlayingElsewhere} />
            <LocalChannelLive item={cvmChannel} playingElsewhere={cvmPlayingElsewhere} />
            <LocalChannelLive
              item={nationwideChannel}
              playingElsewhere={nationwidePlayingElsewhere}
            />
          </div>
        </section>
      )}
    </div>
  )
}
