import type { CategoryId, StreamItem } from '../types'

/** Sections where English filtering applies (anime is excluded by design). */
export const ENGLISH_FILTER_CATEGORIES: CategoryId[] = [
  'sports',
  'movies',
  'series',
  'news',
]

const ENGLISH_HINT =
  /\b(english|eng\b|en\b|uk\b|usa\b|us\b|united\s*states|britain|british|canada|canadian|australia|australian|ireland|new\s*zealand|nz\b)\b|[|\[]\s*(en|eng|uk|us|usa|ca|au)\s*[|\]]|:\s*(us|uk|ca|au)\b|^us\s*[:|\-]|group.*\b(us|uk|ca|au|en)\b/i

const NON_ENGLISH_HINT =
  /\b(arabic|español|espanol|spanish|french|français|francais|deutsch|german|italian|italiano|portugu[eê]s|brazil|brasil|turkish|türk|russian|русский|hindi|tamil|telugu|urdu|chinese|mandarin|cantonese|korean|日本語|日本|korean|한국어|thai|vietnamese|polish|romanian|greek|hebrew|persian|farsi|indonesian|malay|tagalog|filipino)\b|[|\[]\s*(ar|es|mx|br|pt|fr|de|it|tr|ru|in|pk|cn|zh|kr|jp|th|vn|pl|ro|gr|il|id|my|ph)\s*[|\]]|:\s*(ar|es|mx|br|fr|de|it|tr|ru|in|cn|kr|jp)\b/i

const M2BOX_COUNTRY_TO_LANG: Record<string, string> = {
  korea: 'ko',
  japan: 'ja',
  'united states': 'en',
  us: 'en',
  usa: 'en',
  'united kingdom': 'en',
  uk: 'en',
}

/**
 * Normalize ISO / IPTV / display language strings to a short code (en, ko, ja…).
 */
export function normalizeLanguageCode(raw?: string | null): string {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (!s) return ''
  if (/^(en|eng|english)([-_]|$)/i.test(s)) return 'en'
  if (/^(ko|kor|korean|kr)([-_]|$)/i.test(s)) return 'ko'
  if (/^(ja|jpn|japanese|jp)([-_]|$)/i.test(s)) return 'ja'
  if (/^(zh|chi|zho|chinese|cmn|yue|cantonese|mandarin)([-_]|$)/i.test(s)) return 'zh'
  if (/^(es|spa|spanish|español|espanol)([-_]|$)/i.test(s)) return 'es'
  if (/^(fr|fra|fre|french|français|francais)([-_]|$)/i.test(s)) return 'fr'
  if (/^(de|deu|ger|german|deutsch)([-_]|$)/i.test(s)) return 'de'
  if (/^(hi|hin|hindi)([-_]|$)/i.test(s)) return 'hi'
  if (/^(pt|por|portuguese|brazil|brasil)([-_]|$)/i.test(s)) return 'pt'
  if (/^(ar|ara|arabic)([-_]|$)/i.test(s)) return 'ar'
  if (/^(th|tha|thai)([-_]|$)/i.test(s)) return 'th'
  if (/^(vi|vie|vietnamese)([-_]|$)/i.test(s)) return 'vi'
  if (/^(tr|tur|turkish)([-_]|$)/i.test(s)) return 'tr'
  if (/^(ru|rus|russian)([-_]|$)/i.test(s)) return 'ru'
  // Bare ISO639 (+ optional 2-letter region): en, eng, en-us.
  // Reject shelf tags like "new-movies" (suffix is not a region code).
  const iso = /^([a-z]{2,3})(?:-[a-z]{2})?$/i.exec(s)
  return iso?.[1]?.toLowerCase() || ''
}

export function languageFromM2BoxCountry(country?: string | null): string {
  const key = String(country || '')
    .trim()
    .toLowerCase()
  if (!key) return ''
  return M2BOX_COUNTRY_TO_LANG[key] || ''
}

/**
 * Catalog category / shelf tags — must not be parsed as spoken-language codes.
 * (`new-movies` used to become language "new" and hide the whole New Movies shelf
 * when English-only was on.)
 */
export const CATALOG_STRUCTURE_TAGS: ReadonlySet<string> = new Set([
  'movies',
  'series',
  'anime',
  'kids',
  'sports',
  'news',
  'popular-movies',
  'new-movies',
  'popular-series',
  'airing-series',
  'trending-series',
  'trending-airing',
  '247-series',
  'new-releases',
  'full-shows',
  'kids-movies',
  'kids-shows',
  'live',
  'streamed',
  'iptv',
  'torrent',
  'builtin',
])

/**
 * Best-effort show audio / original language from catalog fields + heuristics.
 */
export function detectItemOriginalLanguage(
  item: Pick<
    StreamItem,
    'originalLanguage' | 'language' | 'title' | 'description' | 'tags' | 'category'
  >,
): string {
  const fromMeta =
    normalizeLanguageCode(item.originalLanguage) || normalizeLanguageCode(item.language)
  if (fromMeta) return fromMeta

  if (item.category === 'anime') return 'ja'

  const tags = (item.tags ?? []).map((t) => t.toLowerCase())
  for (const tag of tags) {
    if (CATALOG_STRUCTURE_TAGS.has(tag)) continue
    const fromCountry = languageFromM2BoxCountry(tag)
    if (fromCountry) return fromCountry
    const fromTag = normalizeLanguageCode(tag)
    if (fromTag && fromTag !== 'en') return fromTag
  }

  const haystack = [item.title, item.description, ...(item.tags ?? [])].join(' ')
  if (NON_ENGLISH_HINT.test(haystack) && !ENGLISH_HINT.test(haystack)) {
    if (/\bkorean|한국어|\bkr\b/i.test(haystack)) return 'ko'
    if (/\bjapanese|日本語|\bjp\b|\bja\b/i.test(haystack)) return 'ja'
    if (/\bchinese|mandarin|cantonese|\bzh\b/i.test(haystack)) return 'zh'
    if (/\bhindi|\bhin\b/i.test(haystack)) return 'hi'
    if (/\bspanish|español|espanol/i.test(haystack)) return 'es'
    return 'xx' // known non-English, code unknown
  }
  return ''
}

/**
 * Heuristic language check from IPTV titles, groups, tvg-language, and tags.
 * Anime is never filtered by the caller — this helper is for other shelves.
 */
export function isLikelyEnglish(item: StreamItem): boolean {
  const detected = detectItemOriginalLanguage(item)
  if (detected) return detected === 'en'

  const lang = item.language?.trim()
  if (lang) {
    if (/^(en|eng|english)\b/i.test(lang)) return true
    // Explicit non-English language attribute
    if (/^[a-z]{2,3}\b/i.test(lang)) return false
  }

  const haystack = [
    item.title,
    item.description,
    item.language ?? '',
    ...(item.tags ?? []),
  ].join(' ')

  const english = ENGLISH_HINT.test(haystack)
  const other = NON_ENGLISH_HINT.test(haystack)

  if (other && !english) return false
  return true
}

/**
 * When true, play paths should resolve Wyzie/OpenSubtitles (or Nyaa) so a
 * Subs control is available — typically non-English audio + English softsubs.
 */
export function itemNeedsSoftSubtitles(
  item: Pick<
    StreamItem,
    | 'originalLanguage'
    | 'language'
    | 'title'
    | 'description'
    | 'tags'
    | 'category'
    | 'm2boxSubjectId'
    | 'torrentSourceId'
  >,
  preferredSubLang = getPreferredSubtitleLanguage(),
): boolean {
  const pref = normalizeLanguageCode(preferredSubLang) || 'en'
  const original = detectItemOriginalLanguage(item)
  if (original && original !== pref) return true
  // Anime almost always needs softsubs for English viewers.
  if (item.category === 'anime') return true
  // M2Box Korea/Japan catalogs often lack in-stream captions.
  if (item.m2boxSubjectId || /m2box/i.test(String(item.torrentSourceId || ''))) {
    if (!original || original !== pref) return true
  }
  return false
}

export function shouldApplyEnglishFilter(category: CategoryId): boolean {
  return ENGLISH_FILTER_CATEGORIES.includes(category)
}

const PREF_KEY = 'signal.pref.englishOnly'
const SUB_LANG_KEY = 'signal.pref.subtitleLanguage'

export function getEnglishOnlyPref(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw === null) return true
    return raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

export function setEnglishOnlyPref(value: boolean) {
  try {
    localStorage.setItem(PREF_KEY, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** Preferred softsub language for Wyzie/OpenSubtitles (default English). */
export function getPreferredSubtitleLanguage(): string {
  try {
    const raw = localStorage.getItem(SUB_LANG_KEY)
    const code = normalizeLanguageCode(raw)
    return code || 'en'
  } catch {
    return 'en'
  }
}

export function setPreferredSubtitleLanguage(code: string) {
  try {
    const normalized = normalizeLanguageCode(code) || 'en'
    localStorage.setItem(SUB_LANG_KEY, normalized)
  } catch {
    /* ignore */
  }
}

const AUTO_TRANSLATE_KEY = 'signal.pref.autoTranslateSubs'

/**
 * Auto-translate subtitles: when the only subtitle track found is in another language,
 * translate it to the preferred subtitle language (via the jiyu-wyzie Worker). Default on.
 */
export function getAutoTranslateSubsPref(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_TRANSLATE_KEY)
    if (raw === null) return true
    return raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

export function setAutoTranslateSubsPref(value: boolean) {
  try {
    localStorage.setItem(AUTO_TRANSLATE_KEY, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** Subtitle language choices for Settings (codes understood by normalizeLanguageCode). */
export const SUBTITLE_LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
]

/** Human label for a subtitle language code (falls back to the upper-cased code). */
export function subtitleLanguageLabel(code?: string | null): string {
  const c = normalizeLanguageCode(code)
  if (!c) return 'Unknown'
  return SUBTITLE_LANGUAGE_OPTIONS.find((o) => o.code === c)?.label || c.toUpperCase()
}
