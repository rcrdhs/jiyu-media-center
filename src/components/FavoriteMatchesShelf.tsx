import { useEffect, useMemo, useState } from 'react'
import { CatalogGrid } from './CatalogGrid'
import {
  favoriteTeamMatches,
  readFavoriteTeams,
  subscribeFavoriteTeams,
} from '../lib/favoriteTeams'
import type { StreamItem } from '../types'

type FavoriteMatchesShelfProps = {
  items: StreamItem[]
  /** Hide when kids mode (or other gates). */
  hidden?: boolean
}

/** “Your teams” shelf — Home only (Sports keeps the Favorite teams editor). */
export function FavoriteMatchesShelf({ items, hidden }: FavoriteMatchesShelfProps) {
  const [teams, setTeams] = useState(readFavoriteTeams)
  useEffect(() => subscribeFavoriteTeams(() => setTeams(readFavoriteTeams())), [])
  const matches = useMemo(() => favoriteTeamMatches(items, teams), [items, teams])

  if (hidden || matches.length === 0) return null

  return (
    <section className="section-block favorite-matches">
      <div className="section-head">
        <h2>Your teams</h2>
        <p>Live and upcoming matches for your teams, plus recent replays (last 3 days).</p>
      </div>
      <CatalogGrid
        items={matches}
        showToolbar={false}
        showHealthFilters={false}
        emptyHint="No matches for your teams right now."
      />
    </section>
  )
}
