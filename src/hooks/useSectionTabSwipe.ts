/**
 * Android phone: swipe left/right on a section page to change shelf tabs
 * (Popular ↔ New, Live ↔ Upcoming ↔ Replay, …) without scrolling up to the chips.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { isAndroidShell } from '../lib/androidFullscreen'
import { isTvMode } from '../lib/tvMode'

const MIN_DX = 64
const LOCK_SLOP = 12
/** Ignore system-back edge swipes. */
const EDGE_GUARD_PX = 28

function isInsideHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== document.body) {
    if (el instanceof HTMLElement) {
      if (
        el.classList.contains('anime-shelf-tabs') ||
        el.classList.contains('sports-sport-filters') ||
        el.classList.contains('rail') ||
        el.classList.contains('continue-row') ||
        el.classList.contains('continue-rail')
      ) {
        return true
      }
      const { overflowX } = window.getComputedStyle(el)
      if (
        (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
        el.scrollWidth > el.clientWidth + 4
      ) {
        return true
      }
    }
    el = el.parentElement
  }
  return false
}

function scrollActiveTabIntoView(root: HTMLElement | null) {
  const tab =
    root?.querySelector<HTMLElement>('.anime-shelf-tab.is-active') ||
    document.querySelector<HTMLElement>('.anime-shelf-tab.is-active')
  tab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
}

export function useSectionTabSwipe<T extends string>(options: {
  enabled: boolean
  tabs: readonly T[]
  activeTab: T
  onSelect: (tab: T) => void
  targetRef: RefObject<HTMLElement | null>
}): void {
  const { enabled, tabs, activeTab, onSelect, targetRef } = options
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeTab)
  const onSelectRef = useRef(onSelect)
  tabsRef.current = tabs
  activeRef.current = activeTab
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!enabled) return
    if (!isAndroidShell() || isTvMode()) return

    const root = targetRef.current
    if (!root) return

    let startX = 0
    let startY = 0
    let tracking = false
    let axis: 'h' | 'v' | null = null
    let moved = false

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      if (tabsRef.current.length < 2) return
      const t = e.touches[0]
      if (!t) return
      if (t.clientX < EDGE_GUARD_PX || t.clientX > window.innerWidth - EDGE_GUARD_PX) {
        return
      }
      if (isInsideHorizontalScroller(e.target)) return
      startX = t.clientX
      startY = t.clientY
      tracking = true
      axis = null
      moved = false
    }

    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return
      const t = e.touches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      if (!axis) {
        if (Math.abs(dx) < LOCK_SLOP && Math.abs(dy) < LOCK_SLOP) return
        axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'h' : 'v'
      }
      if (axis === 'h') {
        moved = true
        if (e.cancelable) e.preventDefault()
      } else {
        tracking = false
      }
    }

    const finish = (clientX: number) => {
      if (!tracking) return
      tracking = false
      if (axis !== 'h' || !moved) return
      const list = tabsRef.current
      if (list.length < 2) return
      const dx = clientX - startX
      if (Math.abs(dx) < MIN_DX) return
      const idx = list.indexOf(activeRef.current)
      if (idx < 0) return
      // Swipe left → next tab; swipe right → previous.
      const nextIdx = dx < 0 ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= list.length) return
      const next = list[nextIdx]
      if (!next || next === activeRef.current) return
      onSelectRef.current(next)
      window.requestAnimationFrame(() => scrollActiveTabIntoView(root))
    }

    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      finish(t?.clientX ?? startX)
    }

    const onCancel = () => {
      tracking = false
      axis = null
      moved = false
    }

    root.addEventListener('touchstart', onStart, { passive: true })
    root.addEventListener('touchmove', onMove, { passive: false })
    root.addEventListener('touchend', onEnd, { passive: true })
    root.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      root.removeEventListener('touchstart', onStart)
      root.removeEventListener('touchmove', onMove)
      root.removeEventListener('touchend', onEnd)
      root.removeEventListener('touchcancel', onCancel)
    }
  }, [enabled, targetRef])
}
