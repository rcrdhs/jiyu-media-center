import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { recordWebEmbedContinue } from '../lib/continueWatching'
import { isZenoxUrl, zenoxWatchUrl } from '../lib/zenox'
import {
  buildSearchUrl,
  isEmbedPlayerHost,
  isSportsOrReplayEmbedUrl,
  toAutoplayUrl,
  type WebSearchKind,
} from '../lib/webBrowser'
import type { CategoryId, StreamItem, StreamSourceKind, StreamTransport } from '../types'
import { VolumeSlider } from '../components/VolumeSlider'
import { ANDROID_LEAVE_WEB_EMBED_EVENT, isAndroidShell } from '../lib/androidFullscreen'
import {
  androidBrowserExecute,
  androidBrowserGetVolume,
  androidBrowserSetVolume,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'
import {
  androidCastAvailable,
  androidOpenScreenCastSettings,
  isAndroidCastHost,
  isCastableMediaUrl,
} from '../lib/androidCast'

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
}

type WebLocationState = {
  from?: string
  playerMode?: 'embed' | string
  /** Embed Back: drop into PiP and return to Sports / show. */
  pipOnBack?: boolean
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
    nav,
    address,
    setAddress,
    status,
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
  const [castAvailable, setCastAvailable] = useState(false)
  const chromeHideTimer = useRef(0)
  const volumeFlashTimer = useRef(0)
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
    // Arm leave→PiP for any embed player (route pipOnBack can be lost after Expand/HMR).
    setPipOnLeave(embedPlayer)
    return () => {
      // Defer clear so NavigationPiPBridge can still minimize after this page unmounts.
      window.setTimeout(() => setPipOnLeave(false), 80)
    }
  }, [embedPlayer, setPipOnLeave])

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

  const VIDEO_PROGRESS_SCRIPT = `(() => {
    try {
      const v = document.querySelector('video');
      if (!v) return null;
      const t = Number(v.currentTime) || 0;
      const d = Number.isFinite(v.duration) && v.duration !== Infinity ? Number(v.duration) : 0;
      return { t, d, paused: !!v.paused };
    } catch (_) { return null; }
  })();`

  // Keep Continue watching updated while an embed episode is open.
  useEffect(() => {
    if (!desktop || !continueWatch?.id || !embedPlayer) return
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      const result = isAndroidInAppBrowser()
        ? await androidBrowserExecute(VIDEO_PROGRESS_SCRIPT)
        : await window.signalDesktop?.browserExecute?.(VIDEO_PROGRESS_SCRIPT)
      if (cancelled || !result?.ok || result.result == null) return
      let data = result.result as { t?: number; d?: number } | string
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data) as { t?: number; d?: number }
        } catch {
          return
        }
      }
      if (!data || typeof data !== 'object') return
      const t = Number(data.t) || 0
      const d = Number(data.d) || 0
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
    }, 15000)
    return () => {
      cancelled = true
      window.clearInterval(id)
      void tick()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, embedPlayer, continueWatch?.id, continueWatch?.playlistIndex])

  const displayTitle = (() => {
    if (continueWatch?.episodeTitle && continueWatch?.title) {
      return `${continueWatch.title} ${continueWatch.episodeTitle}`
    }
    const raw = nav.title?.trim() || ''
    // Prefer episode title from the player; never fall back to the stream host.
    if (raw && !isEmbedPlayerHost(`https://${raw}/`) && !/fstream365|vsembed|freemovies/i.test(raw)) {
      return raw
    }
    if (continueWatch?.title) return continueWatch.title
    if (embedPlayer) return 'Now playing'
    return displayHost(nav.url || address) || 'Web'
  })()

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
    // Prefer the real player URL over an ad hop that polluted nav.url.
    const candidates = [nav.url, address, continueWatch?.playUrl, paramUrl]
    const url =
      candidates.find((u) => u && isEmbedPlayerHost(u)) ||
      candidates.find(Boolean) ||
      undefined
    if (embedPlayer || (url && isEmbedPlayerHost(url))) {
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
  useEffect(() => {
    if (!desktop || !paramUrl) return
    if (openedParamRef.current === paramUrl) return
    openedParamRef.current = paramUrl
    void openUrl(toAutoplayUrl(paramUrl))
  }, [desktop, paramUrl, openUrl])

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
    chromeHideTimer.current = window.setTimeout(() => setChromeVisible(false), 2200)
    return () => window.clearTimeout(chromeHideTimer.current)
  }, [embedPlayer, watching, toolsOpen, nav.url, fullscreen])

  useEffect(() => {
    if (!embedPlayer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
        return
      }
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

  function revealChrome() {
    if (!embedPlayer || isAndroidShell()) return
    setChromeVisible(true)
    window.clearTimeout(chromeHideTimer.current)
    chromeHideTimer.current = window.setTimeout(() => {
      if (!toolsOpen) setChromeVisible(false)
    }, 2200)
  }

  return (
    <div
      className={`page web-browser-page${watching && !toolsOpen ? ' is-watching' : ''}${
        fullscreen ? ' is-fullscreen' : ''
      }${embedPlayer ? ' is-embed-player' : ''}${
        embedPlayer && watching && !chromeVisible && !toolsOpen ? ' chrome-hidden' : ''
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

      {!desktop && (
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

      {status && (
        <div className="web-status">
          <span>{status}</span>
        </div>
      )}

      {adDock.visible ? (
        <div className="web-ad-dock-bar" role="status">
          <span>
            Muted ad parked
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
          {!desktop && (
            <div className="web-frame-fallback">
              <p>Loading in-app browser…</p>
            </div>
          )}
        </div>
        {volumeFlash ? <div className="web-volume-flash">{volumeFlash}</div> : null}
      </div>
    </div>
  )
}
