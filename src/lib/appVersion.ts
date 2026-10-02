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
    version: '0.3.35',
    summary:
      'Sports/live: deeper HLS buffers, disable edge-chasing MPEG-TS stash-off; Android Auto profile no longer self-classifies as Lite',
  },
  {
    version: '0.3.34',
    summary:
      'Android PiP: keep softsubs pinned to the bottom of the player (vh clamp no longer parks cues mid-frame)',
  },
  {
    version: '0.3.33',
    summary:
      'Anime/TV: Movy stall falls back to Atlantic Helios HLS; skip Aphrodite Warp bumper streams; paleoak CDN + Android AES/cdn-m3u8 loader fixes',
  },
  {
    version: '0.3.32',
    summary:
      'Android: HLS playlists load via native HTTP with Referer (fixes Movy/CDN stuck on Loading HLS); keep player controls visible while buffering',
  },
  {
    version: '0.3.31',
    summary:
      'Anime/TV: Movy Direct HLS in native Player (Nyaa fallback); Wyzie softsubs when Movy has no captions (desktop IPC + Cloudflare proxy for Android/TV)',
  },
  {
    version: '0.3.30',
    summary:
      'Zenox embed chrome shows zenox. brand over the title; softsubs stay on native/torrent paths (embed has no Jiyu Subs overlay)',
  },
  {
    version: '0.3.29',
    summary:
      'Player chrome: Pause/Mute/volume above a custom seek bar (native video controls no longer overlap)',
  },
  {
    version: '0.3.28',
    summary:
      'Anime/TV play order: Zenox first, Nyaa magnets only as fallback when TMDB/Zenox is unavailable',
  },
  {
    version: '0.3.27',
    summary:
      'Simpler TV/anime play: skip Rivestream Direct/embed race — TMDB episodes open Zenox (Nyaa first for anime)',
  },
  {
    version: '0.3.26',
    summary:
      'Android Back: section→home→exit toast; split player chrome; fix landscape skip/PiP size; anime→Zenox/Rive fallback; Zenox movie search; show version on Android',
  },
  {
    version: '0.3.25',
    summary:
      'Android Home no longer opens system PiP from shelf preview autoplay — only a real watch session arms it',
  },
  {
    version: '0.3.24',
    summary:
      'Android player goes edge-to-edge (hides Library rail) and drops the crowded Playing/hls/Vol/Subs status strip',
  },
  {
    version: '0.3.23',
    summary:
      'Release softsubs via desktop bridge + Referer; paint Rivestream black to remove Android white gap under the player',
  },
  {
    version: '0.3.22',
    summary:
      'Your teams shelf shrinks to content; Rivestream Back→PiP fixed; auto Direct then Embed server hop on Android',
  },
  {
    version: '0.3.21',
    summary:
      'Rivestream: prefer Direct first then Embeds; hide Direct/Vanguard server bar on Android and desktop',
  },
  {
    version: '0.3.20',
    summary: 'Android: raise in-player subtitles so cues sit higher on the video',
  },
  {
    version: '0.3.19',
    summary:
      'Hide Rivestream fake “You received a message!” / notification popups on desktop and Android',
  },
  {
    version: '0.3.18',
    summary:
      'Android update feed: ignore UTF-8 BOM so Check for updates can read latest-android.yml',
  },
  {
    version: '0.3.17',
    summary:
      'Anime softsubs: pick Citadel/FlowCast captions first and load remote VTT/SRT through the desktop/Android bridge',
  },
  {
    version: '0.3.16',
    summary:
      'Desktop: yellow Download update banner under the logo (no need to open/scroll the menu)',
  },
  {
    version: '0.3.15',
    summary:
      'Desktop: Check for updates / Get latest installer sit above the changelog; portable builds explain they need the Setup app',
  },
  {
    version: '0.3.14',
    summary:
      'Anime softsubs: borrow English captions from Citadel/FlowCast when the playing stream has none',
  },
  {
    version: '0.3.13',
    summary: 'Subtitles stay visible in corner PiP and Android system PiP',
  },
  {
    version: '0.3.12',
    summary:
      'Anime/TV play tries Rivestream/TMDB first then Nyaa; episode lookups and torrents time out instead of hanging; quieter play status',
  },
  {
    version: '0.3.11',
    summary:
      'Movies search always tries YTS then Cinetaro/YMovies when New Movies is empty; YouTube live preview Referer fix on desktop',
  },
  {
    version: '0.3.10',
    summary:
      'Cast for real stream URLs, movie synopsis before play, Movies/Nyaa search fallbacks, Your teams replays expire, and sticky sync notifications clear',
  },
  {
    version: '0.3.9',
    summary:
      'Phone Home keeps the video in picture-in-picture, browser back and forward work, and player status stays on the toolbar',
  },
  {
    version: '0.3.8',
    summary: 'Catalog sync continues after you leave, and a short welcome on first launch',
  },
  {
    version: '0.3.7',
    summary: 'Android updates from the same GitHub Release as Windows and Linux',
  },
  {
    version: '0.3.6',
    summary:
      'Android compact chrome (sections menu), smaller Total titles hero + section tiles, phone-adaptive layout',
  },
  {
    version: '0.3.5',
    summary:
      'Cinetaro TV catalog, anime Full Shows (ended) + softsubs, TMDB Kids Shows, poster-aligned cards, Sort menu on Anime/TV/Movies, quieter Sports shelf labels',
  },
  {
    version: '0.3.4',
    summary:
      'TMDB TV Series sync (popular/airing/trending) with Rive HLS→embed play, M2Box native play + NetMirror/YMovies Series, Watch Next, series shelf cleanup',
  },
  {
    version: '0.3.3',
    summary:
      'Curated Kids shelves (movies/shows/live) with PIN Kids mode, Real-Debrid/Torrentio TV paths, deeper YTS Popular sync',
  },
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
