/**
 * Section-shelf preferences for mixing IPTV and torrent catalog entries.
 */

export interface SectionSourcePrefs {
  /** Hide IPTV / M3U entries in Movies, Series, Anime */
  hideIptv: boolean
  /** Put torrent/magnet entries above IPTV */
  torrentFirst: boolean
  /** Sort by release/added date, newest first */
  newestFirst: boolean
}

const KEY = 'jiyu.section.sourcePrefs'

const DEFAULTS: SectionSourcePrefs = {
  hideIptv: false,
  torrentFirst: true,
  newestFirst: true,
}

export function getSectionSourcePrefs(): SectionSourcePrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<SectionSourcePrefs>
    return {
      hideIptv: Boolean(parsed.hideIptv),
      torrentFirst: parsed.torrentFirst !== false,
      newestFirst: parsed.newestFirst !== false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setSectionSourcePrefs(prefs: SectionSourcePrefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}
