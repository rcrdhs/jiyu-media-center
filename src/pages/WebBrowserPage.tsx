import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { recordWebEmbedContinue } from '../lib/continueWatching'
import { isZenoxUrl, zenoxWatchUrl } from '../lib/zenox'
import {
  rememberReplayHost,
  replayHostChoices,
  resolveFullmatchShowsPlay,
  type ReplayPartsInfo,
} from '../lib/fullmatchShows'
import {
  buildSearchUrl,
  isBlankBrowserUrl,
  isEmbedPlayerHost,
  isPlaceholderBrowserTitle,
  isSportsOrReplayEmbedUrl,
  toAutoplayUrl,
  WEB_GUEST_ACTIVITY_EVENT,
  type WebSearchKind,
} from '../lib/webBrowser'
import type { CategoryId, StreamItem, StreamSourceKind, StreamTransport } from '../types'
import { VolumeSlider } from '../components/VolumeSlider'
import { TizenWebFrame } from '../components/TizenWebFrame'
import { isTizenTv } from '../lib/tvMode'
import { isTizenFrameBlockedEmbed } from '../lib/tizenRelay'
import { ANDROID_LEAVE_WEB_EMBED_EVENT, isAndroidShell } from '../lib/androidFullscreen'
import {
  androidBrowserExecute,
  androidBrowserGetVolume,
  androidBrowserHide,
  androidBrowserSetVolume,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  androidCastAvailable,
  androidOpenScreenCastSettings,
  isAndroidCastHost,
  isCastableMediaUrl,
} from '../lib/androidCast'
import { isAndroidMedia3Host } from '../lib/androidMedia3'
import { androidSniffCurrentMedia } from '../lib/androidStreamResolve'
import { isStreamCornerHost } from '../lib/streamCorner'

const DEFAULT_URL = 'https://www.youtube.com/'

type ContinueWatchState = {
  id: string
  title: string
  poster?: string
  category: CategoryId
  playlistIndex: number
  episodeTitle?: string
  detailUrl?: string
  playUrl?: string
  transport?: StreamTransport
  sourceKind?: StreamSourceKind
  source?: string
  rivestreamTmdbId?: string
  season?: number
  episode?: number
  playlistLength?: number
  /** Football replays: Full match / 1st half / 2nd half / Highlights picker. */
  replayParts?: ReplayPartsInfo
  /** PPV / StreamFree HD·SD (and other) embeds for the same match. */
  sportsAltSources?: Array<{ label: string; url: string }>
  /** Index into [playUrl, ...sportsAltSources] after auto/manual hops. */
  sportsSourceIndex?: number
}

type WebLocationState = {
  from?: string
  playerMode?: 'embed' | string
  /** Embed Back: drop into PiP and return to Sports / show. */
  pipOnBack?: boolean
  /**
   * Media3 (or another path) already showed "Unwrapping stream…" — open the
   * embed without a second cover for the same play tap.
   */
  skipUnwrapCover?: boolean
  /** Media3 already failed for this play — stay on Gecko (no promote loop). */
  skipMedia3Promote?: boolean
  continueWatch?: ContinueWatchState
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function parseEmbedEpisode(url: string): {
  tmdbId: string
  season: number
  episode: number
} | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'zenox.lol' || host.endsWith('.zenox.lol')) {
      // /media/series-{tmdbId}-{season}-{episode}
      const m = /\/media\/series-(\d+)-(\d+)-(\d+)/i.exec(u.pathname || '')
      if (!m) return null
      return {
        tmdbId: m[1],
        season: Math.max(1, Number(m[2]) || 1),
        episode: Math.max(1, Number(m[3]) || 1),
      }
    }
    if (/rivestream\.ru$/i.test(host)) {
      const tmdbId = String(u.searchParams.get('id') || '').trim()
      const season = Math.max(1, Number(u.searchParams.get('season') || 1) || 1)
      const episode = Math.max(1, Number(u.searchParams.get('episode') || 1) || 1)
      if (!tmdbId) return null
      return { tmdbId, season, episode }
    }
    return null
  } catch {
    return null
  }
}

function episodeKeyLabel(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

export function WebBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const routeState = (location.state as WebLocationState | null) ?? null
  const frameRef = useRef<HTMLDivElement>(null)
  const {
    desktop,
    mode: webMode,
    nav,
    contentTitle,
    setContentTitle,
    address,
    setAddress,
    status,
    stalled,
    retryStalled,
    fullscreen,
    attachFrame,
    detachFrame,
    openUrl,
    goBack,
    goForward,
    reload,
    openInPip,
    setPipOnLeave,
    toggleFullscreen,
    exitFullscreen,
    syncBrowserView,
    unmuteEmbed,
  } = useWebBrowser()
  const { play, armMultiviewAdd, awaitingAdd, cancelMultiviewAdd } =
    usePlayback()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchKind, setSearchKind] = useState<WebSearchKind>('youtube')
  const [toolsOpen, setToolsOpen] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [volumeFlash, setVolumeFlash] = useState<string | null>(null)
  const [volumePercent, setVolumePercent] = useState(100)
  const volumeBeforeMuteRef = useRef(100)
  const [adDock, setAdDock] = useState<{ visible: boolean; url: string }>({
    visible: false,
    url: '',
  })
  const adDockTileRef = useRef<HTMLDivElement>(null)
  const [castAvailable, setCastAvailable] = useState(false)
  const [replayPartBusy, setReplayPartBusy] = useState(false)
  const chromeHideTimer = useRef(0)
  const volumeFlashTimer = useRef(0)
  /** Auto host-hop state for FullMatchShows embeds that keep buffering. */
  const replayHopRef = useRef<{ id: string; banned: Set<string>; hops: number }>({
    id: '',
    banned: new Set(),
    hops: 0,
  })
  const paramUrl = searchParams.get('url')
  const watching = Boolean(paramUrl || nav.url)
  const embedPlayer =
    routeState?.playerMode === 'embed' ||
    isEmbedPlayerHost(paramUrl || nav.url || address)
  /** Sports/replay embeds always get Multi-view / Unmute even if route state was lost. */
  const showStreamChrome =
    embedPlayer || isSportsOrReplayEmbedUrl(paramUrl || nav.url || address)
  const returnTo = routeState?.from || '/'
  const continueWatch = routeState?.continueWatch

  useEffect(() => {
    // Arm leave→PiP for embed / sports routes (pipOnBack can be lost after Expand/HMR).
    const armPip =
      embedPlayer ||
      Boolean(routeState?.pipOnBack) ||
      isSportsOrReplayEmbedUrl(paramUrl || nav.url || address || '')
    setPipOnLeave(armPip)
    return () => {
      // Defer clear so NavigationPiPBridge can still minimize after this page unmounts.
      window.setTimeout(() => setPipOnLeave(false), 80)
    }
  }, [
    embedPlayer,
    setPipOnLeave,
    routeState?.pipOnBack,
    paramUrl,
    nav.url,
    address,
  ])

  useEffect(() => {
    if (!isAndroidCastHost()) {
      setCastAvailable(false)
      return
    }
    let alive = true
    void androidCastAvailable().then((ok) => {
      if (alive) setCastAvailable(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    const android = isAndroidInAppBrowser()
    void (async () => {
      const pctRaw = android
        ? await androidBrowserGetVolume()
        : Number((await window.signalDesktop?.browserGetVolume?.())?.percent) || 100
      const pct = Math.max(0, Math.min(100, Number(pctRaw) || 100))
      setVolumePercent(pct)
      if (pct > 0) volumeBeforeMuteRef.current = pct
    })()
    const stop = window.signalDesktop?.onBrowserVolume?.((state) => {
      const pct = Math.max(0, Math.min(100, Number(state?.percent) || 0))
      setVolumePercent((prev) => {
        if (prev !== pct) {
          setVolumeFlash(pct <= 0 ? 'Muted' : `Vol ${pct}%`)
          window.clearTimeout(volumeFlashTimer.current)
          volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 900)
        }
        return pct
      })
      if (pct > 0) volumeBeforeMuteRef.current = pct
    })
    return () => {
      stop?.()
      window.clearTimeout(volumeFlashTimer.current)
    }
  }, [desktop])

  function setEmbedVolume(percent: number) {
    const pct = Math.max(0, Math.min(100, Math.round(percent)))
    if (pct > 0) volumeBeforeMuteRef.current = pct
    setVolumePercent(pct)
    if (isAndroidInAppBrowser()) void androidBrowserSetVolume(pct)
    else void window.signalDesktop?.browserSetVolume?.(pct)
  }

  function toggleEmbedMute() {
    if (volumePercent <= 0) {
      setEmbedVolume(volumeBeforeMuteRef.current || 100)
      unmuteEmbed()
      return
    }
    volumeBeforeMuteRef.current = volumePercent || 100
    setEmbedVolume(0)
  }

  useEffect(() => {
    if (!desktop) return
    void window.signalDesktop?.browserAdDockStatus?.().then((state) => {
      if (state) setAdDock({ visible: Boolean(state.visible), url: state.url || '' })
    })
    const stop = window.signalDesktop?.onBrowserAdDock?.((state) => {
      setAdDock({ visible: Boolean(state?.visible), url: state?.url || '' })
    })
    return () => stop?.()
  }, [desktop])

  useEffect(() => {
    if (!desktop || !adDock.visible) return
    const el = adDockTileRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) return
      void window.signalDesktop?.browserAdDockSetBounds?.({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    if (document.body) ro.observe(document.body)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [desktop, adDock.visible])

  const VIDEO_PROGRESS_SCRIPT = `(() => {
    try {
      const v = document.querySelector('video');
      if (!v) return null;
      const t = Number(v.currentTime) || 0;
      const d = Number.isFinite(v.duration) && v.duration !== Infinity ? Number(v.duration) : 0;
      const waiting = !!v.seeking || (!v.paused && v.readyState < 3 && (v.networkState === 2 || v.networkState === 1));
      return { t, d, paused: !!v.paused, waiting, rs: v.readyState };
    } catch (_) { return null; }
  })();`

  // Keep Continue watching updated while an embed episode is open.
  // Football replays: if the host keeps buffering, auto-switch to the next verified host.
  useEffect(() => {
    if (!desktop || !continueWatch?.id || !embedPlayer) return
    let cancelled = false
    const openedAt = Date.now()
    const stall = { lastT: -1, since: 0, started: false }
    const matchId = continueWatch.id
    if (replayHopRef.current.id !== matchId) {
      replayHopRef.current = { id: matchId, banned: new Set(), hops: 0 }
    }
    const hopAway = (hosts: NonNullable<ReturnType<typeof replayHostChoices>>) => {
      const hop = replayHopRef.current
      if (!hosts || hosts.hosts.length < 2 || hop.hops >= 3) return false
      const cur = hosts.hosts.find((h) => h.index === hosts.current)
      if (cur) hop.banned.add(cur.host)
      const next =
        hosts.hosts.find(
          (h) => h.index !== hosts.current && !hop.banned.has(h.host) && h.host !== 'playmogo',
        ) ||
        hosts.hosts.find((h) => h.index !== hosts.current && !hop.banned.has(h.host))
      if (!next) return false
      stall.since = 0
      hop.hops += 1
      stall.started = false
      stall.lastT = -1
      setVolumeFlash(`Switching to ${next.label}…`)
      window.clearTimeout(volumeFlashTimer.current)
      volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 2200)
      pickReplayHost(next.index)
      return true
    }
    const tick = async () => {
      if (cancelled) return
      const result = isAndroidInAppBrowser()
        ? await androidBrowserExecute(VIDEO_PROGRESS_SCRIPT)
        : await window.signalDesktop?.browserExecute?.(VIDEO_PROGRESS_SCRIPT)
      if (cancelled || !result?.ok || result.result == null) return
      let data = result.result as {
        t?: number
        d?: number
        paused?: boolean
        waiting?: boolean
      } | string
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data) as {
            t?: number
            d?: number
            paused?: boolean
            waiting?: boolean
          }
        } catch {
          return
        }
      }
      if (!data || typeof data !== 'object') return
      const t = Number(data.t) || 0
      const d = Number(data.d) || 0
      const paused = Boolean(data.paused)
      const waiting = Boolean(data.waiting)
      noteReplayHostProgress(t)
      if (t >= 2) stall.started = true
      // Auto-hop only for FullMatchShows multi-host replays.
      const hop = replayHopRef.current
      const hosts = replayHostChoices(
        continueWatch.replayParts,
        continueWatch.playUrl || paramUrl || nav.url || '',
      )
      if (hosts && hosts.hosts.length > 1 && hop.hops < 3) {
        // Playmogo ads / "Network error" never advance currentTime — hop before
        // waiting for a 2s start that never comes.
        const curHost = hosts.hosts.find((h) => h.index === hosts.current)?.host || ''
        const neverStartMs = curHost === 'playmogo' ? 10_000 : 16_000
        if (!stall.started && t < 1 && Date.now() - openedAt >= neverStartMs) {
          if (hopAway(hosts)) return
        }
        const advanced = t > stall.lastT + 0.35
        if (advanced) {
          stall.lastT = t
          stall.since = 0
        } else if (!paused && stall.started && (waiting || t <= stall.lastT + 0.05)) {
          if (!stall.since) stall.since = Date.now()
          // ~14s stuck buffering after play has started → next verified host.
          if (Date.now() - stall.since >= 14_000) {
            if (hopAway(hosts)) return
          }
        } else if (paused) {
          stall.since = 0
        }
      }
      if (t < 5 && d <= 0) return
      recordWebEmbedContinue({
        ...continueWatch,
        currentTime: Math.max(5, t),
        duration: d >= 60 ? d : undefined,
        playUrl: continueWatch.playUrl || nav.url || paramUrl || undefined,
      })
    }
    void tick()
    const id = window.setInterval(() => {
      void tick()
    }, continueWatch.replayParts ? 4000 : 15000)
    return () => {
      cancelled = true
      window.clearInterval(id)
      void tick()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, embedPlayer, continueWatch?.id, continueWatch?.playlistIndex, continueWatch?.playUrl])

  const displayTitle = (() => {
    // What is being watched, never the Jiyu location / browser placeholder.
    if (continueWatch?.episodeTitle && continueWatch?.title) {
      return `${continueWatch.title} ${continueWatch.episodeTitle}`
    }
    const raw = nav.title?.trim() || ''
    // Guest "about:blank" titles happen after hide({ blank }); native reports
    // "Web browser" when the embed page has no <title>. Ignore both, and hosts.
    const pageTitle =
      raw &&
      !isPlaceholderBrowserTitle(raw) &&
      !isBlankBrowserUrl(raw) &&
      !isEmbedPlayerHost(`https://${raw}/`) &&
      !/fstream365|vsembed|freemovies/i.test(raw)
        ? raw
        : ''
    const catalogTitle =
      continueWatch?.title?.trim() || (embedPlayer ? contentTitle : '')
    if (catalogTitle) {
      // Keep a richer player title (e.g. "Show - S01E03 Name") that names the same title.
      if (pageTitle && pageTitle.toLowerCase().includes(catalogTitle.toLowerCase())) {
        return pageTitle
      }
      return catalogTitle
    }
    if (pageTitle) return pageTitle
    if (embedPlayer) return 'Now playing'
    const hostUrl = [nav.url, address, paramUrl].find((u) => u && !isBlankBrowserUrl(u)) || ''
    return displayHost(hostUrl) || 'Web'
  })()

  // Remember the catalog title so PiP and PiP -> Expand keep naming the content.
  useEffect(() => {
    const title = continueWatch?.episodeTitle && continueWatch?.title
      ? `${continueWatch.title} ${continueWatch.episodeTitle}`
      : continueWatch?.title
    if (title) setContentTitle(title)
  }, [continueWatch?.title, continueWatch?.episodeTitle, setContentTitle])

  function leaveEmbed() {
    if (continueWatch?.id) {
      recordWebEmbedContinue({
        ...continueWatch,
        playUrl: continueWatch.playUrl || nav.url || paramUrl || undefined,
      })
    }
    // Do NOT toggleFullscreen() here — resizing back to the dying frame races PiP
    // and can leave the BrowserView hidden/paused. openInPip exits OS fullscreen.
    exitFullscreen()
    void window.signalDesktop?.browserAdDockClose?.()
    // Prefer the LIVE guest URL (nav/address) over the original continueWatch /
    // route URL — sports embeds hop mirrors while playing; PiPing the seed URL
    // reloads and re-shows "Unwrapping stream…".
    const candidates = [nav.url, address, paramUrl, continueWatch?.playUrl].filter(
      (u): u is string => Boolean(u) && !isBlankBrowserUrl(u),
    )
    const url =
      candidates.find((u) => isEmbedPlayerHost(u) || isSportsOrReplayEmbedUrl(u)) ||
      candidates[0]
    if (embedPlayer || (url && (isEmbedPlayerHost(url) || isSportsOrReplayEmbedUrl(url)))) {
      openInPip(url, displayTitle, {
        navigateTo: returnTo,
      })
      return
    }
    navigate(returnTo)
  }

  async function handleWebCast() {
    const candidate = continueWatch?.playUrl || nav.url || paramUrl || ''
    // Rare path: an embed source eventually handed Jiyu a real media URL.
    if (isCastableMediaUrl(candidate)) {
      setVolumeFlash('Open this title in the player to Cast')
      window.clearTimeout(volumeFlashTimer.current)
      volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 1600)
      return
    }
    setVolumeFlash('No media URL — open screen cast to mirror')
    window.clearTimeout(volumeFlashTimer.current)
    volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 1600)
    try {
      await androidOpenScreenCastSettings()
    } catch {
      setVolumeFlash('Could not open Cast settings')
      window.clearTimeout(volumeFlashTimer.current)
      volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 1600)
    }
  }

  function goEmbedEpisode(delta: number) {
    if (!embedPlayer || !desktop) return
    const fromUrl = parseEmbedEpisode(nav.url || paramUrl || address || '')
    const tmdbId = String(continueWatch?.rivestreamTmdbId || fromUrl?.tmdbId || '').trim()
    if (!tmdbId) return
    const season = Math.max(1, Number(continueWatch?.season || fromUrl?.season || 1) || 1)
    const currentEp = Math.max(1, Number(continueWatch?.episode || fromUrl?.episode || 1) || 1)
    const nextEp = currentEp + delta
    if (nextEp < 1) return
    const maxEp = Number(continueWatch?.playlistLength || 0)
    if (maxEp > 0 && nextEp > maxEp) return
    const nextUrl = zenoxWatchUrl(tmdbId, season, nextEp)
    const nextIndex = Math.max(0, (continueWatch?.playlistIndex ?? currentEp - 1) + delta)
    const nextState: WebLocationState = {
      from: returnTo,
      playerMode: 'embed',
      pipOnBack: routeState?.pipOnBack ?? true,
      continueWatch: {
        ...(continueWatch || {
          id: `rive-${tmdbId}`,
          title: displayTitle || 'Now playing',
          category: 'series',
          playlistIndex: nextIndex,
        }),
        playlistIndex: nextIndex,
        episodeTitle: episodeKeyLabel(season, nextEp),
        playUrl: nextUrl,
        rivestreamTmdbId: tmdbId,
        season,
        episode: nextEp,
        playlistLength: continueWatch?.playlistLength,
      },
    }
    navigate(`/web?url=${encodeURIComponent(nextUrl)}`, {
      replace: true,
      state: nextState,
    })
    void openUrl(nextUrl)
  }

  const embedEpisodeNav = (() => {
    if (!embedPlayer) return null
    const fromUrl = parseEmbedEpisode(nav.url || paramUrl || address || '')
    const tmdbId = continueWatch?.rivestreamTmdbId || fromUrl?.tmdbId
    if (!tmdbId) return null
    const episode = Number(continueWatch?.episode || fromUrl?.episode || 1) || 1
    const maxEp = Number(continueWatch?.playlistLength || 0)
    return {
      canPrev: episode > 1,
      canNext: maxEp <= 0 || episode < maxEp,
    }
  })()

  const replayParts = continueWatch?.replayParts
  const replayPartChoices =
    embedPlayer && replayParts && replayParts.parts.length > 1 ? replayParts.parts : null
  const replayHosts = embedPlayer
    ? replayHostChoices(replayParts, continueWatch?.playUrl || paramUrl || nav.url || '')
    : null
  const replayHostPicker = replayHosts && replayHosts.hosts.length > 1 ? replayHosts : null

  // Remember a replay host once it has kept playing ~45 s (video time keeps up with
  // wall time), so the next replay opens there first.
  const hostTrialRef = useRef<{ url: string; t: number; at: number; saved: boolean } | null>(null)
  function noteReplayHostProgress(t: number) {
    const url = continueWatch?.replayParts ? continueWatch.playUrl || '' : ''
    if (!url) return
    const now = Date.now()
    const trial = hostTrialRef.current
    if (!trial || trial.url !== url || t + 1 < trial.t) {
      hostTrialRef.current = { url, t, at: now, saved: false }
      return
    }
    if (trial.saved) return
    const wall = (now - trial.at) / 1000
    if (wall >= 40 && t - trial.t >= wall * 0.85) {
      trial.saved = true
      rememberReplayHost(url)
    }
  }

  /** Load a replay embed once: the route-param effect must not open it a second time. */
  function openReplayEmbed(
    url: string,
    nextState: WebLocationState,
    options?: { unwrapCover?: boolean },
  ) {
    openedParamRef.current = url
    blankRecoverRef.current = ''
    navigate(`/web?url=${encodeURIComponent(url)}`, { replace: true, state: nextState })
    void openUrl(toAutoplayUrl(url), options)
  }

  /** PPV / live sports: [primary, ...sportsAltSources] — HD/SD/StreamFree for the same match. */
  function sportsSourceList(): Array<{ label: string; url: string }> {
    if (!continueWatch?.playUrl && !paramUrl) return []
    const primary = String(continueWatch?.playUrl || paramUrl || '').trim()
    const rows: Array<{ label: string; url: string }> = []
    if (primary) rows.push({ label: 'Primary', url: primary })
    for (const alt of continueWatch?.sportsAltSources || []) {
      const url = String(alt?.url || '').trim()
      if (!url || rows.some((r) => r.url === url)) continue
      rows.push({ label: String(alt.label || 'Backup').trim() || 'Backup', url })
    }
    return rows
  }

  /**
   * Hop to the next sports alt (Retry, or once when the player first stalls).
   * Uses skipUnwrapCover so a hop does not paint a second unwrap veil.
   * Returns true when a hop was started.
   */
  function tryNextSportsSource(): boolean {
    if (!continueWatch || replayPartBusy) return false
    const list = sportsSourceList()
    if (list.length < 2) return false
    const cur = Math.max(0, Number(continueWatch.sportsSourceIndex) || 0)
    const next = cur + 1
    if (next >= list.length) return false
    const choice = list[next]!
    setVolumeFlash(`Trying ${choice.label}…`)
    window.clearTimeout(volumeFlashTimer.current)
    volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 2200)
    // Same play session — do not paint a second "Unwrapping stream…" cover.
    openReplayEmbed(
      choice.url,
      {
        from: returnTo,
        playerMode: 'embed',
        pipOnBack: routeState?.pipOnBack ?? true,
        skipUnwrapCover: true,
        continueWatch: {
          ...continueWatch,
          playUrl: choice.url,
          sportsSourceIndex: next,
        },
      },
      { unwrapCover: false },
    )
    return true
  }

  const autoHopForStallRef = useRef(false)
  useEffect(() => {
    if (!stalled) {
      autoHopForStallRef.current = false
      return
    }
    if (autoHopForStallRef.current) return
    autoHopForStallRef.current = true
    tryNextSportsSource()
  }, [stalled])

  /** Same part on another host (vidaraa / vixeo / Playmogo) - e.g. when one keeps buffering. */
  function pickReplayHost(index: number) {
    const info = continueWatch?.replayParts
    const hosts = replayHosts
    if (!continueWatch || !info || !hosts || replayPartBusy || index === hosts.current) return
    const choice = hosts.hosts.find((h) => h.index === index)
    if (!choice) return
    openReplayEmbed(choice.url, {
      from: returnTo,
      playerMode: 'embed',
      pipOnBack: routeState?.pipOnBack ?? true,
      continueWatch: {
        ...continueWatch,
        playlistIndex: index,
        playUrl: choice.url,
        replayParts: { ...info, index: hosts.partIndex },
      },
    })
  }

  /** Switch replay part in place (same Playmate-down -> Playmogo fallback as WatchPage). */
  async function pickReplayPart(index: number) {
    const info = continueWatch?.replayParts
    if (!continueWatch || !info || replayPartBusy || index === info.index) return
    setReplayPartBusy(true)
    try {
      const resolved = await resolveFullmatchShowsPlay(
        { id: continueWatch.id, url: '', playlist: info.playlist },
        index,
        // Samsung: hosts that refuse a file:// parent frame would just stay black.
        isTizenTv() ? { avoid: isTizenFrameBlockedEmbed } : undefined,
      )
      if (!resolved.ok) {
        setVolumeFlash('Could not open that part')
        window.clearTimeout(volumeFlashTimer.current)
        volumeFlashTimer.current = window.setTimeout(() => setVolumeFlash(null), 1600)
        return
      }
      const nextParts = resolved.replayParts || { ...info, index }
      const nextState: WebLocationState = {
        from: returnTo,
        playerMode: 'embed',
        pipOnBack: routeState?.pipOnBack ?? true,
        continueWatch: {
          ...continueWatch,
          playlistIndex: nextParts.index,
          playUrl: resolved.url,
          replayParts: nextParts,
        },
      }
      openReplayEmbed(resolved.url, nextState)
    } finally {
      setReplayPartBusy(false)
    }
  }

  function startWebMultiview() {
    const playUrl = toAutoplayUrl(nav.url || address || paramUrl || '')
    if (!playUrl) return
    const webItem: StreamItem = {
      id: continueWatch?.id || `web-${encodeURIComponent(playUrl).slice(0, 80)}`,
      title: continueWatch?.title || displayTitle || 'Web stream',
      description: '',
      url: playUrl,
      category: continueWatch?.category || 'sports',
      poster: continueWatch?.poster,
      tags: ['web-embed', 'live'],
      source: continueWatch?.source,
      sourceKind: continueWatch?.sourceKind || 'builtin',
      transport: 'direct',
      detailUrl: continueWatch?.detailUrl,
    }
    // Seed slot 1, arm add, keep watching in PiP while picking the next match.
    play(webItem, { forceFull: true, replace: true, returnTo: returnTo || '/section/sports' })
    if (awaitingAdd) cancelMultiviewAdd()
    armMultiviewAdd()
    void window.signalDesktop?.browserAdDockClose?.()
    openInPip(playUrl, webItem.title, { navigateTo: '/section/sports' })
  }

  useEffect(() => {
    const frame = frameRef.current
    if (!desktop || !frame) return
    attachFrame(frame)
    return () => {
      detachFrame()
    }
  }, [desktop, attachFrame, detachFrame])

  // Open route URL once per param change. Do not re-fire when openUrl identity
  // changes (nav.url updates recreate callbacks and caused rivestream↔player flash).
  const openedParamRef = useRef('')
  const blankRecoverRef = useRef('')
  const skipUnwrapCover = Boolean(routeState?.skipUnwrapCover)
  useEffect(() => {
    if (!desktop || !paramUrl) return
    if (openedParamRef.current !== paramUrl) {
      openedParamRef.current = paramUrl
      blankRecoverRef.current = ''
      void openUrl(toAutoplayUrl(paramUrl), {
        unwrapCover: skipUnwrapCover ? false : undefined,
      })
      return
    }
    // Hide({ blank }) left about:blank while we still have a play URL — reload once.
    // Skip while PiP/off so openUrl cannot yank mode back to full page on leave.
    if (webMode !== 'page') return
    if (
      (isBlankBrowserUrl(nav.url) || isBlankBrowserUrl(address)) &&
      blankRecoverRef.current !== paramUrl
    ) {
      blankRecoverRef.current = paramUrl
      // Recover within the same play — do not re-show unwrap.
      void openUrl(toAutoplayUrl(paramUrl), { unwrapCover: false })
    }
  }, [desktop, paramUrl, openUrl, nav.url, address, webMode, skipUnwrapCover])

  // StreamCorner: once Bitmovin is fetching HLS in Gecko, promote to Media3.
  const skipMedia3Promote = Boolean(routeState?.skipMedia3Promote)
  useEffect(() => {
    if (!isAndroidMedia3Host() || !isAndroidInAppBrowser()) return
    if (!paramUrl || skipMedia3Promote || webMode !== 'page') return
    let corner = false
    try {
      corner = isStreamCornerHost(new URL(paramUrl).hostname)
    } catch {
      corner = false
    }
    if (!corner) return

    let cancelled = false
    let promoted = false
    const tryPromote = async () => {
      if (cancelled || promoted) return
      const sniffed = await androidSniffCurrentMedia()
      if (cancelled || promoted || !sniffed.ok || !sniffed.mediaUrl) return
      const mediaUrl = String(sniffed.mediaUrl).trim()
      if (!/\.m3u8|format=m3u8|\/hls\//i.test(mediaUrl)) return
      promoted = true
      const cw = routeState?.continueWatch
      const title = cw?.title || contentTitle || 'Live'
      const from = routeState?.from || '/section/sports'
      play(
        {
          id: cw?.id || `streamcorner-media3-${Date.now()}`,
          title,
          description: 'SC · Live',
          category: cw?.category || 'sports',
          url: mediaUrl,
          poster: cw?.poster,
          tags: ['live', 'media3', 'streamcorner'],
          source: cw?.source || 'StreamCorner',
          sourceKind: cw?.sourceKind || 'builtin',
          transport: 'direct',
          detailUrl: cw?.detailUrl || paramUrl,
        },
        { forceFull: true, replace: true, returnTo: from },
      )
      void androidBrowserHide({ blank: false, pause: true })
      navigate('/native-stream', {
        replace: true,
        state: {
          from,
          title,
          mediaUrl,
          referrer: sniffed.referrer || sniffed.pageUrl || paramUrl,
          poster: cw?.poster,
          category: cw?.category || 'sports',
          continueId: cw?.id,
        },
      })
    }

    const startAt = Date.now()
    const tick = window.setInterval(() => {
      if (Date.now() - startAt > 45_000) {
        window.clearInterval(tick)
        return
      }
      void tryPromote()
    }, 1500)
    const first = window.setTimeout(() => void tryPromote(), 2800)
    return () => {
      cancelled = true
      window.clearInterval(tick)
      window.clearTimeout(first)
    }
  }, [
    paramUrl,
    skipMedia3Promote,
    webMode,
    routeState?.continueWatch,
    routeState?.from,
    contentTitle,
    play,
    navigate,
  ])

  // Keep the native BrowserView aligned when chrome shows/hides.
  useEffect(() => {
    if (!desktop || !embedPlayer) return
    const t = window.setTimeout(() => syncBrowserView(), 50)
    return () => window.clearTimeout(t)
  }, [desktop, embedPlayer, chromeVisible, fullscreen, syncBrowserView])

  // Native-like auto-hide chrome for embed watching.
  // Android: GeckoView sits above Capacitor — taps never reach HTML, so a
  // hidden bar can never come back. Keep Multi-view / Mute / PiP visible.
  useEffect(() => {
    if (!embedPlayer || !watching || toolsOpen) {
      setChromeVisible(true)
      return
    }
    if (isAndroidShell()) {
      setChromeVisible(true)
      return
    }
    setChromeVisible(true)
    window.clearTimeout(chromeHideTimer.current)
    if (stalled) return () => window.clearTimeout(chromeHideTimer.current)
    chromeHideTimer.current = window.setTimeout(() => setChromeVisible(false), 2200)
    return () => window.clearTimeout(chromeHideTimer.current)
  }, [embedPlayer, watching, toolsOpen, nav.url, fullscreen, stalled])

  useEffect(() => {
    if (!embedPlayer) return
    const onKey = (e: KeyboardEvent) => {
      // F11 is handled in WebBrowserContext (single listener — dual handlers double-toggled).
      if (e.key !== 'Escape') return
      // First Escape exits fullscreen; second leaves the embed.
      // Use exit-only — never toggle (Context also listens; toggle would re-enter).
      if (fullscreen) {
        e.preventDefault()
        e.stopPropagation()
        exitFullscreen()
        return
      }
      leaveEmbed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // leaveEmbed closes over latest pip/fullscreen state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedPlayer, fullscreen, returnTo, displayTitle, nav.url, address, paramUrl, openInPip, exitFullscreen, toggleFullscreen])

  // Android hardware Back — leave embed into PiP (same as on-screen ← Back).
  useEffect(() => {
    const onLeave = () => {
      if (continueWatch?.id) {
        recordWebEmbedContinue({
          ...continueWatch,
          playUrl: continueWatch.playUrl || nav.url || paramUrl || undefined,
        })
      }
      exitFullscreen()
      void window.signalDesktop?.browserAdDockClose?.()
      leaveEmbed()
    }
    window.addEventListener(ANDROID_LEAVE_WEB_EMBED_EVENT, onLeave)
    return () => window.removeEventListener(ANDROID_LEAVE_WEB_EMBED_EVENT, onLeave)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fullscreen,
    returnTo,
    displayTitle,
    nav.url,
    address,
    paramUrl,
    openInPip,
    exitFullscreen,
    continueWatch,
  ])

  const host = displayHost(nav.url || address)
  const zenoxEmbed =
    embedPlayer &&
    isZenoxUrl(nav.url || address || continueWatch?.playUrl || paramUrl || '')

  // Desktop Full: input over the native view never reaches this div, so the guest
  // page reports it (WebBrowserContext poll) and the bar comes back.
  const revealChromeRef = useRef<() => void>(() => {})
  revealChromeRef.current = revealChrome
  useEffect(() => {
    const onActivity = () => revealChromeRef.current()
    window.addEventListener(WEB_GUEST_ACTIVITY_EVENT, onActivity)
    return () => window.removeEventListener(WEB_GUEST_ACTIVITY_EVENT, onActivity)
  }, [])

  function revealChrome() {
    if (!embedPlayer || isAndroidShell()) return
    setChromeVisible(true)
    window.clearTimeout(chromeHideTimer.current)
    chromeHideTimer.current = window.setTimeout(() => {
      if (!toolsOpen && !stalled) setChromeVisible(false)
    }, 2200)
  }

  return (
    <div
      className={`page web-browser-page${watching && !toolsOpen ? ' is-watching' : ''}${
        fullscreen ? ' is-fullscreen' : ''
      }${embedPlayer ? ' is-embed-player' : ''}${
        embedPlayer && watching && !chromeVisible && !toolsOpen && !stalled ? ' chrome-hidden' : ''
      }`}
      onMouseMove={revealChrome}
      onClick={revealChrome}
    >
      {!watching && (
        <header className="page-header web-browser-header">
          <p className="eyebrow">Desktop</p>
          <h1>Web browser</h1>
          <p className="lede">
            Search YouTube or the web, then use <strong>PiP</strong> to keep watching while you
            browse Jiyu.
          </p>
        </header>
      )}

      {!desktop && !(isTizenTv() && (paramUrl || nav.url)) && (
        <div className="web-frame-banner">
          <p>In-app browser is unavailable on this build.</p>
        </div>
      )}

      <div className="web-chrome">
        <div className="web-chrome-bar">
          <div className="web-chrome-nav">
            {embedPlayer ? (
              <button
                type="button"
                className="ghost-btn control-btn"
                onClick={leaveEmbed}
                aria-label="Back (continues in picture-in-picture)"
              >
                ← Back
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  disabled={!desktop || !nav.canGoBack}
                  onClick={goBack}
                  aria-label="Back"
                >
                  ←
                </button>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  disabled={!desktop || !nav.canGoForward}
                  onClick={goForward}
                  aria-label="Forward"
                >
                  →
                </button>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  disabled={!desktop}
                  onClick={reload}
                  aria-label="Reload"
                >
                  ↻
                </button>
              </>
            )}
          </div>

          <div className="web-chrome-meta" title={embedPlayer ? displayTitle : nav.url || address}>
            {zenoxEmbed ? (
              <img
                className="web-chrome-brand"
                src="/brands/zenox.png"
                alt="zenox."
                draggable={false}
              />
            ) : null}
            <strong className="web-chrome-title">{displayTitle}</strong>
            {!embedPlayer && host ? <span className="web-chrome-host">{host}</span> : null}
            {replayPartChoices || replayHostPicker ? (
              <span className="web-replay-pickers">
            {replayPartChoices ? (
              <label className="web-replay-part" title="Choose which part of the match to watch">
                <span className="sr-only">Replay part</span>
                <select
                  value={replayParts!.index}
                  disabled={!desktop || replayPartBusy}
                  onFocus={() => {
                    // Desktop auto-hide must not pull the bar away mid-pick.
                    window.clearTimeout(chromeHideTimer.current)
                    setChromeVisible(true)
                  }}
                  onBlur={revealChrome}
                  onChange={(e) => void pickReplayPart(Number(e.target.value))}
                >
                  {replayPartChoices.map((part) => (
                    <option key={part.index} value={part.index}>
                      {part.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {replayHostPicker ? (
              <label
                className="web-replay-part web-replay-host"
                title="Same match on another host - try one if this keeps buffering"
              >
                <span className="sr-only">Replay host</span>
                <select
                  value={replayHostPicker.current}
                  disabled={!desktop || replayPartBusy}
                  onFocus={() => {
                    window.clearTimeout(chromeHideTimer.current)
                    setChromeVisible(true)
                  }}
                  onBlur={revealChrome}
                  onChange={(e) => pickReplayHost(Number(e.target.value))}
                >
                  {replayHostPicker.hosts.map((h) => (
                    <option key={h.index} value={h.index}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
              </span>
            ) : null}
          </div>

          <div className="web-chrome-actions">
            {!embedPlayer && (
              <button
                type="button"
                className={`ghost-btn control-btn${toolsOpen ? ' is-active' : ''}`}
                disabled={!desktop}
                onClick={() => setToolsOpen((open) => !open)}
              >
                {toolsOpen ? 'Hide tools' : 'Browse'}
              </button>
            )}
            {desktop && watching ? (
              <>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  onClick={toggleEmbedMute}
                  title={volumePercent <= 0 ? 'Unmute' : 'Mute'}
                  aria-label={volumePercent <= 0 ? 'Unmute' : 'Mute'}
                >
                  {volumePercent <= 0 ? 'Unmute' : 'Mute'}
                </button>
                <label className="volume-control web-volume-control" title="Click or drag">
                  <span className="sr-only">Volume</span>
                  <VolumeSlider value={volumePercent} onChange={setEmbedVolume} />
                </label>
              </>
            ) : null}
            {showStreamChrome ? (
              <button
                type="button"
                className={`ghost-btn control-btn${awaitingAdd ? ' is-armed' : ''}`}
                disabled={!desktop}
                onClick={startWebMultiview}
                title="Watch another stream beside this one"
              >
                Multi-view
              </button>
            ) : null}
            {castAvailable && showStreamChrome ? (
              <button
                type="button"
                className="ghost-btn control-btn"
                onClick={() => void handleWebCast()}
                title="Sports embeds have no Cast URL — open system screen cast to mirror"
              >
                Cast
              </button>
            ) : null}
            {embedEpisodeNav ? (
              <>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  disabled={!desktop || !embedEpisodeNav.canPrev}
                  onClick={() => goEmbedEpisode(-1)}
                  title="Previous episode"
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="ghost-btn control-btn"
                  disabled={!desktop || !embedEpisodeNav.canNext}
                  onClick={() => goEmbedEpisode(1)}
                  title="Next episode"
                >
                  Next
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ghost-btn control-btn"
              disabled={!desktop}
              onClick={() => openInPip(nav.url || address, nav.title)}
            >
              PiP
            </button>
            <button
              type="button"
              className="primary-btn control-btn"
              disabled={!desktop}
              onClick={toggleFullscreen}
            >
              {fullscreen ? 'Exit' : 'Full'}
            </button>
          </div>
        </div>

        {(toolsOpen || !watching) && (
          <div className="web-chrome-tools">
            <form
              className="web-search-form"
              onSubmit={(e) => {
                e.preventDefault()
                void openUrl(buildSearchUrl(searchQuery, searchKind))
              }}
            >
              <div className="web-search-kind" role="group" aria-label="Search target">
                <button
                  type="button"
                  className={
                    searchKind === 'youtube' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'
                  }
                  onClick={() => setSearchKind('youtube')}
                >
                  YouTube
                </button>
                <button
                  type="button"
                  className={
                    searchKind === 'web' ? 'web-search-kind-btn is-active' : 'web-search-kind-btn'
                  }
                  onClick={() => setSearchKind('web')}
                >
                  Web
                </button>
              </div>
              <input
                className="search-input web-search-input"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchKind === 'youtube' ? 'Search YouTube…' : 'Search the web…'}
                aria-label={searchKind === 'youtube' ? 'Search YouTube' : 'Search the web'}
                disabled={!desktop}
              />
              <button
                type="submit"
                className="primary-btn"
                disabled={!desktop || !searchQuery.trim()}
              >
                Search
              </button>
            </form>

            <form
              className="web-address-form"
              onSubmit={(e) => {
                e.preventDefault()
                const target = toAutoplayUrl(address)
                setSearchParams(target === DEFAULT_URL ? {} : { url: target }, { replace: true })
                void openUrl(target)
              }}
            >
              <input
                className="search-input web-address-input"
                type="url"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="https://…"
                aria-label="Address"
              />
              <button type="submit" className="primary-btn" disabled={!desktop}>
                Go
              </button>
            </form>
          </div>
        )}
      </div>

      {status && !(!desktop && isTizenTv() && (paramUrl || nav.url)) && (
        <div className="web-status">
          <span>{status}</span>
          {stalled ? (
            <button
              type="button"
              className="ghost-btn control-btn web-status-retry"
              onClick={() => {
                if (tryNextSportsSource()) return
                retryStalled()
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      )}

      {adDock.visible ? (
        <div className="web-ad-dock-bar" role="status">
          <div ref={adDockTileRef} className="web-ad-dock-tile" aria-hidden="true" />
          <span className="web-ad-dock-copy">
            Ad in the corner box (muted)
            {adDock.url ? (
              <>
                {' '}
                <span className="web-ad-dock-host">{displayHost(adDock.url)}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            className="ghost-btn control-btn"
            onClick={() => void window.signalDesktop?.browserAdDockClose?.()}
          >
            Close ad
          </button>
        </div>
      ) : null}

      <div className={`web-player-tile ${fullscreen ? 'web-player-tile-fs' : ''} ${desktop ? 'is-live' : ''}`}>
        <div
          ref={frameRef}
          className={`web-frame web-frame-tile ${desktop ? 'web-frame-embed-active' : ''}`}
          aria-label="Browser tile"
        >
          {!desktop && isTizenTv() && (paramUrl || nav.url) ? (
            <TizenWebFrame url={paramUrl || nav.url} title={displayTitle} />
          ) : null}
          {!desktop && !(isTizenTv() && (paramUrl || nav.url)) && (
            <div className="web-frame-fallback">
              <p>Loading in-app browser…</p>
            </div>
          )}
        </div>
        {volumeFlash ? <div className="web-volume-flash">{volumeFlash}</div> : null}
        {stalled ? (
          <div className="web-stream-offline" role="status">
            <p>{status || 'This stream is offline. Tap Retry, or go Back and pick another listing.'}</p>
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                if (tryNextSportsSource()) return
                retryStalled()
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
