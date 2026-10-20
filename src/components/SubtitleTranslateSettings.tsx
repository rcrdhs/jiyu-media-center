import { useState } from 'react'
import {
  SUBTITLE_LANGUAGE_OPTIONS,
  getAutoTranslateSubsPref,
  getPreferredSubtitleLanguage,
  setAutoTranslateSubsPref,
  setPreferredSubtitleLanguage,
} from '../lib/language'

/**
 * Settings: preferred subtitle language (Wyzie / OpenSubtitles lookups + translation target)
 * and the Auto-translate switch. Stored in localStorage, so each device keeps its own choice.
 */
export function SubtitleTranslateSettings() {
  const [language, setLanguage] = useState(() => getPreferredSubtitleLanguage())
  const [autoTranslate, setAutoTranslate] = useState(() => getAutoTranslateSubsPref())
  const known = SUBTITLE_LANGUAGE_OPTIONS.some((o) => o.code === language)

  return (
    <>
      <label className="field-label" htmlFor="subtitle-language">
        Subtitle language
      </label>
      <select
        id="subtitle-language"
        className="url-input"
        value={language}
        onChange={(event) => {
          const next = event.target.value
          setPreferredSubtitleLanguage(next)
          setLanguage(getPreferredSubtitleLanguage())
        }}
        aria-label="Preferred subtitle language"
      >
        {!known && <option value={language}>{language.toUpperCase()}</option>}
        {SUBTITLE_LANGUAGE_OPTIONS.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
      <label className="check-toggle">
        <input
          type="checkbox"
          checked={autoTranslate}
          onChange={(event) => {
            setAutoTranslateSubsPref(event.target.checked)
            setAutoTranslate(event.target.checked)
          }}
        />
        Auto-translate subtitles
      </label>
      <p className="fine-print">
        When the only subtitles found are in another language, translate them to the subtitle
        language above. Off: the player shows a Translate button instead. Applies from the next
        episode you open.
      </p>
    </>
  )
}
