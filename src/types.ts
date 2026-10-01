export type StreamHealthState = 'idle' | 'checking' | 'online' | 'offline' | 'timeout'

export interface StreamProbeResult {
  ok: boolean
  state: Exclude<StreamHealthState, 'idle' | 'checking'>
  status: number
  latencyMs: number
  error: string
}

export interface StreamHealthEntry extends StreamProbeResult {
  id: string
  checkedAt: number
}

export interface PlaylistFetchResult {
  ok: boolean
  status: number
  content: string
  error: string
}

export type CategoryId = 'sports' | 'movies' | 'anime' | 'series' | 'news' | 'kids'

export type StreamTransport = 'direct' | 'torrent'
export type StreamSourceKind = 'builtin' | 'iptv' | 'torrent'

export interface StreamItem {
  id: string
  title: string
  description: string
  category: CategoryId
  /** Direct media URL (HLS .m3u8 or progressive MP4), or a torrent detail page until resolved */
  url: string
  poster?: string
  tags?: string[]
  source?: string
  /** How this entry entered the catalog */
  sourceKind?: StreamSourceKind
  /** Playback path: torrent entries resolve a magnet/.torrent at play time */
  transport?: StreamTransport
  /** Magnet or .torrent file URL — preferred when already known */
  torrentUri?: string
  /** Listing/detail page used to scrape playable links on demand */
  detailUrl?: string
  /** Unix ms release / added date when known (newest-first sorting) */
  releasedAt?: number
  /** Originating torrent-website source id */
  torrentSourceId?: string
  /** M2Box AoneRoom subject id for native play resolution */
  m2boxSubjectId?: string
  /** NetMirror / freemovies.lol WordPress post id for player_tv URLs */
  netmirrorPostId?: string
  /** NetMirror TMDB TV id (embed + episode list) */
  netmirrorTmdbId?: string
  /** Cached TMDB TV id for RiveStream play (YMovies title lookup) */
  rivestreamTmdbId?: string
  /** YMovies internal show id (e.g. s1ax4) for AJAX episode/play APIs */
  ymoviesId?: string
  /** Cinetaro TMDB TV id (list + cinextream embed play) */
  cinetaroTmdbId?: string
  /** Streamed.pk match id for live sports embeds */
  streamedMatchId?: string
  /** Streamed.pk source handles used to resolve embed URLs at play time */
  streamedSources?: Array<{ source: string; id: string }>
  /** Event start (Unix ms) — Sports countdown / Live badge */
  eventStartsAt?: number
  /** Event end (Unix ms) when known */
  eventEndsAt?: number
  /** Live viewer count when the catalog source provides it (PPV.st) */
  eventViewers?: number
  /** League / sport label for sports cards (NFL, MLB, Bundesliga, …) */
  eventSport?: string
  /** From tvg-language / similar IPTV attrs when present */
  language?: string
  /** From tvg-id — used to match XMLTV EPG channels */
  tvgId?: string
  /** M3U http-user-agent / #EXTVLCOPT — applied in Electron for HLS */
  httpUserAgent?: string
  /** M3U http-referrer / #EXTVLCOPT — applied in Electron for HLS */
  httpReferrer?: string
  /** Ordered files from a multi-video torrent (series or movie collection). */
  playlist?: StreamPlaylistItem[]
  /** WebVTT (or convertible) subtitle track for the active torrent video */
  subtitleUrl?: string
  /** Companion subtitle file vs speculative embedded softsub extract */
  subtitleKind?: 'file' | 'embedded'
  /**
   * Authoritative title length in seconds (YTS/TMDB runtime or ffprobe).
   * Prefer this over remux `video.duration`, which often tracks the buffer only.
   */
  runtimeSeconds?: number
  /** Active WebTorrent infoHash while this item is playing (swarm keep-alive). */
  torrentInfoHash?: string
}

export interface StreamPlaylistItem {
  title: string
  url: string
  fileName?: string
  subtitleUrl?: string
  /** Companion subtitle file vs speculative embedded softsub extract */
  subtitleKind?: 'file' | 'embedded'
  /** Magnet / .torrent to resolve when switching episodes (SubsPlease-style shows). */
  torrentUri?: string
  /** Fallback magnets when the primary swarm is dead. */
  torrentAlternates?: string[]
  /** Stable episode token for chrome (e.g. S01E02). */
  episodeKey?: string
}

export interface CategoryMeta {
  id: CategoryId
  label: string
  blurb: string
  accent: string
}

export interface DesktopPlaylistSource {
  id: string
  kind: 'file' | 'paste' | 'url' | 'iptv'
  label: string
  url?: string
  content: string
  addedAt: number
  itemCount: number
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface TorrentInfo {
  infoHash: string
  name: string
  progress: number
  downloadSpeed: number
  numPeers: number
  downloaded: number
  length: number
}

export interface TorrentStreamResult extends Partial<TorrentInfo> {
  ok: boolean
  url?: string
  subtitleUrl?: string
  subtitleKind?: 'file' | 'embedded'
  fileName?: string
  audioTranscoded?: boolean
  playlist?: StreamPlaylistItem[]
  /** Probed or metadata runtime for the active video file (seconds). */
  runtimeSeconds?: number
  error?: string
}

export interface BrowserNavState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** Reserved; Android in-app browser always stays in-process (GeckoView). */
  external?: boolean
}

declare global {
  interface Window {
    signalDesktop?: {
      isDesktop?: boolean
      openPlaylist: () => Promise<{ files: { path: string; content: string }[] } | null>
      openExternal: (url: string) => Promise<void>
      fetchPlaylist: (url: string) => Promise<PlaylistFetchResult>
      probeStream: (url: string, timeoutMs?: number) => Promise<StreamProbeResult>
      probeStreams: (
        entries: Array<{ id: string; url: string }>,
        timeoutMs?: number,
      ) => Promise<Array<{ id: string } & StreamProbeResult>>
      setPlaybackHeaders?: (options: {
        url: string
        userAgent?: string
        referrer?: string
      }) => Promise<{ ok: boolean; cleared?: boolean }>
      resolveVimeoLiveHls?: (
        input: string,
      ) => Promise<{ ok: boolean; url?: string; title?: string; error?: string }>
      catalogList?: () => Promise<DesktopPlaylistSource[]>
      catalogPut?: (source: DesktopPlaylistSource) => Promise<boolean>
      catalogDelete?: (id: string) => Promise<boolean>
      catalogClear?: () => Promise<boolean>
      catalogReplaceAll?: (sources: DesktopPlaylistSource[]) => Promise<boolean>
      torrentSourcesList?: () => Promise<
        Array<{ id: string; label: string; url: string }>
      >
      torrentSourcesSave?: (
        sources: Array<{ id: string; label: string; url: string }>,
      ) => Promise<boolean>
      /** TMDB TV lists with IMDb ids — key stays in Electron. */
      tmdbPopularTv?: (limit?: number) => Promise<{
        ok: boolean
        shows: Array<{
          tmdbId: number
          name: string
          firstAirDate: string
          popularity: number
          imdbId: string
          overview: string
          poster: string
        }>
        error?: string | null
      }>
      tmdbTvCatalog?: (
        kind: 'popular' | 'on_the_air' | 'trending' | 'by_year' | 'anime' | 'kids' | 'animation',
        limit?: number,
        options?: { withExternalIds?: boolean },
      ) => Promise<{
        ok: boolean
        shows: Array<{
          tmdbId: number
          name: string
          firstAirDate: string
          popularity: number
          imdbId: string
          overview: string
          poster: string
          originalLanguage?: string
          genreIds?: number[]
        }>
        error?: string | null
        cancelled?: boolean
      }>
      /** Pause / resume / cancel / reset a running TMDB catalog fetch in Electron. */
      tmdbSyncControl?: (
        action: 'pause' | 'resume' | 'cancel' | 'reset',
      ) => Promise<{ ok: boolean; paused: boolean; cancelled: boolean }>
      onTmdbProgress?: (
        callback: (payload: {
          phase: 'discover' | 'ids' | 'done'
          kind: string
          page: number
          pagesNeeded: number
          done: number
          total: number
        }) => void,
      ) => () => void
      browserShow?: (bounds: BrowserBounds) => Promise<boolean>
      browserHide?: (options?: { blank?: boolean; pause?: boolean }) => Promise<boolean>
      browserSetBounds?: (bounds: BrowserBounds) => Promise<boolean>
      browserNavigate?: (url: string) => Promise<{
        ok: boolean
        url?: string
        error?: string
        kept?: boolean
      }>
      browserGoBack?: () => Promise<boolean>
      browserGoForward?: () => Promise<boolean>
      browserReload?: () => Promise<boolean>
      browserOpenExternalCurrent?: () => Promise<boolean>
      browserOpenPanel?: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>
      browserExecute?: (code: string) => Promise<{
        ok: boolean
        result?: unknown
        error?: string
        frameResults?: Array<{ ok: boolean; url?: string; result?: unknown; error?: string }>
      }>
      /** Synthetic click(s) on the native embed tile — unmutes cross-origin iframe players. */
      browserClickCenter?: (options?: {
        points?: Array<{ x: number; y: number }>
      }) => Promise<{ ok: boolean; clicks?: number; error?: string }>
      browserGetNav?: () => Promise<BrowserNavState & { visible?: boolean }>
      browserGetVolume?: () => Promise<{ percent: number }>
      browserSetVolume?: (percent: number) => Promise<{ ok: boolean; percent: number }>
      onBrowserNav?: (callback: (state: BrowserNavState) => void) => () => void
      onBrowserVolume?: (callback: (state: { percent: number }) => void) => () => void
      browserAdDockClose?: () => Promise<boolean>
      browserAdDockStatus?: () => Promise<{ visible: boolean; url: string }>
      onBrowserAdDock?: (callback: (state: { visible: boolean; url: string }) => void) => () => void
      onForceExitFullscreen?: (callback: () => void) => () => void
      browserMultiShow?: (payload: {
        id: string
        url: string
        bounds: BrowserBounds
        primary?: boolean
      }) => Promise<{ ok: boolean; url?: string; error?: string }>
      browserMultiSetBounds?: (payload: { id: string; bounds: BrowserBounds }) => Promise<boolean>
      browserMultiSetAudio?: (payload: { id: string; muted: boolean }) => Promise<boolean>
      browserMultiSpotlight?: (payload: { id: string }) => Promise<boolean>
      browserMultiNudge?: (payload: { id: string }) => Promise<boolean>
      onBrowserMultiFocus?: (callback: (state: { id: string }) => void) => () => void
      browserMultiHide?: (payload?: {
        id?: string
        blank?: boolean
        destroy?: boolean
      }) => Promise<boolean>
      browserMultiHideAll?: (options?: { blank?: boolean }) => Promise<boolean>
      onSaveContinue?: (callback: () => void) => () => void
      continueSaved?: () => void
      quit?: () => Promise<void>
      exitFullScreen?: () => Promise<boolean>
      setFullScreen?: (enabled: boolean) => Promise<boolean>
      isFullScreen?: () => Promise<boolean>
      /** Tell main whether OS minimize should demote to PiP. */
      setMinimizeToPipPolicy?: (policy: {
        enabled: boolean
        armed: boolean
      }) => Promise<boolean>
      /** True taskbar minimize (bypasses minimize-to-PiP). */
      minimizeWindow?: () => Promise<boolean>
      onMinimizeToPip?: (callback: () => void) => () => void
      onFullScreenChange?: (
        callback: (state: { fullScreen: boolean }) => void,
      ) => () => void
      getVersion?: () => Promise<string>
      /** Keep the desktop window from sleeping while a catalog sync is running. */
      setBackgroundSync?: (active: boolean) => Promise<{ ok: boolean }>
      /** Packaged builds only — check GitHub Releases via electron-updater. */
      checkForUpdates?: () => Promise<{
        ok: boolean
        reason?: string
        message?: string
        version?: string | null
        error?: string
      }>
      downloadUpdate?: () => Promise<{ ok: boolean; reason?: string; error?: string }>
      installUpdate?: () => Promise<{ ok: boolean; reason?: string }>
      onUpdater?: (
        callback: (state: {
          status:
            | 'idle'
            | 'checking'
            | 'available'
            | 'not-available'
            | 'downloading'
            | 'downloaded'
            | 'error'
          version?: string | null
          percent?: number
          transferred?: number
          total?: number
          message?: string
          reason?: string
        }) => void,
      ) => () => void
      /** CPU / RAM / battery / GPU hints for adaptive performance. */
      getSystemCapabilities?: () => Promise<{
        platform: string
        arch: string
        cpuCount: number
        totalMemGB: number
        freeMemGB: number
        onBattery: boolean | null
        gpuAccelerated: boolean | null
      }>
      /** Apply torrent / probe knobs resolved from the device profile. */
      setPerformanceKnobs?: (knobs: {
        torrentMaxConns?: number
        torrentPrefetchPieces?: number
        torrentCriticalPieces?: number
        streamProbeConcurrency?: number
        deviceClass?: string
      }) => Promise<{ ok: boolean }>
      fetchHtml?: (
        url: string,
        opts?: { quiet?: boolean; referer?: string },
      ) => Promise<PlaylistFetchResult>
      fetchJsonPost?: (
        url: string,
        body: Record<string, unknown>,
        referer?: string,
      ) => Promise<PlaylistFetchResult>
      fetchJsonGet?: (url: string, referer?: string) => Promise<PlaylistFetchResult>
      /** Softsubs via Wyzie — key stays in Electron main .env only. */
      resolveWyzieSubtitle?: (options: {
        tmdbId: string | number
        season?: number
        episode?: number
        language?: string
      }) => Promise<
        | {
            ok: true
            subtitleUrl: string
            subtitleKind: 'file'
            source: 'wyzie'
            hit?: {
              id?: string
              format?: string
              language?: string
              display?: string
              fileName?: string
              release?: string
            }
          }
        | { ok: false; error: string }
      >
      /** Close the Cloudflare Chrome helper (after Show List sync). */
      closeCfBrowser?: (options?: { soon?: boolean; reason?: string }) => Promise<{ ok: boolean }>
      torrentStream?: (
        magnet: string,
        options?: { keepOthers?: boolean },
      ) => Promise<TorrentStreamResult>
      torrentStatus?: (infoHash?: string) => Promise<{ ok: boolean; torrents: TorrentInfo[]; error?: string }>
      torrentStop?: (infoHash?: string) => Promise<{ ok: boolean; error?: string }>
      /** Keep pieces downloading while paused / ahead of the playhead (low disk — not a full download). */
      torrentEnsureDownloading?: (
        infoHash: string,
        playheadSec?: number,
        runtimeSec?: number,
      ) => Promise<{ ok: boolean; error?: string }>
    }
  }
}
