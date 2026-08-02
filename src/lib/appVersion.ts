/**
 * App version shown in the UI. Kept in sync with package.json via Vite define
 * (__JIYU_VERSION__). Bump package.json when shipping a milestone.
 */

export const APP_NAME = 'Jiyu'

export const APP_VERSION = __JIYU_VERSION__

export const APP_VERSION_LABEL = `v${APP_VERSION}`

/** Short milestone log — newest first — so progress is visible in-app. */
export const APP_RELEASES: ReadonlyArray<{ version: string; summary: string }> = [
  {
    version: '0.3.2',
    summary:
      'TMDB + EZTV TV shelves, YTS Popular/New movies, remux resume past false ends, live sync progress, Home total/added-today, quieter shelf labels',
  },
  {
    version: '0.3.0',
    summary:
      'Torrent websites (YTS, EZTV, Torlock, SubsPlease), show → episode browsing, poster fallbacks, Cloudflare scrape session',
  },
  {
    version: '0.1.0',
    summary: 'Initial desktop media center shell — IPTV shelves, player, library import',
  },
]

export function appUserAgentProduct(): string {
  return `JiyuMedia/${APP_VERSION}`
}
