import { useState } from 'react'
import {
  type AnimeAudioMode,
  getGlobalAnimeAudioMode,
  setGlobalAnimeAudioMode,
} from '../lib/animeAudio'

/**
 * Settings: default anime audio. "Sub" = Japanese audio + subtitles (always available);
 * "Dub" = English dub when one exists, otherwise Japanese + subs. The player's Sub / Dub
 * button overrides this per show. Stored in localStorage, so each device keeps its own.
 */
export function AnimeAudioSettings() {
  const [mode, setMode] = useState<AnimeAudioMode>(() => getGlobalAnimeAudioMode())
  return (
    <>
      <label className="field-label" htmlFor="anime-audio-default">
        Anime audio
      </label>
      <select
        id="anime-audio-default"
        className="url-input"
        value={mode}
        onChange={(event) => {
          const next: AnimeAudioMode = event.target.value === 'dub' ? 'dub' : 'sub'
          setGlobalAnimeAudioMode(next)
          setMode(next)
        }}
        aria-label="Default anime audio"
      >
        <option value="sub">Sub (Japanese audio with subtitles)</option>
        <option value="dub">Dub (English audio when available)</option>
      </select>
      <p className="fine-print">
        When an anime has an English dub, the player shows a Sub / Dub button. Changing it
        there remembers the choice for that show. Shows without a dub always play in Japanese
        with subtitles.
      </p>
    </>
  )
}
