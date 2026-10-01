import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { usePlayback } from '../context/PlaybackContext'
import { useWebBrowser } from '../context/WebBrowserContext'
import {
  getTorrentSyncControlState,
  subscribeTorrentSyncControl,
} from '../lib/torrentSyncControl'
import {
  clearTorrentSyncStatus,
  getTorrentSyncStatus,
  subscribeTorrentSyncMessage,
} from '../lib/torrentSyncStatus'

const isAndroidShell =
  typeof window !== 'undefined' &&
  (() => {
    try {
      return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
    } catch {
      return false
    }
  })()

/** Shelf name only — drop page counts, title totals, and the percent suffix. */
function syncSectionLabel(message: string): string {
  let text = message.replace(/^Paused\s*·\s*/i, '').trim()
  const updating = text.match(/Updating catalog\s*·\s*([^·]+)/i)
  if (updating?.[1]) {
    text = updating[1]
  } else {
    text = text.split('·')[0] || text
  }
  text = text
    .replace(/\d{1,3}%/g, '')
    .replace(/…+|\.{3}/g, '')
    .replace(/:\s*loading.*$/i, '')
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text || 'Catalog'
}

function isCompletionMessage(message: string): boolean {
  const m = message.trim()
  return /^(synced|added)\b/i.test(m) || /\b(synced|added)\s+\d/i.test(m)
}

/** Catalog sync progress — shown above the sidebar Library tile. */
export function CatalogSyncBar() {
  const { mode: webMode } = useWebBrowser()
  const { mode: playbackMode, slots } = usePlayback()
  const { pathname } = useLocation()
  const [scrolling, setScrolling] = useState(false)
  const scrollingRef = useRef(false)

  useEffect(() => {
    if (!isAndroidShell) return
    let timer = 0
    const onScroll = () => {
      if (!scrollingRef.current) {
        scrollingRef.current = true
        setScrolling(true)
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        scrollingRef.current = false
        setScrolling(false)
      }, 220)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.clearTimeout(timer)
    }
  }, [])
  const status = useSyncExternalStore(
    subscribeTorrentSyncMessage,
    getTorrentSyncStatus,
    getTorrentSyncStatus,
  )
  const control = useSyncExternalStore(
    subscribeTorrentSyncControl,
    getTorrentSyncControlState,
    getTorrentSyncControlState,
  )

  const done = Boolean(status.message) && isCompletionMessage(status.message!)
  const cancelled =
    Boolean(status.message) && /^catalog sync cancelled\b/i.test(status.message!.trim())
  const finished =
    done || cancelled || (Boolean(status.message) && status.percent === 100 && !control.active)
  const busy = Boolean(status.message) && !finished && control.active

  // Dismiss when sync finishes — and clear any stuck idle message (e.g. CF Verify text).
  useEffect(() => {
    if (!status.message) return
    if (busy) return
    const delay = finished ? 900 : 2800
    const timer = window.setTimeout(() => {
      clearTorrentSyncStatus()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [busy, finished, status.message, status.percent])

  // A started title, embed, or multi-view owns the screen — the bar covers the stream.
  // /watch is the "getting ready" screen before playback mode flips on.
  if (pathname.startsWith('/watch')) return null
  if (playbackMode !== 'off' || slots.length > 0) return null
  if (webMode === 'page' || webMode === 'pip') return null
  if (!status.message) return null

  const pct = finished && !cancelled ? 100 : status.percent
  const determinate = pct != null && pct >= 0
  const section = syncSectionLabel(status.message)

  const bar = (
    <div
      className={`catalog-sync-bar${control.paused ? ' is-paused' : ''}${
        isAndroidShell ? ' is-android-float' : ''
      }${isAndroidShell && scrolling ? ' is-transparent' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={busy && !control.paused}
      aria-label={determinate ? `${section} ${pct}%` : section}
    >
      <span className="catalog-sync-bar-message">{section}</span>
      {determinate ? <span className="catalog-sync-bar-percent">{pct}%</span> : null}
    </div>
  )

  if (isAndroidShell && typeof document !== 'undefined') {
    return createPortal(bar, document.body)
  }
  return bar
}
