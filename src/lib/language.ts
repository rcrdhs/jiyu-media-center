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

/**
 * Heuristic language check from IPTV titles, groups, tvg-language, and tags.
 * Anime is never filtered by the caller — this helper is for other shelves.
 */
export function isLikelyEnglish(item: StreamItem): boolean {
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

export function shouldApplyEnglishFilter(category: CategoryId): boolean {
  return ENGLISH_FILTER_CATEGORIES.includes(category)
}

const PREF_KEY = 'signal.pref.englishOnly'

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
