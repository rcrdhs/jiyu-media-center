/**
 * TV remote (D-pad) navigation. Only installed while <html> has `tv-mode`
 * (see tvMode.ts) — phones and desktop never run any of this.
 *
 * - Arrow keys: spatial focus across nav, shelves, pages, dialogs.
 * - OK/Enter: native activation of the focused control.
 * - Full player: with no control focused, Left/Right seek and Up/Down/OK
 *   reveal the controls; inside the controls arrows move between buttons.
 * - Media keys (from MainActivity): play/pause, seek on the active player or
 *   the in-app browser video.
 * - Gecko surfaces (/web embed, web multiview tiles): focus shows a native
 *   ring; OK switches to a D-pad cursor (native), Back returns to focus.
 */

import {
  androidBrowserExecute,
  androidBrowserOnTvPointer,
  androidBrowserTvPointer,
  type TvPointerMode,
} from './androidBrowser'
import { onTvMediaKey } from './tvMode'

type Dir = 'up' | 'down' | 'left' | 'right'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="switch"]',
  '[contenteditable="true"]',
].join(',')

/** DOM placeholders that a native GeckoView covers. */
export const TV_SURFACE_SELECTOR = '.web-frame-embed-active, .web-embed-tile-stage'
const FULL_PLAYER_SELECTOR = '.player-shell:not(.player-shell-pip):not(.player-shell-tile)'
const PLAYER_CHROME_SELECTOR = '.player-bottom-bar, .player-bar, .player-chrome, .player-controls'
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
}

const DOM_MEDIA_KEYS: Record<string, string> = {
  MediaPlayPause: 'playpause',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  MediaFastForward: 'forward',
  MediaRewind: 'rewind',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'previous',
}

// ---------------------------------------------------------------- helpers

function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const anyEl = el as HTMLElement & {
    checkVisibility?: (opts?: Record<string, boolean>) => boolean
  }
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) {
      return false
    }
  } else {
    const style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
  }
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  // Hidden player chrome is faded, not removed — treat it as unreachable.
  const chrome = el.closest(PLAYER_CHROME_SELECTOR)
  if (chrome) {
    const shell = chrome.closest('.player-shell')
    if (shell?.classList.contains('chrome-hidden') && !shell.classList.contains('player-shell-tile')) return false
  }
  return true
}

/** Can a scroll container bring this rect into view on the given axis? */
function inScrollableAncestor(el: HTMLElement, axis: 'x' | 'y'): boolean {
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    const overflow = axis === 'x' ? style.overflowX : style.overflowY
    if (overflow === 'auto' || overflow === 'scroll') {
      const scrollable =
        axis === 'x' ? node.scrollWidth > node.clientWidth + 1 : node.scrollHeight > node.clientHeight + 1
      if (scrollable) return true
    }
    node = node.parentElement
  }
  if (axis === 'y') {
    const doc = document.scrollingElement || document.documentElement
    return doc.scrollHeight > window.innerHeight + 1
  }
  return false
}

function isReachable(el: HTMLElement, rect: DOMRect): boolean {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const offX = rect.right <= 0 || rect.left >= vw
  const offY = rect.bottom <= 0 || rect.top >= vh
  if (offX && !inScrollableAncestor(el, 'x')) return false
  if (offY && !inScrollableAncestor(el, 'y')) return false
  if (!offX && !offY && !el.matches(TV_SURFACE_SELECTOR)) {
    // Occlusion: something unrelated (a modal, a fixed bar) is on top.
    const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2))
    const hit = document.elementFromPoint(cx, cy)
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      // Allow labels / wrappers that forward to this control.
      const label = hit.closest('label')
      if (!label || !label.contains(el)) return false
    }
  }
  return true
}

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase())
  return (el as HTMLElement).isContentEditable === true
}

function isRange(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'range'
}

function fullPlayer(): HTMLElement | null {
  const shells = document.querySelectorAll<HTMLElement>(FULL_PLAYER_SELECTOR)
  for (const shell of shells) {
    const rect = shell.getBoundingClientRect()
    if (rect.width > 40 && rect.height > 40) return shell
  }
  return null
}

/** Topmost modal layer that should trap focus (dialogs, open popup menus). */
function modalScope(): HTMLElement | null {
  const player = fullPlayer()
  if (player) return player
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], .welcome-tour, .new-titles-dialog'),
  ).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  })
  return dialogs.length ? dialogs[dialogs.length - 1] : null
}

function openMenu(): HTMLElement | null {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  })
  return menus.length ? menus[menus.length - 1] : null
}

function candidates(scope: ParentNode): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  const push = (el: HTMLElement) => {
    if (seen.has(el)) return
    seen.add(el)
    out.push(el)
  }
  scope.querySelectorAll<HTMLElement>(FOCUSABLE).forEach(push)
  scope.querySelectorAll<HTMLElement>(TV_SURFACE_SELECTOR).forEach(push)
  return out.filter((el) => {
    // Skip a control nested inside another candidate (e.g. a button in a role=button card)?
    // No — inner buttons are separate targets; keep both.
    if (!isElementVisible(el)) return false
    return isReachable(el, el.getBoundingClientRect())
  })
}

function score(dir: Dir, from: DOMRect, to: DOMRect): number | null {
  const fcx = from.left + from.width / 2
  const fcy = from.top + from.height / 2
  const tcx = to.left + to.width / 2
  const tcy = to.top + to.height / 2
  const slack = 2
  let major: number
  let overlap: number
  let minor: number
  if (dir === 'left' || dir === 'right') {
    if (dir === 'right' && !(tcx > fcx + slack && to.right > from.right - slack)) return null
    if (dir === 'left' && !(tcx < fcx - slack && to.left < from.left + slack)) return null
    major = dir === 'right' ? to.left - from.right : from.left - to.right
    overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
    minor = Math.abs(tcy - fcy)
  } else {
    if (dir === 'down' && !(tcy > fcy + slack && to.bottom > from.bottom - slack)) return null
    if (dir === 'up' && !(tcy < fcy - slack && to.top < from.top + slack)) return null
    major = dir === 'down' ? to.top - from.bottom : from.top - to.bottom
    overlap = Math.min(from.right, to.right) - Math.max(from.left, to.left)
    minor = Math.abs(tcx - fcx)
  }
  major = Math.max(0, major)
  // Same row / column wins; otherwise weight the sideways drift heavily.
  const aligned = overlap > 0
  return major + (aligned ? minor * 0.3 : minor * 2 + 400)
}

function findNext(dir: Dir, from: HTMLElement | null, scope: ParentNode): HTMLElement | null {
  const list = candidates(scope)
  if (!list.length) return null
  if (!from) return initialTarget(list)
  const fromRect = from.getBoundingClientRect()
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === from || el.contains(from)) continue
    const s = score(dir, fromRect, el.getBoundingClientRect())
    if (s == null) continue
    if (s < bestScore) {
      bestScore = s
      best = el
    }
  }
  return best
}

function initialTarget(list: HTMLElement[]): HTMLElement | null {
  const main = document.querySelector('.main-stage')
  const vh = window.innerHeight
  const visible = list.filter((el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < window.innerWidth
  })
  const pool = visible.length ? visible : list
  // Prefer a Gecko surface or the main content over the nav bar.
  const surface = pool.find((el) => el.matches(TV_SURFACE_SELECTOR))
  if (surface) return surface
  const inMain = main ? pool.filter((el) => main.contains(el)) : []
  const ordered = (inMain.length ? inMain : pool).slice().sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return ra.top - rb.top || ra.left - rb.left
  })
  return ordered[0] || null
}

function focusEl(el: HTMLElement, opts?: { smooth?: boolean; dir?: Dir }) {
  if (el.matches(TV_SURFACE_SELECTOR) && !el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
  }
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  try {
    el.focus({ preventScroll: true })
  } catch {
    el.focus()
  }
  try {
    const vertical = opts?.dir === 'up' || opts?.dir === 'down'
    el.scrollIntoView({
      block: vertical ? 'center' : 'nearest',
      inline: 'nearest',
      behavior: opts?.smooth ? 'smooth' : 'auto',
    })
  } catch {
    /* ignore */
  }
}

/** Synthetic key for the Player's own window listener (it ignores no-trust). */
function sendPlayerKey(key: string) {
  const code =
    key === ' ' ? 'Space' : key.startsWith('Arrow') ? key : key.length === 1 ? `Key${key.toUpperCase()}` : key
  window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
}

/** Keep the player chrome awake (Player.onKey bumps on any key). */
function bumpPlayerChrome() {
  sendPlayerKey('Unidentified')
}

function primaryPlayerButton(shell: HTMLElement): HTMLElement | null {
  const bottom = shell.querySelector<HTMLElement>('.player-bottom-bar .control-btn')
  if (bottom) return bottom
  return shell.querySelector<HTMLElement>('.player-back-btn')
}

// ---------------------------------------------------------------- web surface pointer

let pointerMode: TvPointerMode = 'off'
let pointerEl: HTMLElement | null = null
let pointerTimer: number | null = null
let lastRectKey = ''

function surfaceRect(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function setPointer(mode: TvPointerMode, el: HTMLElement | null) {
  pointerMode = mode
  pointerEl = mode === 'off' ? null : el
  if (mode === 'off' || !el) {
    lastRectKey = ''
    if (pointerTimer != null) {
      window.clearInterval(pointerTimer)
      pointerTimer = null
    }
    void androidBrowserTvPointer('off')
    return
  }
  const rect = surfaceRect(el)
  lastRectKey = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`
  void androidBrowserTvPointer(mode, rect)
  if (pointerTimer == null) {
    // Follow layout changes (chrome hiding, fullscreen) while a ring is shown.
    pointerTimer = window.setInterval(syncPointerRect, 500)
  }
}

function syncPointerRect() {
  const el = pointerEl
  if (!el || pointerMode === 'off') return
  if (!el.isConnected || document.activeElement !== el) {
    setPointer('off', null)
    return
  }
  const rect = surfaceRect(el)
  const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`
  if (key === lastRectKey) return
  lastRectKey = key
  void androidBrowserTvPointer(pointerMode, rect)
}

function onFocusIn(e: FocusEvent) {
  const el = e.target instanceof HTMLElement ? e.target : null
  if (el && el.matches(TV_SURFACE_SELECTOR)) {
    if (pointerEl !== el || pointerMode === 'off') setPointer('focus', el)
    return
  }
  if (pointerMode !== 'off') setPointer('off', null)
}

/** Toggle / seek the video inside the in-app browser (top document + same-origin frames). */
function webMediaScript(action: string): string {
  return `(() => {
    const act = ${JSON.stringify(action)};
    const vids = [];
    const collect = (doc) => {
      try {
        doc.querySelectorAll('video').forEach((v) => vids.push(v));
        doc.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) collect(f.contentDocument); } catch (e) {} });
      } catch (e) {}
    };
    collect(document);
    const v = vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (!v) return 'none';
    if (act === 'playpause') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (act === 'play') v.play().catch(() => {});
    else if (act === 'pause' || act === 'stop') v.pause();
    else if (act === 'forward') v.currentTime = Math.min((v.duration || 1e9), v.currentTime + 10);
    else if (act === 'rewind') v.currentTime = Math.max(0, v.currentTime - 10);
    return 'ok';
  })()`
}

// ---------------------------------------------------------------- media keys

function handleMediaKey(key: string) {
  const player = fullPlayer() || document.querySelector<HTMLElement>('.player-shell-pip')
  if (player) {
    if (key === 'playpause' || key === 'play' || key === 'pause' || key === 'stop') {
      // Player has no separate play/pause keys — Space toggles.
      const paused = /^(Play|Resume)$/i.test(primaryPlayerButton(player)?.textContent?.trim() || '')
      if (key === 'play' && !paused) return
      if ((key === 'pause' || key === 'stop') && paused) return
      sendPlayerKey(' ')
      return
    }
    if (key === 'forward' || key === 'next') {
      sendPlayerKey('ArrowRight')
      return
    }
    if (key === 'rewind' || key === 'previous') {
      sendPlayerKey('ArrowLeft')
      return
    }
    return
  }
  if (document.querySelector('.web-frame-embed-active, .web-embed-tile-stage')) {
    const action = key === 'next' ? 'forward' : key === 'previous' ? 'rewind' : key
    void androidBrowserExecute(webMediaScript(action))
  }
}

// ---------------------------------------------------------------- key handler

function stop(e: KeyboardEvent) {
  e.preventDefault()
  e.stopPropagation()
}

function onKeyDown(e: KeyboardEvent) {
  if (!e.isTrusted) return
  if (e.altKey || e.ctrlKey || e.metaKey) return

  const media = DOM_MEDIA_KEYS[e.key]
  if (media) {
    stop(e)
    if (!e.repeat) handleMediaKey(media)
    return
  }

  const dir = KEY_DIR[e.key]
  const isEnter = e.key === 'Enter' || e.key === 'Select' || e.key === 'Accept'
  if (!dir && !isEnter) return

  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null

  // ---- Gecko surface focused: OK enters the native D-pad cursor.
  if (active && active.matches(TV_SURFACE_SELECTOR)) {
    if (isEnter) {
      stop(e)
      if (!e.repeat) setPointer('cursor', active)
      return
    }
  }

  // ---- Full player.
  const player = fullPlayer()
  if (player) {
    const hidden = player.classList.contains('chrome-hidden')
    const inChrome = Boolean(active && player.contains(active) && !hidden && isElementVisible(active))
    if (!inChrome) {
      if (active && player.contains(active)) active.blur()
      if (dir === 'left' || dir === 'right') {
        // Let Player.onKey seek ±10s.
        e.stopPropagation()
        e.preventDefault()
        sendPlayerKey(dir === 'left' ? 'ArrowLeft' : 'ArrowRight')
        return
      }
      stop(e)
      if (e.repeat) return
      if (isEnter) sendPlayerKey(' ')
      else bumpPlayerChrome()
      window.setTimeout(() => {
        const target = primaryPlayerButton(player)
        if (target) focusEl(target)
      }, 60)
      return
    }
    // Seek slider: ±10s per press instead of the 1s native step.
    if (active && isRange(active) && (dir === 'left' || dir === 'right')) {
      const isVolume = Boolean(active.closest('.volume-control'))
      if (!isVolume) {
        stop(e)
        sendPlayerKey(dir === 'left' ? 'ArrowLeft' : 'ArrowRight')
        return
      }
      // Volume slider: native step; keep it away from Player's seek.
      e.stopPropagation()
      bumpPlayerChrome()
      return
    }
    if (isEnter) {
      bumpPlayerChrome()
      return // native button activation
    }
    if (dir) {
      stop(e)
      bumpPlayerChrome()
      const next = findNext(dir, active, player)
      if (next) focusEl(next, { dir })
    }
    return
  }

  // ---- Everywhere else.
  if (isEnter) {
    // Native activation (buttons, links, role=button handlers). Keep it from
    // reaching a PiP player's window listener only when it is a text field.
    return
  }
  if (!dir) return
  if (active && isTextInput(active) && (dir === 'left' || dir === 'right')) {
    const input = active as HTMLInputElement
    const len = typeof input.value === 'string' ? input.value.length : 0
    const pos = typeof input.selectionStart === 'number' ? input.selectionStart : null
    const atEdge = pos == null || (dir === 'left' ? pos <= 0 : pos >= len)
    if (!atEdge) {
      e.stopPropagation()
      return // caret movement
    }
  }
  if (active && isRange(active) && (dir === 'left' || dir === 'right')) {
    e.stopPropagation()
    return // native slider step
  }

  stop(e)
  const scope: ParentNode = modalScope() || document
  const menu = openMenu()
  let next: HTMLElement | null = null
  if (menu && (!active || !menu.contains(active))) {
    // A popup menu just opened from its trigger — move into it.
    next = findNext(dir, active, menu) || candidates(menu)[0] || null
  }
  if (!next) {
    const from = active && (scope === document || (scope as HTMLElement).contains(active)) ? active : null
    next = findNext(dir, from, scope)
  }
  if (next) focusEl(next, { dir, smooth: !e.repeat })
}

// ---------------------------------------------------------------- install

/** Wire remote navigation. Returns a teardown. Call only in tv-mode. */
export function startTvNav(): () => void {
  window.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  const offMedia = onTvMediaKey(handleMediaKey)
  const offPointer = androidBrowserOnTvPointer((mode) => {
    // Native Back in cursor mode → focus ring again; keep DOM focus on the surface.
    pointerMode = mode
    if (mode === 'focus' && pointerEl && pointerEl.isConnected) {
      try {
        pointerEl.focus({ preventScroll: true })
      } catch {
        /* ignore */
      }
    }
    if (mode === 'off') pointerEl = null
  })
  const onRoute = () => {
    if (pointerMode !== 'off') setPointer('off', null)
  }
  window.addEventListener('hashchange', onRoute)
  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('hashchange', onRoute)
    offMedia()
    offPointer()
    if (pointerMode !== 'off') setPointer('off', null)
  }
}

/** True while the native D-pad cursor is driving a Gecko surface. */
export function isTvPointerActive(): boolean {
  return pointerMode === 'cursor'
}

/** Auto-focus a freshly shown Gecko surface when nothing else has focus. */
export function focusTvSurfaceIfIdle(): void {
  const active = document.activeElement
  if (active && active !== document.body) return
  const surface = document.querySelector<HTMLElement>(TV_SURFACE_SELECTOR)
  if (surface && isElementVisible(surface)) focusEl(surface)
}

/**
 * TV Back: close an open popup menu by toggling its trigger, and park focus
 * on the trigger. Returns true when something was closed.
 */
export function closeOpenTvPopup(): boolean {
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-haspopup][aria-expanded="true"]'),
  ).filter((el) => isElementVisible(el))
  const trigger = triggers[triggers.length - 1]
  if (!trigger) return false
  trigger.click()
  window.setTimeout(() => focusEl(trigger), 30)
  return true
}
