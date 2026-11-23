import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { CATEGORIES } from '../data/catalog'
import { usePlayback } from '../context/PlaybackContext'
import { getPipLayout, useWebBrowser } from '../context/WebBrowserContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { APP_RELEASES, APP_VERSION_LABEL } from '../lib/appVersion'
import { isChristmasLogoSeason, jiyuBrandLogoSrc } from '../lib/brandLogo'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import {
  isMinimizeToPipEnabled,
  setMinimizeToPipEnabled,
  subscribeMinimizeToPipPref,
} from '../lib/minimizeToPipPref'
import { androidBrowserHide, androidBrowserMultiHideAll } from '../lib/androidBrowser'
import {
  androidCheckForUpdate,
  androidDownloadUpdate,
  androidInstallUpdate,
  onAndroidUpdateProgress,
} from '../lib/androidUpdate'
import { pushOverlayDismiss } from '../lib/overlayDismiss'
import { CatalogSyncBar } from './CatalogSyncBar'
import { openFeatureGuide } from './WelcomeTour'

const isAndroidShell =
  typeof window !== 'undefined' &&
  (() => {
    try {
      return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
    } catch {
      return false
    }
  })()

export function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { mode, minimizeToPip, slots, awaitingAdd } = usePlayback()
  const { mode: webMode, minimizeActiveEmbedToPip, syncBrowserView } = useWebBrowser()
  const pipOpen = mode === 'pip'
  const [brandMenuOpen, setBrandMenuOpen] = useState(false)
  const [sectionsMenuOpen, setSectionsMenuOpen] = useState(false)
  const [androidMenuStyle, setAndroidMenuStyle] = useState<CSSProperties | undefined>()
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const [minimizeToPipPref, setMinimizeToPipPref] = useState(isMinimizeToPipEnabled)
  const [updater, setUpdater] = useState<{
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
    message?: string
  }>({ status: 'idle' })
  const brandRef = useRef<HTMLDivElement>(null)
  const sectionsRef = useRef<HTMLDivElement>(null)
  const androidDownloadLock = useRef(false)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])
  useEffect(
    () => subscribeMinimizeToPipPref(() => setMinimizeToPipPref(isMinimizeToPipEnabled())),
    [],
  )
  useEffect(() => {
    const unsub = window.signalDesktop?.onUpdater?.((state) => {
      setUpdater({
        status: state.status,
        version: state.version,
        percent: state.percent,
        message: state.message,
      })
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (!isAndroidShell) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void checkAndroidForUpdates(false)
    }, 10_000)
    const handle = onAndroidUpdateProgress((event) => {
      if (cancelled || !androidDownloadLock.current) return
      setUpdater((prev) => ({
        ...prev,
        status: 'downloading',
        percent: event.percent,
        version: prev.version,
      }))
    })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      void handle.then((listener) => listener.remove())
    }
    // Startup check only. Manual checks call checkAndroidForUpdates directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const browseCategories = useMemo(
    () => (kidsMode ? CATEGORIES.filter((cat) => cat.id === 'kids') : CATEGORIES),
    [kidsMode],
  )

  function onNavClick() {
    window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))
    void window.signalDesktop?.browserMultiHideAll?.({ blank: true })
    void window.signalDesktop?.browserAdDockClose?.()
    if (isAndroidShell) void androidBrowserMultiHideAll({ blank: true })
    if (mode === 'full' || mode === 'multi') minimizeToPip()
    // Hiding here races the PiP resize and leaves a black corner after the stream pauses.
    if (webMode === 'page') minimizeActiveEmbedToPip()
    setSectionsMenuOpen(false)
    // Sections-menu hide can finish after PiP show and leave Mute/Full/Expand
    // with no Gecko stage — re-place the corner a few times so show wins.
    if (isAndroidShell && (webMode === 'pip' || webMode === 'page')) {
      hiddenForMenuRef.current = false
      window.setTimeout(() => syncBrowserView(), 0)
      window.setTimeout(() => syncBrowserView(), 120)
      window.setTimeout(() => syncBrowserView(), 360)
    }
  }

  function goHome() {
    onNavClick()
    navigate('/')
  }

  // Android: the Gecko view draws above the WebView, so it would cover the Sections sheet.
  // Full page: hide it while the sheet is open. Mini player: the sheet sits above the
  // corner, so keep the stream on screen and playing; only hide it if the sheet really
  // overlaps. Hiding it used to leave the mini player stopped until Expand, because
  // closing the sheet only re-showed the full page. Re-place it in both modes on close.
  const hiddenForMenuRef = useRef(false)
  useEffect(() => {
    if (!isAndroidShell) return
    if (sectionsMenuOpen && webMode !== 'pip') {
      hiddenForMenuRef.current = true
      void androidBrowserHide({ pause: false })
      return
    }
    if (sectionsMenuOpen) {
      let frame = 0
      const check = () => {
        const menu = document.getElementById('sections-menu')?.getBoundingClientRect()
        const { x, stageY, width, stageHeight } = getPipLayout()
        const overlaps =
          !!menu &&
          menu.width > 2 &&
          menu.height > 2 &&
          menu.left < x + width &&
          menu.right > x &&
          menu.top < stageY + stageHeight &&
          menu.bottom > stageY
        if (overlaps && !hiddenForMenuRef.current) {
          hiddenForMenuRef.current = true
          void androidBrowserHide({ pause: false })
        } else if (!overlaps && hiddenForMenuRef.current) {
          hiddenForMenuRef.current = false
          syncBrowserView()
        }
      }
      // Wait for the sheet to be placed (androidMenuStyle) before measuring.
      const schedule = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(check)
        })
      }
      schedule()
      window.addEventListener('resize', schedule)
      return () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('resize', schedule)
      }
    }
    const wasHidden = hiddenForMenuRef.current
    hiddenForMenuRef.current = false
    if (webMode === 'page' || (webMode === 'pip' && wasHidden)) syncBrowserView()
  }, [sectionsMenuOpen, webMode, syncBrowserView, androidMenuStyle])

  useEffect(() => {
    if (!isAndroidShell || !sectionsMenuOpen) {
      setAndroidMenuStyle(undefined)
      return
    }
    function placeMenu() {
      const anchor = sectionsRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const landscape = window.matchMedia('(orientation: landscape)').matches
      const width = Math.min(264, window.innerWidth - 16)
      let left = landscape ? r.right + 8 : r.left
      let top = landscape ? r.top : r.bottom + 6
      if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8)
      }
      if (top + 120 > window.innerHeight) {
        top = Math.max(8, r.top - 8)
      }
      setAndroidMenuStyle({
        ['--android-menu-top' as string]: `${Math.round(top)}px`,
        ['--android-menu-left' as string]: `${Math.round(left)}px`,
        ['--android-menu-width' as string]: `${Math.round(width)}px`,
      })
    }
    placeMenu()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('orientationchange', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('orientationchange', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [sectionsMenuOpen])

  // Orientation flips break the top/rail chrome — close menus and re-sync the embed.
  useEffect(() => {
    if (!isAndroidShell) return
    const onOrient = () => {
      setSectionsMenuOpen(false)
      setBrandMenuOpen(false)
      window.setTimeout(() => {
        if (webMode === 'page') syncBrowserView()
      }, 120)
      window.setTimeout(() => {
        if (webMode === 'page') syncBrowserView()
      }, 450)
    }
    window.addEventListener('orientationchange', onOrient)
    return () => window.removeEventListener('orientationchange', onOrient)
  }, [webMode, syncBrowserView])

  useEffect(() => {
    if (!brandMenuOpen) return
    function onPointerDown(e: PointerEvent) {
      if (!brandRef.current?.contains(e.target as Node)) setBrandMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setBrandMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [brandMenuOpen])

  useEffect(() => {
    if (!sectionsMenuOpen) return
    const pop = pushOverlayDismiss(() => setSectionsMenuOpen(false))
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (sectionsRef.current?.contains(target)) return
      if (document.getElementById('sections-menu')?.contains(target)) return
      if ((target as HTMLElement)?.closest?.('.sections-menu-portal')) return
      setSectionsMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSectionsMenuOpen(false)
    }
    // click (not pointerdown) so NavLink activation isn't cancelled on Android.
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      pop()
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [sectionsMenuOpen])

  useEffect(() => {
    setSectionsMenuOpen(false)
  }, [location.pathname])

  function exitApp() {
    setBrandMenuOpen(false)
    void window.signalDesktop?.quit?.()
  }

  function minimizeToTaskbar() {
    setBrandMenuOpen(false)
    void window.signalDesktop?.minimizeWindow?.()
  }

  function toggleMinimizeToPipPref() {
    const next = !minimizeToPipPref
    setMinimizeToPipEnabled(next)
    setMinimizeToPipPref(next)
  }

  async function checkForUpdates() {
    setUpdater((prev) => ({ ...prev, status: 'checking', message: undefined }))
    const result = await window.signalDesktop?.checkForUpdates?.()
    if (!result) return
    if (result.reason === 'dev') {
      setUpdater({
        status: 'idle',
        message: 'Packaged builds check GitHub Releases automatically.',
      })
      return
    }
    if (!result.ok && result.error) {
      setUpdater({ status: 'error', message: result.error })
    }
  }

  async function checkAndroidForUpdates(manual: boolean) {
    if (androidDownloadLock.current) return
    setUpdater((prev) => ({ ...prev, status: 'checking', message: undefined }))
    try {
      const result = await androidCheckForUpdate()
      if (result.updateAvailable) {
        setUpdater({ status: 'available', version: result.version })
        return
      }
      setUpdater(
        manual
          ? { status: 'not-available', version: result.version, message: "You're up to date" }
          : { status: 'idle' },
      )
    } catch (err) {
      if (!manual) {
        setUpdater({ status: 'idle' })
        return
      }
      setUpdater({
        status: 'error',
        message: err instanceof Error ? err.message : 'Update check failed',
      })
    }
  }

  async function downloadAndroidUpdate() {
    if (androidDownloadLock.current) return
    androidDownloadLock.current = true
    setUpdater((prev) => ({ ...prev, status: 'downloading', percent: 0, message: undefined }))
    try {
      const result = await androidDownloadUpdate()
      androidDownloadLock.current = false
      setUpdater({ status: 'downloaded', version: result.version })
    } catch (err) {
      androidDownloadLock.current = false
      setUpdater({
        status: 'error',
        message: err instanceof Error ? err.message : 'Update download failed',
      })
    }
  }

  async function installAndroidUpdate() {
    try {
      const result = await androidInstallUpdate()
      if (result.reason === 'permission') {
        setUpdater((prev) => ({
          ...prev,
          status: 'downloaded',
          message: 'Allow Jiyu to install unknown apps, then tap Install again.',
        }))
      }
    } catch (err) {
      setUpdater({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not open the installer',
      })
    }
  }

  async function downloadUpdate() {
    setUpdater((prev) => ({ ...prev, status: 'downloading', percent: 0 }))
    const result = await window.signalDesktop?.downloadUpdate?.()
    if (result && !result.ok && result.error) {
      setUpdater({ status: 'error', message: result.error })
    }
  }

  function installUpdate() {
    void window.signalDesktop?.installUpdate?.()
  }

  const updaterLabel = (() => {
    switch (updater.status) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return updater.version ? `Update ${updater.version} available` : 'Update available'
      case 'not-available':
        return "You're up to date"
      case 'downloading':
        return `Downloading… ${Math.round(updater.percent || 0)}%`
      case 'downloaded':
        if (isAndroidShell) {
          if (updater.message) return updater.message
          return updater.version
            ? `Update ${updater.version} ready — tap Install`
            : 'Update ready — tap Install'
        }
        return updater.version
          ? `Update ${updater.version} ready — restart to install`
          : 'Update ready — restart to install'
      case 'error': {
        const raw = updater.message || 'Update check failed'
        if (/ENOENT|update\.yml|portable/i.test(raw)) {
          return 'Auto-update needs the installed app (Setup). Use “Get latest installer” below.'
        }
        return raw
      }
      default:
        return updater.message || null
    }
  })()

  const multiLabel = awaitingAdd
    ? 'Multi-view…'
    : mode === 'multi' && slots.length >= 1
      ? `Multi-view (${slots.length})`
      : slots.length > 1
        ? `Multi-view (${slots.length})`
        : 'Multi-view'

  const sectionsCurrentLabel = useMemo(() => {
    if (location.pathname === '/' || location.pathname === '') return 'Home'
    if (location.pathname.startsWith('/web')) return 'Web'
    if (location.pathname.startsWith('/multiview')) return 'Multi'
    if (location.pathname.startsWith('/library')) return 'Library'
    const sectionMatch = location.pathname.match(/^\/section\/([^/]+)/)
    if (sectionMatch) {
      const cat = CATEGORIES.find((c) => c.id === sectionMatch[1])
      return cat?.label ?? 'Sections'
    }
    return 'Sections'
  }, [location.pathname])

  const sectionsNav = (
    <nav
      id="sections-menu"
      className={`side-nav${isAndroidShell && sectionsMenuOpen ? ' is-android-portal' : ''}`}
      aria-label="Sections"
      hidden={isAndroidShell && !sectionsMenuOpen}
      style={isAndroidShell && sectionsMenuOpen ? androidMenuStyle : undefined}
    >
      <div className="side-nav-group">
        <p className="side-nav-label">Browse</p>
        <NavLink
          to="/"
          end
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          style={{ ['--i' as string]: 0 }}
          onClick={onNavClick}
        >
          Home
        </NavLink>
        {browseCategories.map((cat, index) => (
          <NavLink
            key={cat.id}
            to={`/section/${cat.id}`}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            style={{ ['--accent' as string]: cat.accent, ['--i' as string]: index + 1 }}
            onClick={onNavClick}
          >
            <span className="nav-dot" aria-hidden />
            {cat.label}
          </NavLink>
        ))}
      </div>

      {!kidsMode && (
        <div className="side-nav-group">
          <p className="side-nav-label">Watch</p>
          <NavLink
            to="/web"
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            style={{ ['--i' as string]: 6 }}
            onClick={onNavClick}
          >
            Web browser
          </NavLink>
          <NavLink
            to="/multiview"
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            style={{ ['--i' as string]: 7 }}
            onClick={onNavClick}
          >
            {multiLabel}
          </NavLink>
        </div>
      )}
      {isAndroidShell ? (
        <div className="side-nav-group">
          <p className="side-nav-label">App</p>
          <button
            type="button"
            className="nav-link"
            onClick={() => {
              setSectionsMenuOpen(false)
              openFeatureGuide()
            }}
          >
            How Jiyu works
          </button>
          {updater.status !== 'idle' && updaterLabel ? (
            <p className="android-update-status">{updaterLabel}</p>
          ) : null}
          {updater.status === 'available' ? (
            <button type="button" className="nav-link" onClick={() => void downloadAndroidUpdate()}>
              Download update
            </button>
          ) : null}
          {updater.status === 'downloaded' ? (
            <button type="button" className="nav-link" onClick={() => void installAndroidUpdate()}>
              Install update
            </button>
          ) : null}
          {updater.status !== 'available' &&
          updater.status !== 'downloading' &&
          updater.status !== 'downloaded' ? (
            <button
              type="button"
              className="nav-link"
              onClick={() => void checkAndroidForUpdates(true)}
            >
              Check for updates
            </button>
          ) : null}
        </div>
      ) : null}
    </nav>
  )

  return (
    <aside
      className={`sidebar ${pipOpen ? 'sidebar-pip-open' : ''} ${
        isAndroidShell ? 'sidebar-android' : ''
      } ${sectionsMenuOpen ? 'sections-menu-open' : ''}${
        isChristmasLogoSeason() ? ' is-christmas' : ''
      }`}
    >
      <div className="sidebar-glow" aria-hidden />

      <div className="sidebar-chrome">
        <div className="brand-row">
          <div className="brand-wrap" ref={brandRef}>
          <button
            type="button"
            className={`brand brand-btn${isChristmasLogoSeason() ? ' is-christmas' : ''}`}
            aria-haspopup={isAndroidShell ? undefined : 'menu'}
            aria-expanded={isAndroidShell ? undefined : brandMenuOpen}
            aria-label={isAndroidShell ? 'Home' : 'Jiyu menu'}
            onClick={() => {
              setSectionsMenuOpen(false)
              if (isAndroidShell) {
                goHome()
                return
              }
              setBrandMenuOpen((open) => !open)
            }}
          >
            <span className="brand-logo-wrap">
              <img
                className="brand-logo"
                src={jiyuBrandLogoSrc()}
                alt=""
                width={40}
                height={40}
              />
            </span>
            <div className="brand-copy">
              <p
                className={`brand-name${isChristmasLogoSeason() ? ' is-christmas' : ''}`}
              >
                {isChristmasLogoSeason() ? (
                  <span className="brand-xmas-word">
                    {/* Back loop: string around the word. */}
                    <span className="brand-xmas-lights is-back" aria-hidden>
                      <svg
                        viewBox="0 0 200 72"
                        width="100%"
                        height="100%"
                        preserveAspectRatio="none"
                        focusable="false"
                      >
                        <path
                          d="M16 30 C42 10 70 22 100 12 C132 4 168 14 186 28
                             C196 38 192 50 180 56
                             C148 68 120 52 100 60
                             C72 68 36 62 16 50
                             C6 42 8 34 16 30"
                          fill="none"
                          stroke="#4e342e"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <ellipse cx="28" cy="18" rx="3" ry="3.8" fill="#ff5252"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0s" repeatCount="indefinite"/></ellipse>
                        <circle cx="28" cy="14.4" r="1.1" fill="#ffc107" />
                        <path d="M58 16 C55 20 55 25 58 28 C61 25 61 20 58 16Z" fill="#e53935"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.25s" repeatCount="indefinite"/></path>
                        <ellipse cx="58" cy="16.8" rx="1.4" ry="1" fill="#81c784" />
                        <ellipse cx="90" cy="11" rx="3" ry="3.8" fill="#69f0ae"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.5s" repeatCount="indefinite"/></ellipse>
                        <circle cx="90" cy="7.4" r="1.1" fill="#ffc107" />
                        <ellipse cx="128" cy="10" rx="3" ry="3.8" fill="#ffd54f"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.75s" repeatCount="indefinite"/></ellipse>
                        <circle cx="128" cy="6.4" r="1.1" fill="#ffc107" />
                        <path d="M162 18 C159 22 159 27 162 30 C165 27 165 22 162 18Z" fill="#c62828"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="1s" repeatCount="indefinite"/></path>
                        <ellipse cx="162" cy="18.8" rx="1.4" ry="1" fill="#a5d6a7" />
                        <ellipse cx="188" cy="30" rx="3" ry="3.8" fill="#40c4ff"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.15s" repeatCount="indefinite"/></ellipse>
                        <circle cx="188" cy="26.4" r="1.1" fill="#ffc107" />
                        <ellipse cx="178" cy="56" rx="3" ry="3.8" fill="#ff8a80"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.4s" repeatCount="indefinite"/></ellipse>
                        <circle cx="178" cy="52.4" r="1.1" fill="#ffc107" />
                        <ellipse cx="132" cy="62" rx="3" ry="3.8" fill="#ffd54f"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.65s" repeatCount="indefinite"/></ellipse>
                        <circle cx="132" cy="58.4" r="1.1" fill="#ffc107" />
                        <path d="M96 58 C93 62 93 67 96 70 C99 67 99 62 96 58Z" fill="#e53935"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.9s" repeatCount="indefinite"/></path>
                        <ellipse cx="96" cy="58.8" rx="1.4" ry="1" fill="#81c784" />
                        <ellipse cx="52" cy="62" rx="3" ry="3.8" fill="#69f0ae"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.2s" repeatCount="indefinite"/></ellipse>
                        <circle cx="52" cy="58.4" r="1.1" fill="#ffc107" />
                        <ellipse cx="18" cy="46" rx="3" ry="3.8" fill="#ff5252"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.85s" repeatCount="indefinite"/></ellipse>
                        <circle cx="18" cy="42.4" r="1.1" fill="#ffc107" />
                      </svg>
                    </span>
                    {/* Front strand: drapes across the letters. */}
                    <span className="brand-xmas-lights is-front" aria-hidden>
                      <svg
                        viewBox="0 0 200 40"
                        width="100%"
                        height="100%"
                        preserveAspectRatio="none"
                        focusable="false"
                      >
                        <path
                          d="M4 28 C40 18 72 34 104 24 C136 14 164 32 196 26"
                          fill="none"
                          stroke="#4e342e"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <ellipse cx="36" cy="22" rx="2.6" ry="3.3" fill="#40c4ff"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.1s" repeatCount="indefinite"/></ellipse>
                        <circle cx="36" cy="18.8" r="1" fill="#ffc107" />
                        <ellipse cx="82" cy="28" rx="2.6" ry="3.3" fill="#ff5252"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.45s" repeatCount="indefinite"/></ellipse>
                        <circle cx="82" cy="24.8" r="1" fill="#ffc107" />
                        <path d="M128 20 C125.5 23.5 125.5 27.5 128 30 C130.5 27.5 130.5 23.5 128 20Z" fill="#c62828"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.7s" repeatCount="indefinite"/></path>
                        <ellipse cx="128" cy="20.7" rx="1.2" ry="0.85" fill="#a5d6a7" />
                        <ellipse cx="168" cy="28" rx="2.6" ry="3.3" fill="#ffd54f"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.3s" repeatCount="indefinite"/></ellipse>
                        <circle cx="168" cy="24.8" r="1" fill="#ffc107" />
                        <ellipse cx="192" cy="26" rx="2.6" ry="3.3" fill="#69f0ae"><animate attributeName="opacity" values="1;0.4;1" dur="1.35s" begin="0.95s" repeatCount="indefinite"/></ellipse>
                        <circle cx="192" cy="22.8" r="1" fill="#ffc107" />
                      </svg>
                    </span>
                    <span className="brand-xmas-letters">
                      <span className="brand-name-j">
                        <span className="brand-santa-hat" aria-hidden>
                          <svg viewBox="0 0 28 26" width="100%" height="100%" focusable="false">
                            {/* Narrow brim perched on the J crown — keep the stem readable. */}
                            <ellipse cx="14" cy="21.5" rx="8.2" ry="3.1" fill="#f5f5f5" />
                            <path
                              d="M8.5 20.5 C10 10 14.5 3.2 20 4.5 C21.2 9 18.8 17 17.2 20.5 Z"
                              fill="#c62828"
                            />
                            <path d="M15.5 5 C18 3 22 4.8 22.8 7.2 C19.5 7.2 17.2 9.5 14.8 10 Z" fill="#e53935" />
                            <circle cx="22.6" cy="7.4" r="2.5" fill="#fff" />
                            <ellipse cx="14" cy="21.8" rx="8.2" ry="1.8" fill="#fff" />
                          </svg>
                        </span>
                        <span className="brand-name-letter">J</span>
                      </span>
                      <span className="brand-name-letter">iyu</span>
                    </span>
                  </span>
                ) : (
                  'Jiyu'
                )}
              </p>
              <p className="brand-tag">
                <span className="brand-tag-kanji">自由</span>
                <span className="brand-tag-dot" aria-hidden />
                {APP_VERSION_LABEL}
              </p>
            </div>
          </button>
          {!isAndroidShell &&
          (updater.status === 'available' ||
            updater.status === 'downloaded' ||
            updater.status === 'downloading') ? (
            <button
              type="button"
              className="brand-update-banner"
              onClick={() => {
                if (updater.status === 'available') void downloadUpdate()
                else if (updater.status === 'downloaded') installUpdate()
              }}
            >
              {updater.status === 'available'
                ? `Download ${updater.version || 'update'}`
                : updater.status === 'downloading'
                  ? `Downloading… ${Math.round(updater.percent || 0)}%`
                  : 'Restart to update'}
            </button>
          ) : null}
          {!isAndroidShell && brandMenuOpen && (
            <div className="brand-menu" role="menu">
              <div className="brand-menu-version" role="note">
                <strong>{APP_VERSION_LABEL}</strong>
                {updaterLabel ? <p className="brand-menu-updater">{updaterLabel}</p> : null}
              </div>
              <button
                type="button"
                className="brand-menu-item"
                role="menuitem"
                onClick={() => {
                  setBrandMenuOpen(false)
                  openFeatureGuide()
                }}
              >
                How Jiyu works
              </button>
              {updater.status === 'available' ? (
                <button
                  type="button"
                  className="brand-menu-item"
                  role="menuitem"
                  onClick={() => void downloadUpdate()}
                >
                  Download update
                </button>
              ) : null}
              {updater.status === 'downloaded' ? (
                <button
                  type="button"
                  className="brand-menu-item"
                  role="menuitem"
                  onClick={installUpdate}
                >
                  Restart to update
                </button>
              ) : null}
              {updater.status !== 'available' &&
              updater.status !== 'downloaded' &&
              updater.status !== 'downloading' ? (
                <button
                  type="button"
                  className="brand-menu-item brand-menu-item-primary"
                  role="menuitem"
                  onClick={() => void checkForUpdates()}
                >
                  Check for updates
                </button>
              ) : null}
              {updater.status === 'error' || updater.status === 'idle' ? (
                <button
                  type="button"
                  className="brand-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void window.signalDesktop?.openExternal?.(
                      'https://github.com/rcrdhs/jiyu-media-center/releases/latest',
                    )
                  }}
                >
                  Get latest installer
                </button>
              ) : null}
              <button
                type="button"
                className="brand-menu-item"
                role="menuitemcheckbox"
                aria-checked={minimizeToPipPref}
                onClick={toggleMinimizeToPipPref}
              >
                {minimizeToPipPref ? '✓ Minimize to PiP' : 'Minimize to PiP'}
              </button>
              <button type="button" className="brand-menu-item" role="menuitem" onClick={minimizeToTaskbar}>
                Minimize to taskbar
              </button>
              <button type="button" className="brand-menu-item" role="menuitem" onClick={exitApp}>
                Exit
              </button>
              <div className="brand-menu-changelog" role="note">
                <ul>
                  {APP_RELEASES.map((release) => (
                    <li key={release.version}>
                      <span>v{release.version}</span>
                      <span>{release.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          </div>
          <button
            type="button"
            className="feature-guide-btn brand-help-btn"
            title="How Jiyu works"
            aria-label="How Jiyu works"
            onClick={() => {
              setSectionsMenuOpen(false)
              setBrandMenuOpen(false)
              openFeatureGuide()
            }}
          >
            ?
          </button>
        </div>

        {isAndroidShell ? (
          <div className="sections-menu-wrap" ref={sectionsRef}>
            <button
              type="button"
              className="sections-menu-btn"
              aria-haspopup="true"
              aria-expanded={sectionsMenuOpen}
              aria-controls="sections-menu"
              onClick={() => {
                setBrandMenuOpen(false)
                setSectionsMenuOpen((open) => !open)
              }}
            >
              <span className="sections-menu-icon" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="sections-menu-label">{sectionsCurrentLabel}</span>
              {updater.status === 'available' ||
              updater.status === 'downloading' ||
              updater.status === 'downloaded' ? (
                <span className="sections-menu-update-dot" aria-hidden />
              ) : null}
            </button>
          </div>
        ) : null}
      </div>

      {/* Desktop: nav stays in the sidebar column. Android: portal to body so Library
          and other pages never clip or cover the sections sheet. */}
      {isAndroidShell && sectionsMenuOpen && typeof document !== 'undefined'
        ? createPortal(
            <div className="sections-menu-portal" role="presentation">
              <button
                type="button"
                className="sections-menu-backdrop"
                aria-label="Close sections menu"
                onClick={() => setSectionsMenuOpen(false)}
              />
              {sectionsNav}
            </div>,
            document.body,
          )
        : sectionsNav}

      <div className="side-footer">
        <CatalogSyncBar />
        <NavLink
          to="/library"
          className={({ isActive }) =>
            isActive ? 'nav-link side-library active' : 'nav-link side-library'
          }
          onClick={onNavClick}
        >
          <span className="side-library-label">Library</span>
          <span className="side-library-hint">Import · sources · prefs</span>
        </NavLink>
      </div>
    </aside>
  )
}
