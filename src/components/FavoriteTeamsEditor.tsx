import { useEffect, useState } from 'react'
import {
  addFavoriteTeam,
  FAVORITE_SPORT_LABELS,
  readFavoriteTeams,
  removeFavoriteTeam,
  subscribeFavoriteTeams,
  type FavoriteSport,
  type FavoriteTeam,
} from '../lib/favoriteTeams'
import { ensureFavoriteNotifyPermission } from '../lib/favoriteNotify'

function useFavoriteTeams(): FavoriteTeam[] {
  const [teams, setTeams] = useState(readFavoriteTeams)
  useEffect(() => subscribeFavoriteTeams(() => setTeams(readFavoriteTeams())), [])
  return teams
}

const SPORT_OPTIONS: FavoriteSport[] = [
  'football',
  'basketball',
  'cricket',
  'american-football',
]

/** Saved teams. Matching live / upcoming / recent replays show on Home. */
export function FavoriteTeamsEditor() {
  const teams = useFavoriteTeams()
  const [name, setName] = useState('')
  const [sport, setSport] = useState<FavoriteSport>('football')

  return (
    <section className="favorite-teams" aria-label="Favorite teams">
      <div className="section-head">
        <h2>Favorite teams</h2>
        <p>
          Football, basketball, cricket, and American football. Matching matches and recent
          replays show on Home, and Jiyu notifies you when one is about to start.
        </p>
      </div>
      <form
        className="favorite-teams-form"
        onSubmit={(event) => {
          event.preventDefault()
          const added = addFavoriteTeam(name, sport)
          if (!added) return
          setName('')
          void ensureFavoriteNotifyPermission()
        }}
      >
        <input
          className="search-input"
          type="text"
          value={name}
          placeholder="Team name, e.g. Arsenal, Lakers, or Chiefs"
          aria-label="Favorite team name"
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="favorite-teams-sport"
          aria-label="Sport"
          value={sport}
          onChange={(event) => setSport(event.target.value as FavoriteSport)}
        >
          {SPORT_OPTIONS.map((id) => (
            <option key={id} value={id}>
              {FAVORITE_SPORT_LABELS[id]}
            </option>
          ))}
        </select>
        <button type="submit" className="favorite-teams-add" disabled={name.trim().length < 2}>
          Add
        </button>
      </form>
      {teams.length > 0 ? (
        <ul className="favorite-teams-list">
          {teams.map((team) => (
            <li key={team.id}>
              <span>
                {team.name}
                <em>{FAVORITE_SPORT_LABELS[team.sport]}</em>
              </span>
              <button type="button" onClick={() => removeFavoriteTeam(team.id)} aria-label={`Remove ${team.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine-print">No favorite teams yet.</p>
      )}
    </section>
  )
}
