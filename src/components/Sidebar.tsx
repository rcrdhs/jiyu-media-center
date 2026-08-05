import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { usePlayback } from '../context/PlaybackContext'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'
import { APP_RELEASES, APP_VERSION_LABEL } from '../lib/appVersion'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'
import { CatalogSyncBar } from './CatalogSyncBar'

export function Sidebar() {
  const { mode, minimizeToPip, slots, awaitingAdd } = usePlayback()
  const pipOpen = mode === 'pip'
  const [brandMenuOpen, setBrandMenuOpen] = useState(false)
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)
  const brandRef = useRef<HTMLDivElement>(null)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  const browseCategories = useMemo(
    () => (kidsMode ? CATEGORIES.filter((cat) => cat.id === 'kids') : CATEGORIES),
    [kidsMode],
  )

  function onNavClick() {
    window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))
    if (mode === 'full' || mode === 'multi') minimizeToPip()
  }

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

  function exitApp() {
    setBrandMenuOpen(false)
    void window.signalDesktop?.quit?.()
  }

  const multiLabel = awaitingAdd
    ? 'Multi-view…'
    : slots.length > 1
      ? `Multi-view (${slots.length})`
      : 'Multi-view'

  return (
    <aside className={`sidebar ${pipOpen ? 'sidebar-pip-open' : ''}`}>
      <div className="sidebar-glow" aria-hidden />

      <div className="brand-wrap" ref={brandRef}>
        <button
          type="button"
          className="brand brand-btn"
          aria-haspopup="menu"
          aria-expanded={brandMenuOpen}
          aria-label="Jiyu menu"
          onClick={() => setBrandMenuOpen((open) => !open)}
        >
          <span className="brand-logo-wrap">
            <img className="brand-logo" src="./jiyu-logo.png" alt="" width={40} height={40} />
          </span>
          <div className="brand-copy">
            <p className="brand-name">Jiyu</p>
            <p className="brand-tag">
              <span className="brand-tag-kanji">自由</span>
              <span className="brand-tag-dot" aria-hidden />
              media
              <span className="brand-tag-dot" aria-hidden />
              {APP_VERSION_LABEL}
            </p>
          </div>
        </button>
        {brandMenuOpen && (
          <div className="brand-menu" role="menu">
            <div className="brand-menu-version" role="note">
              <strong>{APP_VERSION_LABEL}</strong>
              <ul>
                {APP_RELEASES.map((release) => (
                  <li key={release.version}>
                    <span>v{release.version}</span>
                    <span>{release.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
            <button type="button" className="brand-menu-item" role="menuitem" onClick={exitApp}>
              Exit
            </button>
          </div>
        )}
      </div>

      <nav className="side-nav" aria-label="Sections">
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
      </nav>

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
