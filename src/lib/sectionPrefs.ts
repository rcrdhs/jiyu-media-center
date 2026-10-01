/**
 * Section-shelf preferences for mixing IPTV and torrent catalog entries,
 * plus per-shelf title sort overrides for Anime / TV / Movies.
 */

export interface SectionSourcePrefs {
  /** Hide IPTV / M3U entries in Movies, Series, Anime */
  hideIptv: boolean
  /** Put torrent/magnet entries above IPTV */
  torrentFirst: boolean
}

/** User override on top of each shelf’s natural order. */
export type SectionSortMode = 'default' | 'newest' | 'title' | 'popular'

const KEY = 'jiyu.section.sourcePrefs'
const SORT_KEY = 'jiyu.section.sortPrefs'

const DEFAULTS: SectionSourcePrefs = {
  hideIptv: false,
  torrentFirst: true,
}

const SORT_MODES = new Set<SectionSortMode>(['default', 'newest', 'title', 'popular'])

export function getSectionSourcePrefs(): SectionSourcePrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<SectionSourcePrefs>
    return {
      hideIptv: Boolean(parsed.hideIptv),
      torrentFirst: parsed.torrentFirst !== false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setSectionSourcePrefs(prefs: SectionSourcePrefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}

function sortStorageKey(categoryId: string, shelfTab: string): string {
  return `${categoryId}:${shelfTab}`
}

export function getSectionSortMode(categoryId: string, shelfTab: string): SectionSortMode {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (!raw) return 'default'
    const parsed = JSON.parse(raw) as Record<string, string>
    const mode = parsed[sortStorageKey(categoryId, shelfTab)]
    if (mode && SORT_MODES.has(mode as SectionSortMode)) return mode as SectionSortMode
  } catch {
    /* ignore */
  }
  return 'default'
}

export function setSectionSortMode(
  categoryId: string,
  shelfTab: string,
  mode: SectionSortMode,
) {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    const key = sortStorageKey(categoryId, shelfTab)
    if (mode === 'default') delete parsed[key]
    else parsed[key] = mode
    localStorage.setItem(SORT_KEY, JSON.stringify(parsed))
  } catch {
    /* ignore */
  }
}
