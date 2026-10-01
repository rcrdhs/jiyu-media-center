import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { CATEGORIES } from '../data/catalog'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { APP_RELEASES, APP_VERSION_LABEL } from '../lib/appVersion'
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
  }

  function goHome() {
    onNavClick()
    navigate('/')
  }

  useEffect(() => {
    if (!isAndroidShell) return
    if (sectionsMenuOpen) {
      void androidBrowserHide({ pause: false })
      return
    }
    if (webMode === 'page') syncBrowserView()
  }, [sectionsMenuOpen, webMode, syncBrowserView])

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
      } ${sectionsMenuOpen ? 'sections-menu-open' : ''}`}
    >
      <div className="sidebar-glow" aria-hidden />

      <div className="sidebar-chrome">
        <div className="brand-wrap" ref={brandRef}>
          <button
            type="button"
            className="brand brand-btn"
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
              <img className="brand-logo" src="./jiyu-logo.png" alt="" width={40} height={40} />
            </span>
            <div className="brand-copy">
              <p className="brand-name">Jiyu</p>
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
