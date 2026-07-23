import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { CATEGORIES } from '../data/catalog'
import { useCatalog } from '../context/CatalogContext'
import { usePlayback } from '../context/PlaybackContext'
import {
  getViewingQuality,
  setViewingQuality,
  type ViewingQuality,
} from '../lib/viewingQuality'
import { FORCE_SAVE_CONTINUE_EVENT } from '../lib/continueWatching'

export function Sidebar() {
  const { importedCount, clearImported, englishOnly, setEnglishOnly, hideDuplicates, setHideDuplicates } =
    useCatalog()
  const { mode, minimizeToPip, slots, awaitingAdd } = usePlayback()
  const pipOpen = mode === 'pip'
  const [brandMenuOpen, setBrandMenuOpen] = useState(false)
  const [quality, setQuality] = useState<ViewingQuality>(getViewingQuality)
  const brandRef = useRef<HTMLDivElement>(null)

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

  return (
    <aside className={`sidebar ${pipOpen ? 'sidebar-pip-open' : ''}`}>
      <div className="brand-wrap" ref={brandRef}>
        <button
          type="button"
          className="brand brand-btn"
          aria-haspopup="menu"
          aria-expanded={brandMenuOpen}
          aria-label="Jiyu menu"
          onClick={() => setBrandMenuOpen((open) => !open)}
        >
          <img className="brand-logo" src="./jiyu-logo.png" alt="" width={36} height={36} />
          <div>
            <p className="brand-name">Jiyu</p>
            <p className="brand-tag">自由 · media</p>
          </div>
        </button>
        {brandMenuOpen && (
          <div className="brand-menu" role="menu">
            <button type="button" className="brand-menu-item" role="menuitem" onClick={exitApp}>
              Exit
            </button>
          </div>
        )}
      </div>

      <nav className="side-nav" aria-label="Sections">
        <NavLink
          to="/"
          end
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Home
        </NavLink>
        {CATEGORIES.map((cat) => (
          <NavLink
            key={cat.id}
            to={`/section/${cat.id}`}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            style={{ ['--accent' as string]: cat.accent }}
            onClick={onNavClick}
          >
            {cat.label}
          </NavLink>
        ))}
        <NavLink
          to="/web"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Web browser
        </NavLink>
        <NavLink
          to="/guide"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Guide
        </NavLink>
        <NavLink
          to="/torrents"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Websites
        </NavLink>
        <NavLink
          to="/multiview"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Multi-view{awaitingAdd ? '…' : slots.length > 1 ? ` (${slots.length})` : ''}
        </NavLink>
      </nav>

      <div className="side-footer">
        <label className="side-quality">
          <span>Viewing quality</span>
          <select
            value={quality}
            onChange={(event) => {
              const raw = event.target.value
              const next: ViewingQuality =
                raw === '720' ? 720 : raw === '1080' ? 1080 : raw === '2160' ? 2160 : 'auto'
              setQuality(next)
              setViewingQuality(next)
            }}
            aria-label="Preferred viewing quality"
          >
            <option value="auto">Auto (internet speed)</option>
            <option value="720">720p</option>
            <option value="1080">1080p</option>
            <option value="2160">4K</option>
          </select>
        </label>
        <label className="check-toggle side-pref">
          <input
            type="checkbox"
            checked={englishOnly}
            onChange={(e) => setEnglishOnly(e.target.checked)}
          />
          English only
          <span className="side-pref-hint">except Anime</span>
        </label>
        <label className="check-toggle side-pref">
          <input
            type="checkbox"
            checked={hideDuplicates}
            onChange={(e) => setHideDuplicates(e.target.checked)}
          />
          Hide duplicates
        </label>
        <NavLink
          to="/library"
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          onClick={onNavClick}
        >
          Library & import
        </NavLink>
        {importedCount > 0 && (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              void clearImported()
            }}
          >
            Clear {importedCount.toLocaleString()} imported
          </button>
        )}
      </div>
    </aside>
  )
}
