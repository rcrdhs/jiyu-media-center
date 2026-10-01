import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AUTOPLAY_WITH_SOUND_SCRIPT,
  BLOCK_GUEST_FULLSCREEN_SCRIPT,
  EMBED_AD_HIDE_SCRIPT,
  EMBED_STRIP_SANDBOX_SCRIPT,
  EMBED_UNMUTE_OVERLAY_SCRIPT,
  RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT,
  RIVESTREAM_PREFER_DIRECT_SCRIPT,
  RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT,
  isDesktopApp,
  isCloudflareChallengeTarget,
  isBlankBrowserUrl,
  isEmbedPlayerHost,
  isSportsOrReplayEmbedUrl,
  sameBrowserPageUrl,
  toAutoplayUrl,
} from '../lib/webBrowser'
import { RIVESTREAM_EMBED_AUTO_SCRIPT } from '../lib/rivestreamEmbedAuto'
import { cinetaroPlaybackUrl, isCinetaroCatalogPageUrl } from '../lib/cinetaro'
import {
  androidBrowserExecute,
  androidBrowserTapPlay,
  androidBrowserGoBack,
  androidBrowserGoForward,
  androidBrowserHide,
  androidBrowserNavigate,
  androidBrowserOnNav,
  androidBrowserReload,
  androidBrowserSetBounds,
  androidBrowserShow,
  isAndroidInAppBrowser,
  isInAppBrowserAvailable,
} from '../lib/androidBrowser'
import {
  enterOsFullscreen,
  exitOsFullscreen,
  getFullscreenOwner,
  syncFullscreenOwnerFromOs,
} from '../lib/fullscreenSession'
import type { BrowserBounds, BrowserNavState } from '../types'

export type WebBrowserMode = 'off' | 'page' | 'pip'

const PIP_WIDTH = 380
const PIP_HEIGHT = 180
const PIP_CHROME = 44
const PIP_MARGIN = 12

function readSafeBottom(): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)'
  document.body.appendChild(probe)
  const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0
  probe.remove()
  return px
}
const FULLSCREEN_CHROME = 48

type WebBrowserContextValue = {
  desktop: boolean
  mode: WebBrowserMode
  nav: BrowserNavState
  address: string
  setAddress: (value: string) => void
  status: string | null
  setStatus: (value: string | null) => void
  fullscreen: boolean
  /** Bind the native browser to the page tile (no reload if already on a URL). */
  attachFrame: (frame: HTMLElement) => void
  detachFrame: () => void
  openUrl: (raw: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  openInPip: (url?: string, title?: string, options?: { navigateTo?: string }) => void
  /** When true, leaving /web for another route keeps the embed in web PiP. */
  setPipOnLeave: (enabled: boolean) => void
  /** Move an active embed watch session into PiP without changing routes. */
  minimizeActiveEmbedToPip: () => boolean
  expandFromPip: () => void
  closeBrowser: () => void
  /** Hide single-player web view without blanking — multi-view tiles take over. */
  parkForMultiview: () => void
  toggleFullscreen: () => void
  /** Exit-only — never re-enter (Esc / force-exit). */
  exitFullscreen: () => void
  /** Re-fit the native browser view to the page tile or fullscreen. */
  syncBrowserView: () => void
  /** Unmute / kick embed playback (Streamed, fstream, vsembed, …). */
  unmuteEmbed: () => void
}

const WebBrowserContext = createContext<WebBrowserContextValue | null>(null)

/** CSS→native overlay bounds; on Android, clamp away from sidebar chrome. */
export function boundsFromElement(el: HTMLElement): BrowserBounds {
  const rect = el.getBoundingClientRect()
  let x = Math.round(rect.left)
  let y = Math.round(rect.top)
  let width = Math.max(1, Math.round(rect.width))
  let height = Math.max(1, Math.round(rect.height))

  // Android: native Gecko sits above Capacitor — never cover the sidebar chrome
  // (logo / Sections menu). After rotation, frame rects can briefly overlap it.
  // Multi-view owns the whole window, so tiles must use the full stage.
  try {
    if (document.documentElement.classList.contains('multiview-open')) {
      return { x, y, width, height }
    }
    const chrome = document.querySelector(
      '.web-browser-page .web-chrome',
    ) as HTMLElement | null
    if (chrome) {
      const cr = chrome.getBoundingClientRect()
      const minY = Math.ceil(cr.bottom)
      if (cr.height > 8 && y < minY) {
        height = Math.max(1, height - (minY - y))
        y = minY
      }
    }
    const sidebar = document.querySelector('.sidebar.sidebar-android') as HTMLElement | null
    if (sidebar) {
      const sr = sidebar.getBoundingClientRect()
      const landscape = window.matchMedia('(orientation: landscape)').matches
      if (landscape) {
        const minX = Math.ceil(sr.right)
        if (x < minX) {
          width = Math.max(1, width - (minX - x))
          x = minX
        }
      } else {
        const minY = Math.ceil(sr.bottom)
        if (y < minY) {
          height = Math.max(1, height - (minY - y))
          y = minY
        }
      }
    }
  } catch {
    /* ignore */
  }

  return { x, y, width, height }
}

/** Shared geometry for native stage + HTML chrome so they stay pixel-aligned. */
export function getPipLayout() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = Math.max(PIP_MARGIN, Math.round(readSafeBottom()) + 8)
  // Android: one standard corner size so PiP never fills half the screen.
  const android =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('is-android')
  const width = android
    ? Math.round(Math.min(280, Math.max(200, vw - margin * 2 - 24)))
    : vw < 720
      ? Math.round(Math.min(vw - 24, 420))
      : Math.round(Math.min(PIP_WIDTH, vw * 0.42))
  const stageHeight = android
    ? Math.round(width * (9 / 16))
    : PIP_HEIGHT
  const chromeHeight = PIP_CHROME
  const x = Math.round(vw - width - margin)
  const stageY = Math.round(vh - stageHeight - margin)
  return {
    width,
    margin,
    stageHeight,
    chromeHeight,
    x,
    stageY,
    chromeY: stageY - chromeHeight,
  }
}

function pipStageBounds(): BrowserBounds {
  const { x, stageY, width, stageHeight } = getPipLayout()
  return { x, y: stageY, width, height: stageHeight }
}

/** PiP fullscreen — never full-bleed; native view must not cover HTML chrome. */
function pipFullscreenBounds(): BrowserBounds {
  return fullscreenBounds({ fullBleed: false })
}

function topChromeClearance(): number {
  try {
    const chrome = document.querySelector('.web-browser-page .web-chrome') as HTMLElement | null
    const bottom = chrome ? Math.ceil(chrome.getBoundingClientRect().bottom) : 0
    return Math.max(FULLSCREEN_CHROME, bottom)
  } catch {
    return FULLSCREEN_CHROME
  }
}

function fullscreenBounds(opts?: { fullBleed?: boolean }): BrowserBounds {
  const top = opts?.fullBleed ? 0 : topChromeClearance()
  return {
    x: 0,
    y: top,
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight - top)),
  }
}

/** Fit a stream inside the screen so Full doesn't crop a 16:9 picture on a phone. */
function letterboxedFullscreenBounds(aspect: number): BrowserBounds {
  const ratio = aspect > 0.4 && aspect < 3.5 ? aspect : 16 / 9
  const vw = Math.max(1, window.innerWidth)
  const vh = Math.max(1, window.innerHeight)
  const top = topChromeClearance()
  const availH = Math.max(1, vh - top)
  let width = vw
  let height = width / ratio
  if (height > availH) {
    height = availH
    width = height * ratio
  }
  return {
    x: Math.max(0, Math.round((vw - width) / 2)),
    y: Math.max(0, Math.round(top + (availH - height) / 2)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

/** Ask the embed for its real frame size and stop it covering/cropping the picture. */
const GUEST_VIDEO_ASPECT_SCRIPT = `(() => {
  try {
    const seen = new Set();
    const walk = (doc, depth) => {
      if (!doc || depth > 4 || seen.has(doc)) return null;
      seen.add(doc);
      const vids = doc.querySelectorAll('video');
      let found = null;
      for (const v of vids) {
        v.style.setProperty('object-fit', 'contain', 'important');
        v.style.setProperty('object-position', 'center center', 'important');
        if (!found && v.videoWidth > 8 && v.videoHeight > 8) found = v;
      }
      if (found) return found.videoWidth + 'x' + found.videoHeight;
      const frames = doc.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const hit = walk(frame.contentDocument, depth + 1);
          if (hit) return hit;
        } catch (e) {}
      }
      return null;
    };
    return walk(document, 0);
  } catch (e) {
    return null;
  }
})()`

function sameWatchUrl(a: string, b: string): boolean {
  return sameBrowserPageUrl(a, b)
}

export function WebBrowserProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  /** Electron or Android overlay — UI treats either as a working in-app browser. */
  const desktop = isInAppBrowserAvailable()
  const electron = isDesktopApp()
  const android = isAndroidInAppBrowser()
  const modeRef = useRef<WebBrowserMode>('off')
  const frameRef = useRef<HTMLElement | null>(null)
  const autoplayTimers = useRef<number[]>([])
  /** Cancels a pending detach when React Strict Mode remounts or Expand re-attaches. */
  const detachGeneration = useRef(0)
  /** Intentional close — do not resurrect a blanked session as last-chance PiP. */
  const suppressLastChancePipRef = useRef(false)
  const pipOnLeaveRef = useRef(false)
  /** Latest embed URL for detachFrame last-chance PiP (nav state can lag unmount). */
  const navUrlRef = useRef('')
  const [mode, setMode] = useState<WebBrowserMode>('off')
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenRef = useRef(false)
  const embedAspectRef = useRef(16 / 9)
  const [address, setAddress] = useState('https://www.youtube.com/')
  const [status, setStatus] = useState<string | null>(
    desktop ? null : 'In-app browser unavailable on this platform',
  )
  const [nav, setNav] = useState<BrowserNavState>({
    url: '',
    title: 'Web browser',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })

  modeRef.current = mode
  fullscreenRef.current = fullscreen
  navUrlRef.current = nav.url || address

  const clearAutoplayTimers = useCallback(() => {
    for (const id of autoplayTimers.current) window.clearTimeout(id)
    autoplayTimers.current = []
  }, [])

  const lastNudgeUrlRef = useRef('')
  const lastNudgeAtRef = useRef(0)
  const cinetaroRewriteRef = useRef('')
  const navUrlForNudgeRef = useRef(nav.url || address)
  navUrlForNudgeRef.current = nav.url || address
  /** Last real player URL — ads can replace nav.url and must not drop PiP. */
  const lastEmbedUrlRef = useRef('')

  const nudgePlayback = useCallback((urlOverride?: string) => {
    if (!desktop) return
    const runScript = (script: string) => {
      if (electron) void window.signalDesktop?.browserExecute?.(script)
      else if (android) void androidBrowserExecute(script)
    }
    const url = (urlOverride || navUrlForNudgeRef.current || '').trim()
    if (isCinetaroCatalogPageUrl(url) || isCloudflareChallengeTarget(url, nav.title)) return
    const now = Date.now()
    // Always re-hide Rive server chrome — autoplay throttle must not skip this.
    if (/rivestream\.(ru|app)/i.test(url) || /vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(url)) {
      if (/rivestream\.(ru|app)/i.test(url)) {
        runScript(RIVESTREAM_PREFER_DIRECT_SCRIPT)
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
        runScript(RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT)
      }
      // Auto-pick Direct then rotate Embed hosts (Electron main also installs this).
      runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
    }
    // Sports pages fire did-stop-loading constantly for ads — don't re-arm a
    // 12s execute storm on every subframe finish. Android: shorter gate so a
    // failed early kick can retry when the player finally mounts.
    const gateMs = android ? 2500 : 8000
    if (url && url === lastNudgeUrlRef.current && now - lastNudgeAtRef.current < gateMs) {
      return
    }
    lastNudgeUrlRef.current = url
    lastNudgeAtRef.current = now
    clearAutoplayTimers()
    // Live sports + Replay VODs:
    // Electron: main-process owns muted→play + one center click.
    // Android: mirror that here (no main process).
    const isSportsOrReplay = isSportsOrReplayEmbedUrl(url)
    const runCore = () => {
      runScript(BLOCK_GUEST_FULLSCREEN_SCRIPT)
      if (!isSportsOrReplay || android) {
        runScript(AUTOPLAY_WITH_SOUND_SCRIPT)
      }
    }
    const runAds = () => {
      runScript(EMBED_STRIP_SANDBOX_SCRIPT)
      runScript(EMBED_AD_HIDE_SCRIPT)
      // Desktop hides site "CLICK UNMUTE" in favor of Jiyu chrome. On Android the
      // overlay Gecko view used to bury that chrome — keep the site CTA as backup.
      if (!android) runScript(EMBED_UNMUTE_OVERLAY_SCRIPT)
      if (/rivestream\.(ru|app)/i.test(url)) {
        runScript(RIVESTREAM_PREFER_DIRECT_SCRIPT)
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
        runScript(RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT)
        runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
      } else if (/vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(url)) {
        runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
      } else {
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
      }
    }
    const runClick = () => {
      if (isSportsOrReplay && electron) return
      if (electron) void window.signalDesktop?.browserClickCenter?.()
      else if (android) void androidBrowserTapPlay()
    }
    const sportsKick = (aggressive = false) => {
      if (!android || !isSportsOrReplay) return
      void (async () => {
        await androidBrowserExecute(EMBED_STRIP_SANDBOX_SCRIPT)
        await androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
        const check = await androidBrowserExecute(`(() => {
          try {
            const v = Array.from(document.querySelectorAll('video')).find(
              (m) => !m.paused && !m.ended
            );
            return v ? 'playing' : 'idle';
          } catch (_) { return 'idle'; }
        })();`)
        if (check?.result === 'playing') return
        // play() from the page is not a user gesture, so the play glyph stays up.
        // tapPlay sends the two taps these embeds need, and skips a live stream.
        if (aggressive) await androidBrowserTapPlay()
      })()
    }
    // Strip sandbox before any play kick — hosts block sandboxed iframes.
    runScript(EMBED_STRIP_SANDBOX_SCRIPT)
    runCore()
    if (!isSportsOrReplay) runClick()
    runAds()
    if (isSportsOrReplay) {
      if (android) {
        // Stagger kicks — first paint often has no <video> yet.
        sportsKick(false)
        autoplayTimers.current.push(window.setTimeout(() => sportsKick(false), 700))
        autoplayTimers.current.push(window.setTimeout(() => sportsKick(false), 3200))
        // Page load is not the play button. Wait 3s, then keep looking until it is on screen.
        autoplayTimers.current.push(
          window.setTimeout(() => {
            void androidBrowserTapPlay()
          }, 3000),
        )
      }
      autoplayTimers.current.push(window.setTimeout(runAds, 400))
      autoplayTimers.current.push(window.setTimeout(runAds, 800))
      autoplayTimers.current.push(window.setTimeout(runAds, 2800))
      return
    }
    autoplayTimers.current.push(window.setTimeout(runCore, 600))
    autoplayTimers.current.push(window.setTimeout(runClick, 900))
    autoplayTimers.current.push(window.setTimeout(runAds, 800))
    autoplayTimers.current.push(window.setTimeout(runCore, 1600))
    autoplayTimers.current.push(window.setTimeout(runClick, 2000))
    autoplayTimers.current.push(window.setTimeout(runAds, 2800))
    autoplayTimers.current.push(window.setTimeout(runClick, 4000))
    autoplayTimers.current.push(window.setTimeout(runCore, 5500))
    autoplayTimers.current.push(window.setTimeout(runAds, 7000))
  }, [android, clearAutoplayTimers, desktop, electron])

  /**
   * Resize into the corner pauses Gecko. Call play() on a paused video.
   * Do not center-tap: that toggles a stream that is already running.
   */
  const resumePipPlayback = useCallback(() => {
    if (!android || !desktop) return
    const page = navUrlForNudgeRef.current || ''
    if (isCinetaroCatalogPageUrl(page) || isCloudflareChallengeTarget(page, nav.title)) return
    window.setTimeout(() => {
      void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
    }, 400)
    window.setTimeout(() => {
      void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
    }, 1400)
  }, [android, desktop, nav.title])

  /** Soft-resume after PiP→page / resize — video.play() only; avoid toggle-clicks. */
  const softResumePlayback = useCallback(() => {
    if (!android || !desktop) return
    const page = navUrlForNudgeRef.current || ''
    if (isCinetaroCatalogPageUrl(page) || isCloudflareChallengeTarget(page, nav.title)) return
    void (async () => {
      const play = await androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
      const playResult = String(play?.result ?? '')
      const check = await androidBrowserExecute(`(() => {
        try {
          const v = Array.from(document.querySelectorAll('video')).find(
            (m) => !m.paused && !m.ended && m.readyState > 1
          );
          return v ? 'playing' : 'idle';
        } catch (_) { return 'idle'; }
      })();`)
      if (check?.result === 'playing') return
      if (
        playResult.includes('play-with-sound') ||
        playResult.includes('play-kept-muted') ||
        playResult.includes('already')
      ) {
        window.setTimeout(() => {
          void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
        }, 350)
        return
      }
      await androidBrowserTapPlay()
      window.setTimeout(() => {
        void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
      }, 350)
    })()
  }, [android, desktop, nav.title])

  const showAt = useCallback(
    async (bounds: BrowserBounds) => {
      if (!desktop) return
      if (electron) await window.signalDesktop?.browserShow?.(bounds)
      else if (android) await androidBrowserShow(bounds)
    },
    [android, desktop, electron],
  )

  const syncPageBounds = useCallback(async () => {
    if (!desktop || modeRef.current !== 'page' || fullscreen) return
    const frame = frameRef.current
    if (!frame) return
    const bounds = boundsFromElement(frame)
    if (bounds.width < 8 || bounds.height < 8) return
    if (electron) await window.signalDesktop?.browserSetBounds?.(bounds)
    else if (android) await androidBrowserSetBounds(bounds)
  }, [android, desktop, electron, fullscreen])

  const hostNavigate = useCallback(
    async (url: string) => {
      if (electron) return window.signalDesktop?.browserNavigate?.(url)
      if (android) return androidBrowserNavigate(url)
      return { ok: false, error: 'No in-app browser' }
    },
    [android, electron],
  )

  const hostHide = useCallback(
    async (options?: { blank?: boolean; pause?: boolean }) => {
      if (electron) await window.signalDesktop?.browserHide?.(options)
      else if (android) await androidBrowserHide(options)
    },
    [android, electron],
  )

  const placeWebFullscreen = useCallback(async () => {
    if (android) {
      try {
        const probed = await androidBrowserExecute(GUEST_VIDEO_ASPECT_SCRIPT)
        const raw = String(probed.result ?? '')
        const match = raw.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/)
        if (match) {
          const w = Number(match[1])
          const h = Number(match[2])
          if (w > 8 && h > 8) embedAspectRef.current = w / h
        }
      } catch {
        /* keep the last known aspect */
      }
      await showAt(letterboxedFullscreenBounds(embedAspectRef.current))
      return
    }
    if (modeRef.current === 'pip') {
      await showAt(pipFullscreenBounds())
      return
    }
    await showAt(fullscreenBounds({ fullBleed: true }))
  }, [android, showAt])

  const attachFrame = useCallback(
    (frame: HTMLElement) => {
      // Cancel any pending hide from a Strict Mode / effect cleanup.
      detachGeneration.current += 1
      frameRef.current = frame
      setMode('page')
      modeRef.current = 'page'
      // Remount/Strict Mode must not yank fullscreen mid-watch (pauses embeds).
      frame.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const place = () => {
        if (fullscreenRef.current) {
          if (android) {
            void showAt(letterboxedFullscreenBounds(embedAspectRef.current))
          } else {
            void showAt(
              modeRef.current === 'pip' ? pipFullscreenBounds() : fullscreenBounds({ fullBleed: true }),
            )
          }
          return
        }
        const bounds = boundsFromElement(frame)
        if (bounds.width < 8 || bounds.height < 8) return
        void showAt(bounds)
      }
      place()
      requestAnimationFrame(() => {
        place()
        requestAnimationFrame(place)
      })
      // Expanding from PiP / remount: Gecko often pauses on resize. Soft resume
      // uses video.play() first; only taps if still idle (avoids pause-toggle).
      if (android) {
        window.setTimeout(() => softResumePlayback(), 400)
        window.setTimeout(() => softResumePlayback(), 1400)
      }
    },
    [android, showAt, softResumePlayback],
  )

  const detachFrame = useCallback(() => {
    frameRef.current = null
    if (modeRef.current === 'pip') return
    const token = ++detachGeneration.current
    // Defer hide so Expand / Strict Mode remount / leave→PiP can win first.
    window.setTimeout(() => {
      if (token !== detachGeneration.current) return
      if (modeRef.current === 'pip') return
      if (frameRef.current) return
      // Intentional close (Android Back used to blank then resurrect a black PiP).
      if (suppressLastChancePipRef.current || modeRef.current === 'off') {
        setMode('off')
        modeRef.current = 'off'
        setFullscreen(false)
        void hostHide()
        return
      }
      // Last-chance PiP: /web unmounted before openInPip / NavigationPiPBridge ran.
      const current = navUrlRef.current
      const embed =
        current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
      if (embed && isEmbedPlayerHost(embed) && !isBlankBrowserUrl(embed)) {
        detachGeneration.current += 1
        setFullscreen(false)
        setMode('pip')
        modeRef.current = 'pip'
        void exitOsFullscreen({ force: true })
        void window.signalDesktop?.browserAdDockClose?.()
        if (!current || !isEmbedPlayerHost(current)) {
          void hostNavigate(embed)
        }
        void showAt(pipStageBounds())
        resumePipPlayback()
        return
      }
      setMode('off')
      modeRef.current = 'off'
      setFullscreen(false)
      // Pause + hide only — do not blank (keeps the YouTube session alive).
      void hostHide()
    }, 32)
  }, [hostHide, hostNavigate, resumePipPlayback, showAt])

  const openUrl = useCallback(
    async (raw: string) => {
      const target = toAutoplayUrl(cinetaroPlaybackUrl(raw))
      if (isEmbedPlayerHost(target)) lastEmbedUrlRef.current = target
      if (!desktop) {
        setAddress(target)
        setNav((current) => ({ ...current, url: target, loading: true }))
        setStatus('In-app browser unavailable on this platform')
        return
      }
      // Allow a fresh autoplay cycle when retrying the same embed after PiP/hide.
      lastNudgeUrlRef.current = ''
      lastNudgeAtRef.current = 0
      // Always promote to full page — leftover PiP mode would open sports in the corner.
      setMode('page')
      modeRef.current = 'page'
      setFullscreen(false)
      if (frameRef.current) {
        await showAt(boundsFromElement(frameRef.current))
      }
      const result = await hostNavigate(target)
      if (result && !result.ok) {
        setStatus(result.error || 'Failed to open')
        setNav((current) => ({ ...current, loading: false, title: 'Failed' }))
        return
      }
      // Prefer the live guest URL when main kept a Rive direct-player hop.
      const live = String(result?.url || target)
      setAddress(live)
      setNav((current) => ({
        ...current,
        url: live,
        loading: true,
        external: false,
      }))
      setStatus(null)
      // Embeds: wait for did-stop-loading (onBrowserNav + main-process sports kick).
      // Immediate center-clicks often land before <video> exists, then later clicks pause LIVE.
      if (!isEmbedPlayerHost(live)) {
        nudgePlayback(live)
      }
    },
    [desktop, hostNavigate, nudgePlayback, showAt],
  )

  const openInPip = useCallback(
    (url?: string, title?: string, options?: { navigateTo?: string }) => {
      if (!desktop) return
      suppressLastChancePipRef.current = false
      const current = nav.url || address
      const preferred =
        (url && isEmbedPlayerHost(url) ? url : '') ||
        (current && isEmbedPlayerHost(current) ? current : '') ||
        lastEmbedUrlRef.current ||
        url ||
        current ||
        ''
      const target = toAutoplayUrl(preferred || '')
      // Never PiP a blank/black placeholder — that leaves a black box over Sports/Home.
      if (!target || isBlankBrowserUrl(target) || !isEmbedPlayerHost(target)) {
        void hostHide({ blank: true })
        setMode('off')
        modeRef.current = 'off'
        if (options?.navigateTo) navigate(options.navigateTo)
        return
      }
      if (isEmbedPlayerHost(target)) lastEmbedUrlRef.current = target
      // Cancel any pending detachFrame → browserHide (pause/mute) from /web unmount.
      detachGeneration.current += 1
      setFullscreen(false)
      setMode('pip')
      modeRef.current = 'pip'
      frameRef.current = null
      setAddress(target)
      navUrlRef.current = target
      setNav((currentNav) => ({
        ...currentNav,
        url: target,
        title: title || currentNav.title || 'Now playing',
      }))
      setStatus(null)
      // Exit OS fullscreen before sizing PiP — otherwise PiP inherits full-screen bounds.
      void exitOsFullscreen({ force: true })
      setFullscreen(false)
      // Ad dock is a native view over the HTML PiP bar — close it first.
      void window.signalDesktop?.browserAdDockClose?.()
      const placePip = () => {
        void showAt(pipStageBounds())
      }
      placePip()
      // Beat any competing showAt from a prior fullscreen exit.
      requestAnimationFrame(() => {
        placePip()
        requestAnimationFrame(placePip)
      })
      resumePipPlayback()
      // Same watch URL: only move the view. Re-nudging (center-click / play scripts)
      // pauses sports embeds and often loads a fresh mid-roll ad over the stream.
      if (!current || !sameWatchUrl(current, target) || !isEmbedPlayerHost(current)) {
        void hostNavigate(target)
        if (!isEmbedPlayerHost(target)) nudgePlayback(target)
      }
      navigate(options?.navigateTo || '/')
    },
    [
      address,
      desktop,
      hostHide,
      hostNavigate,
      nav.url,
      navigate,
      nudgePlayback,
      resumePipPlayback,
      showAt,
    ],
  )

  const setPipOnLeave = useCallback((enabled: boolean) => {
    pipOnLeaveRef.current = enabled
  }, [])

  const minimizeActiveEmbedToPip = useCallback(() => {
    if (modeRef.current === 'pip') return true
    if (modeRef.current !== 'page') return false

    if (android) {
      suppressLastChancePipRef.current = false
      detachGeneration.current += 1
      const current = nav.url || address
      const embed =
        current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
      if (embed && isEmbedPlayerHost(embed)) {
        lastEmbedUrlRef.current = embed
        setFullscreen(false)
        setMode('pip')
        modeRef.current = 'pip'
        frameRef.current = null
        setAddress(embed)
        navUrlRef.current = embed
        setNav((currentNav) => ({
          ...currentNav,
          url: embed,
          title: currentNav.title || 'Now playing',
        }))
        setStatus(null)
        // Keep the stream visible in the corner — don't hide/pause (resume needs a double-tap).
        if (!current || !isEmbedPlayerHost(current)) {
          void hostNavigate(embed)
        }
        const placePip = () => {
          void showAt(pipStageBounds())
        }
        placePip()
        requestAnimationFrame(() => {
          placePip()
          requestAnimationFrame(placePip)
        })
        resumePipPlayback()
        return true
      }
      return false
    }

    if (!desktop) return false
    const current = nav.url || address
    const embed =
      current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
    if (!embed || !isEmbedPlayerHost(embed)) return false
    lastEmbedUrlRef.current = embed

    // Cancel pending detachFrame → browserHide from the unmounting /web page.
    detachGeneration.current += 1
    setFullscreen(false)
    setMode('pip')
    modeRef.current = 'pip'
    frameRef.current = null
    setStatus(null)
    void exitOsFullscreen({ force: true })
    void window.signalDesktop?.browserAdDockClose?.()
    // Guest left the player (ad hop). Put the embed back, then size PiP.
    if (!current || !isEmbedPlayerHost(current)) {
      void hostNavigate(embed)
    }
    // Resize only — never click/nudge an already-playing sports embed into PiP.
    const placePip = () => {
      void showAt(pipStageBounds())
    }
    placePip()
    requestAnimationFrame(() => {
      placePip()
      requestAnimationFrame(placePip)
    })
    return true
  }, [address, android, desktop, hostNavigate, nav.url, resumePipPlayback, showAt])

  const expandFromPip = useCallback(() => {
    setFullscreen(false)
    setMode('page')
    modeRef.current = 'page'
    suppressLastChancePipRef.current = false
    const current = (nav.url || address || '').trim()
    const url = (
      (current && isEmbedPlayerHost(current) ? current : '') ||
      lastEmbedUrlRef.current ||
      current
    ).trim()
    if (url && isEmbedPlayerHost(url)) {
      lastEmbedUrlRef.current = url
      void hostNavigate(url)
      navigate(`/web?url=${encodeURIComponent(url)}`, {
        state: {
          playerMode: 'embed',
          pipOnBack: true,
          from: '/section/sports',
        },
      })
      return
    }
    navigate(url ? `/web?url=${encodeURIComponent(url)}` : '/web')
  }, [address, hostNavigate, nav.url, navigate])

  const closeBrowser = useCallback(() => {
    clearAutoplayTimers()
    suppressLastChancePipRef.current = true
    detachGeneration.current += 1
    frameRef.current = null
    setMode('off')
    modeRef.current = 'off'
    setFullscreen(false)
    setStatus(null)
    void hostHide({ blank: true })
    // Drop web Full only — leave a native stream's claim intact.
    if (getFullscreenOwner() === 'web') {
      void exitOsFullscreen({ force: true })
    }
  }, [clearAutoplayTimers, hostHide])

  // WatchPage / new stream: wipe leftover PiP so the next embed opens full-frame.
  useEffect(() => {
    const onClear = () => {
      closeBrowser()
    }
    window.addEventListener('jiyu:clear-web-surfaces', onClear)
    return () => window.removeEventListener('jiyu:clear-web-surfaces', onClear)
  }, [closeBrowser])

  const parkForMultiview = useCallback(() => {
    clearAutoplayTimers()
    detachGeneration.current += 1
    frameRef.current = null
    pipOnLeaveRef.current = false
    setMode('off')
    modeRef.current = 'off'
    setFullscreen(false)
    // Blank + pause kills Gecko media — otherwise the first stream keeps playing under tiles.
    void hostHide({ blank: true, pause: true })
    void exitOsFullscreen({ onlyIfOwner: 'web', force: false })
    void exitOsFullscreen({ onlyIfOwner: 'native', force: false })
  }, [clearAutoplayTimers, hostHide])

  const exitFullscreen = useCallback(() => {
    if (!desktop) return
    setFullscreen(false)
    void exitOsFullscreen({ force: true })
    if (modeRef.current === 'pip') void showAt(pipStageBounds())
    else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
    else if (modeRef.current === 'page') void showAt(fullscreenBounds({ fullBleed: false }))
  }, [desktop, showAt])

  const toggleFullscreen = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    setFullscreen((current) => {
      const next = !current
      if (next) {
        // Request OS fullscreen first; main process keeps it pinned against
        // guest HTML-fullscreen enter/leave fights.
        void enterOsFullscreen('web')
        // Android letterboxes to the picture so Full doesn't crop the frame.
        void placeWebFullscreen()
      } else {
        void exitOsFullscreen({ force: true })
        if (modeRef.current === 'pip') {
          void showAt(pipStageBounds())
        } else if (frameRef.current) {
          void showAt(boundsFromElement(frameRef.current))
        }
      }
      return next
    })
  }, [android, desktop, placeWebFullscreen, showAt])

  const syncBrowserView = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    if (fullscreen) {
      if (android) {
        void showAt(letterboxedFullscreenBounds(embedAspectRef.current))
        return
      }
      if (modeRef.current === 'pip') {
        void showAt(pipFullscreenBounds())
        return
      }
      void showAt(fullscreenBounds({ fullBleed: true }))
      return
    }
    if (modeRef.current === 'pip') {
      void showAt(pipStageBounds())
      return
    }
    if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
  }, [android, desktop, fullscreen, showAt])

  useEffect(() => {
    if (!desktop) return
    if (electron && window.signalDesktop?.onBrowserNav) {
      return window.signalDesktop.onBrowserNav((next) => {
        if (modeRef.current === 'off') return
        setNav(next)
        if (next.url) {
          setAddress(next.url)
          if (isEmbedPlayerHost(next.url)) lastEmbedUrlRef.current = next.url
        }
        if (!next.loading) {
          setStatus(null)
          const playbackUrl = cinetaroPlaybackUrl(next.url || '')
          if (
            playbackUrl &&
            playbackUrl !== next.url &&
            cinetaroRewriteRef.current !== playbackUrl
          ) {
            cinetaroRewriteRef.current = playbackUrl
            void hostNavigate(playbackUrl)
            return
          }
          if (
            isCinetaroCatalogPageUrl(next.url) ||
            isCloudflareChallengeTarget(next.url, next.title)
          ) {
            return
          }
          if (next.url && isEmbedPlayerHost(next.url)) {
            if (modeRef.current === 'page') nudgePlayback(next.url)
            return
          }
          if (modeRef.current === 'pip') nudgePlayback(next.url)
        }
      })
    }
    if (android) {
      return androidBrowserOnNav((next) => {
        if (modeRef.current === 'off') return
        setNav(next)
        if (next.url) {
          setAddress(next.url)
          if (isEmbedPlayerHost(next.url) && !isCloudflareChallengeTarget(next.url, next.title)) {
            lastEmbedUrlRef.current = next.url
          }
        }
        if (!next.loading) {
          setStatus(null)
          const playbackUrl = cinetaroPlaybackUrl(next.url || '')
          if (
            playbackUrl &&
            playbackUrl !== next.url &&
            cinetaroRewriteRef.current !== playbackUrl
          ) {
            cinetaroRewriteRef.current = playbackUrl
            void hostNavigate(playbackUrl)
            return
          }
          if (
            isCinetaroCatalogPageUrl(next.url) ||
            isCloudflareChallengeTarget(next.url, next.title)
          ) {
            return
          }
          if (next.url && isEmbedPlayerHost(next.url)) {
            if (modeRef.current === 'page') nudgePlayback(next.url)
            return
          }
          if (modeRef.current === 'pip') nudgePlayback(next.url)
        }
      })
    }
  }, [android, desktop, electron, hostNavigate, nudgePlayback])

  useEffect(() => {
    if (!desktop || mode !== 'page' || !frameRef.current || fullscreen) return
    const frame = frameRef.current
    const stage = frame.closest('.main-stage') as HTMLElement | null
    const observer = new ResizeObserver(() => {
      void syncPageBounds()
    })
    observer.observe(frame)
    const onLayout = () => {
      void syncPageBounds()
    }
    // Orientation changes often fire before layout settles — resync a few times.
    const onOrient = () => {
      onLayout()
      window.setTimeout(onLayout, 80)
      window.setTimeout(onLayout, 280)
      window.setTimeout(onLayout, 600)
      if (android) {
        window.setTimeout(() => softResumePlayback(), 700)
      }
    }
    stage?.addEventListener('scroll', onLayout, { passive: true })
    window.addEventListener('resize', onLayout)
    window.addEventListener('orientationchange', onOrient)
    window.addEventListener('scroll', onLayout, { passive: true, capture: true })
    window.visualViewport?.addEventListener('resize', onLayout)
    void syncPageBounds()
    return () => {
      observer.disconnect()
      stage?.removeEventListener('scroll', onLayout)
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('orientationchange', onOrient)
      window.removeEventListener('scroll', onLayout, true)
      window.visualViewport?.removeEventListener('resize', onLayout)
    }
  }, [android, desktop, mode, fullscreen, syncPageBounds, softResumePlayback])

  useEffect(() => {
    if (!desktop || mode !== 'pip' || !fullscreen) return
    const place = () => {
      void showAt(
        android ? letterboxedFullscreenBounds(embedAspectRef.current) : pipFullscreenBounds(),
      )
    }
    window.addEventListener('resize', place)
    place()
    return () => window.removeEventListener('resize', place)
  }, [android, desktop, mode, fullscreen, showAt])

  useEffect(() => {
    if (!desktop || mode !== 'pip' || fullscreen) return
    const onWin = () => {
      void showAt(pipStageBounds())
    }
    const onOrient = () => {
      onWin()
      window.setTimeout(onWin, 80)
      window.setTimeout(onWin, 280)
      window.setTimeout(onWin, 600)
    }
    window.addEventListener('resize', onWin)
    window.addEventListener('orientationchange', onOrient)
    void showAt(pipStageBounds())
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('orientationchange', onOrient)
    }
  }, [desktop, mode, fullscreen, showAt])

  useEffect(() => () => clearAutoplayTimers(), [clearAutoplayTimers])

  useEffect(() => {
    if (!desktop || mode === 'off') return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'F11') return
      // Idle web PiP beside a native player must not steal F11 — only when
      // the browser is the active watch surface (page, or PiP that already owns Full).
      if (modeRef.current === 'pip' && getFullscreenOwner() !== 'web' && !fullscreenRef.current) {
        return
      }
      event.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktop, mode, toggleFullscreen])

  useEffect(() => {
    if (!fullscreen) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      exitFullscreen()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fullscreen, exitFullscreen])

  // Escape pressed inside the native WebContentsView never hits window — main forwards it.
  useEffect(() => {
    const stop = window.signalDesktop?.onForceExitFullscreen?.(() => {
      exitFullscreen()
    })
    return () => stop?.()
  }, [exitFullscreen])

  // Keep owner in sync when OS fullscreen changes outside our toggle.
  // Only prefer 'web' while the in-app browser is actually active.
  useEffect(() => {
    const stop = window.signalDesktop?.onFullScreenChange?.((state) => {
      const next = Boolean(state?.fullScreen)
      const prefer =
        modeRef.current !== 'off' && (fullscreenRef.current || getFullscreenOwner() === 'web')
          ? 'web'
          : undefined
      syncFullscreenOwnerFromOs(next, prefer)
      if (!next && fullscreenRef.current) {
        setFullscreen(false)
        if (modeRef.current === 'pip') void showAt(pipStageBounds())
        else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
      }
    })
    return () => stop?.()
  }, [showAt])

  const value = useMemo<WebBrowserContextValue>(
    () => ({
      desktop,
      mode,
      nav,
      address,
      setAddress,
      status,
      setStatus,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      goBack: () => {
        if (electron) void window.signalDesktop?.browserGoBack?.()
        else if (android) void androidBrowserGoBack()
      },
      goForward: () => {
        if (electron) void window.signalDesktop?.browserGoForward?.()
        else if (android) void androidBrowserGoForward()
      },
      reload: () => {
        if (electron) void window.signalDesktop?.browserReload?.()
        else if (android) void androidBrowserReload()
      },
      openInPip,
      setPipOnLeave,
      minimizeActiveEmbedToPip,
      expandFromPip,
      closeBrowser,
      parkForMultiview,
      toggleFullscreen,
      exitFullscreen,
      syncBrowserView,
      unmuteEmbed: nudgePlayback,
    }),
    [
      desktop,
      mode,
      nav,
      address,
      status,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      openInPip,
      setPipOnLeave,
      minimizeActiveEmbedToPip,
      expandFromPip,
      closeBrowser,
      parkForMultiview,
      toggleFullscreen,
      exitFullscreen,
      syncBrowserView,
      nudgePlayback,
    ],
  )

  return <WebBrowserContext.Provider value={value}>{children}</WebBrowserContext.Provider>
}

export function useWebBrowser() {
  const ctx = useContext(WebBrowserContext)
  if (!ctx) throw new Error('useWebBrowser must be used within WebBrowserProvider')
  return ctx
}

export function pipChromeMetrics() {
  if (typeof window === 'undefined') {
    return {
      width: PIP_WIDTH,
      stageHeight: PIP_HEIGHT,
      chromeHeight: PIP_CHROME,
      margin: PIP_MARGIN,
    }
  }
  const layout = getPipLayout()
  return {
    width: layout.width,
    stageHeight: layout.stageHeight,
    chromeHeight: layout.chromeHeight,
    margin: layout.margin,
  }
}
