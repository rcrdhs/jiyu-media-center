import { useEffect, useState, type FormEvent } from 'react'
import {
  addHideKeywords,
  HIDE_KEYWORD_SECTIONS,
  type HideKeywordSection,
  listHideKeywords,
  removeHideKeyword,
  resolveHideKeywordTmdbIds,
  subscribeHideKeywords,
} from '../lib/hideKeywords'

const SECTION_LABEL: Record<HideKeywordSection, string> = {
  movies: 'Movies',
  series: 'Series',
  anime: 'Anime',
  kids: 'Kids',
}

type HideKeywordsSettingsProps = {
  /** Library settings block vs compact strip on a section page. */
  variant?: 'library' | 'section'
  /** Section whose blocklist to edit (required for section variant). */
  category?: HideKeywordSection
}

function SectionEditor({
  section,
  variant,
  defaultOpen = false,
}: {
  section: HideKeywordSection
  variant: 'library' | 'section'
  defaultOpen?: boolean
}) {
  const [keywords, setKeywords] = useState(() => listHideKeywords(section))
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(defaultOpen || listHideKeywords(section).length > 0)
  const label = SECTION_LABEL[section]

  useEffect(
    () =>
      subscribeHideKeywords(() => {
        setKeywords(listHideKeywords(section))
      }),
    [section],
  )

  function onAdd(event: FormEvent) {
    event.preventDefault()
    const added = addHideKeywords(section, draft)
    setDraft('')
    setKeywords(listHideKeywords(section))
    if (added.length === 0) {
      setNote('Enter a word or phrase (at least 2 characters)')
      return
    }
    setNote(
      added.length === 1
        ? `Hiding ${label} titles that contain “${added[0]}”`
        : `Added ${added.length} hide words for ${label}`,
    )
    void resolveHideKeywordTmdbIds(section, added)
    setOpen(true)
  }

  const form = (
    <>
      <form className="hide-keywords-form" onSubmit={onAdd}>
        <input
          id={`hide-keywords-${section}`}
          className="url-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="e.g. horror, war, slime"
          aria-label={`Keyword to hide in ${label}`}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="ghost-btn" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {keywords.length > 0 ? (
        <ul className="hide-keywords-list">
          {keywords.map((key) => (
            <li key={key}>
              <button
                type="button"
                className="ghost-btn hide-keywords-chip"
                onClick={() => {
                  removeHideKeyword(section, key)
                  setKeywords(listHideKeywords(section))
                  setNote(`Stopped hiding “${key}” in ${label}`)
                }}
                title={`Remove “${key}” from ${label}`}
              >
                {key} ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint hide-keywords-empty">No hide words for {label} yet.</p>
      )}
      {note ? <p className="field-hint hide-keywords-note">{note}</p> : null}
    </>
  )

  if (variant === 'section') {
    const count = keywords.length
    return (
      <section className="hide-keywords-section" aria-label={`Hide ${label} titles`}>
        <button
          type="button"
          className={`hide-keywords-toggle${open || count > 0 ? ' is-open' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>
            Hide titles containing…
            {count > 0 ? (
              <span className="hide-keywords-count"> {count} active</span>
            ) : (
              <span className="optional-tag"> optional · {label} only</span>
            )}
          </span>
          <span className="hide-keywords-chevron" aria-hidden>
            {open ? '▴' : '▾'}
          </span>
        </button>
        {open ? (
          <div className="hide-keywords-section-body">
            <p className="field-hint">
              These words only hide titles in {label}. Other sections keep their own lists.
            </p>
            {form}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="hide-keywords-library-block" aria-label={`${label} hide words`}>
      <h4 className="hide-keywords-library-heading">{label}</h4>
      <p className="field-hint">Only applies on the {label} shelf (and matching Home rows).</p>
      {form}
    </section>
  )
}

export function HideKeywordsSettings({
  variant = 'library',
  category,
}: HideKeywordsSettingsProps) {
  if (variant === 'section') {
    if (!category) return null
    return <SectionEditor section={category} variant="section" />
  }

  return (
    <div className="hide-keywords-library">
      <h3 className="field-label">
        Hide titles containing…{' '}
        <span className="optional-tag">optional · per section</span>
      </h3>
      <p className="field-hint">
        Each section has its own blocklist. Kids filters never affect Movies, and so on. Sports
        and News are not filtered.
      </p>
      <div className="hide-keywords-library-grid">
        {HIDE_KEYWORD_SECTIONS.map((section) => (
          <SectionEditor key={section} section={section} variant="library" />
        ))}
      </div>
    </div>
  )
}
