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

export type CategoryId = 'sports' | 'movies' | 'anime' | 'series' | 'news'

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
  /** From tvg-language / similar IPTV attrs when present */
  language?: string
  /** From tvg-id — used to match XMLTV EPG channels */
  tvgId?: string
  /** Ordered files from a multi-video torrent (series or movie collection). */
  playlist?: StreamPlaylistItem[]
  /** WebVTT (or convertible) subtitle track for the active torrent video */
  subtitleUrl?: string
  /** Companion subtitle file vs speculative embedded softsub extract */
  subtitleKind?: 'file' | 'embedded'
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
  error?: string
}

export interface BrowserNavState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
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
      browserShow?: (bounds: BrowserBounds) => Promise<boolean>
      browserHide?: (options?: { blank?: boolean }) => Promise<boolean>
      browserSetBounds?: (bounds: BrowserBounds) => Promise<boolean>
      browserNavigate?: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>
      browserGoBack?: () => Promise<boolean>
      browserGoForward?: () => Promise<boolean>
      browserReload?: () => Promise<boolean>
      browserOpenExternalCurrent?: () => Promise<boolean>
      browserOpenPanel?: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>
      browserExecute?: (code: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>
      browserGetNav?: () => Promise<BrowserNavState & { visible?: boolean }>
      onBrowserNav?: (callback: (state: BrowserNavState) => void) => () => void
      onSaveContinue?: (callback: () => void) => () => void
      continueSaved?: () => void
      quit?: () => Promise<void>
      getVersion?: () => Promise<string>
      fetchHtml?: (url: string) => Promise<PlaylistFetchResult>
      torrentStream?: (magnet: string) => Promise<TorrentStreamResult>
      torrentStatus?: (infoHash?: string) => Promise<{ ok: boolean; torrents: TorrentInfo[]; error?: string }>
      torrentStop?: (infoHash?: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}
