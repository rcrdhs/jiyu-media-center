/**
 * Season awareness for Nyaa release titles (shared by desktop and Android).
 *
 * Fansub titles often carry only "Show - 01"; the episode parser reads that as an
 * absolute E01 and the lookup used to assume season 1, so "[Doomdos] Show Season 3 - 1"
 * matched S01E01. These helpers read an explicit season marker when the title has one
 * and reject releases whose stated season differs from the wanted one. Season-less
 * titles (absolute numbering) keep matching as before.
 */

function padEp(n: number, width = 2): string {
  return String(Math.max(0, Math.floor(n))).padStart(width, '0')
}

/**
 * Season stated in a release title, or null when there is no season marker.
 * Recognised: "S03E01", "3x01", "Season 3", "Season 03", "3rd Season", "S3 - 01",
 * "S03 - 01", "S2 01", "Show S2 [1080p]". "Part N" / "Cour N" are split-cour labels,
 * not seasons, so they are ignored ("Season 2 Part 2" is season 2).
 */
export function nyaaReleaseSeason(title: string): number | null {
  const t = String(title || '')
  const pick = (raw: string | undefined): number | null => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null
  }
  const sxe = /\bS(\d{1,2})E\d{1,4}\b/i.exec(t)
  if (sxe) return pick(sxe[1])
  const nxn = /\b(\d{1,2})x(\d{1,3})\b/i.exec(t)
  if (nxn) return pick(nxn[1])
  // Ordinal first: "2nd Season - 05" must not read the episode as "Season 05".
  const ord = /\b(\d{1,2})(?:st|nd|rd|th)[\s._]+Season\b/i.exec(t)
  if (ord) return pick(ord[1])
  const word = /\bSeason[\s._]*0*(\d{1,2})\b/i.exec(t)
  if (word) return pick(word[1])
  // Bare "S3" right before the episode number / a tag / the end: "S3 - 01", "S2 01", "S02 [1080p]".
  const short = /(?:^|[\s._[(])S0*(\d{1,2})(?=\s*[-–]\s*\d|\s+\d{1,4}\b|\s*[[(]|\s*$)/i.exec(t)
  if (short) return pick(short[1])
  return null
}

/**
 * Map a parsed episode token ("S03E01", "E01", "E1.5") to an SxxExx lookup key, using the
 * season the title states when the token itself has none. Season-less tokens fall back to
 * assumeSeason (absolute numbering keeps working).
 */
export function nyaaReleaseEpisodeKey(
  title: string,
  parsedKey: string | null | undefined,
  assumeSeason = 1,
): string | null {
  const raw = String(parsedKey || '').trim().toUpperCase()
  if (!raw) return null
  const sxx = /^S(\d{1,2})E(\d{1,3})$/i.exec(raw)
  if (sxx) return `S${padEp(Number(sxx[1]))}E${padEp(Number(sxx[2]))}`
  const eOnly = /^E(\d{1,3})(?:\.\d+)?$/i.exec(raw)
  if (eOnly) {
    const season = nyaaReleaseSeason(title) ?? assumeSeason
    return `S${padEp(season)}E${padEp(Number(eOnly[1]))}`
  }
  return null
}

/** True when the title states a season and it is not the wanted one. */
export function nyaaReleaseSeasonConflicts(title: string, wantSeason: number): boolean {
  const stated = nyaaReleaseSeason(title)
  return stated != null && stated !== Math.max(1, Math.floor(wantSeason) || 1)
}

/**
 * Does this release title (with its parsed episode token) carry the wanted episode?
 * A stated season must match; season-less "Show - 06" matches episode 6 of any wanted
 * season (absolute / per-season fansub numbering).
 */
export function nyaaReleaseMatchesEpisode(
  title: string,
  parsedKey: string | null | undefined,
  season: number,
  episode: number,
): boolean {
  const wantSeason = Math.max(1, Math.floor(season) || 1)
  const wantEp = Math.max(1, Math.floor(episode) || 1)
  if (!parsedKey) return false
  if (nyaaReleaseSeasonConflicts(title, wantSeason)) return false
  const key = nyaaReleaseEpisodeKey(title, parsedKey, wantSeason)
  return key === `S${padEp(wantSeason)}E${padEp(wantEp)}`
}
