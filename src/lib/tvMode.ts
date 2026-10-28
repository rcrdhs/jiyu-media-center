/**
 * TV mode (Android TV / Google TV / Fire TV). Adds `tv-mode` to <html>.
 * Everything TV-specific — remote navigation, focus rings, 10-foot layout —
 * is gated on this class, so phones and desktop keep their current behaviour.
 *
 * Native truth: AppChrome.getDeviceInfo() (UiModeManager / FEATURE_LEANBACK).
 * The last answer is cached so the class lands before first paint next launch.
 * Dev override (desktop / browser testing): `?tv=1` / `?tv=0` in the URL, or
 * localStorage `jiyu.tvMode.force` = '1' | '0'.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

const CACHE_KEY = 'jiyu.tvMode.native'
const FORCE_KEY = 'jiyu.tvMode.force'
export const TV_MODE_CLASS = 'tv-mode'
export const TV_MODE_EVENT = 'jiyu:tv-mode'

type AppChromeTvPlugin = {
  getDeviceInfo?: () => Promise<{ tv?: boolean }>
  addListener: (
    event: 'mediaKey',
    listener: (data: { key?: string }) => void,
  ) => Promise<PluginListenerHandle>
}

const AppChromeTv = registerPlugin<AppChromeTvPlugin>('AppChrome')

let current = false

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

function isAndroidNative(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** `?tv=1` (query or hash query) pins the override; `?tv=0` clears it. */
function readUrlOverride(): '1' | '0' | null {
  try {
    const href = window.location.href
    const match = /[?&]tv=([01])\b/.exec(href)
    if (!match) return null
    return match[1] as '1' | '0'
  } catch {
    return null
  }
}

function forced(): boolean | null {
  const fromUrl = readUrlOverride()
  if (fromUrl === '1') {
    writeStorage(FORCE_KEY, '1')
    return true
  }
  if (fromUrl === '0') {
    writeStorage(FORCE_KEY, null)
    return false
  }
  const stored = readStorage(FORCE_KEY)
  if (stored === '1') return true
  if (stored === '0') return false
  return null
}

function apply(on: boolean) {
  if (on === current && document.documentElement.classList.contains(TV_MODE_CLASS) === on) return
  current = on
  try {
    document.documentElement.classList.toggle(TV_MODE_CLASS, on)
    document.body?.classList.toggle(TV_MODE_CLASS, on)
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(TV_MODE_EVENT, { detail: { on } }))
  } catch {
    /* ignore */
  }
}

export function isTvMode(): boolean {
  return current
}

/**
 * Call once before React renders. Synchronous best guess (override / cache),
 * then confirms with the native shell. Older APKs without getDeviceInfo → not TV.
 */
export function initTvMode(): void {
  const force = forced()
  if (force !== null) {
    apply(force)
    return
  }
  if (!isAndroidNative()) {
    apply(false)
    return
  }
  apply(readStorage(CACHE_KEY) === '1')
  void (async () => {
    let tv = false
    try {
      const fn = AppChromeTv.getDeviceInfo
      if (typeof fn === 'function') {
        const info = await fn()
        tv = Boolean(info?.tv)
      }
    } catch {
      tv = false
    }
    writeStorage(CACHE_KEY, tv ? '1' : '0')
    apply(tv)
  })()
}

/** TV remote media keys from MainActivity (play/pause, rewind, forward, …). */
export function onTvMediaKey(listener: (key: string) => void): () => void {
  if (!isAndroidNative()) return () => {}
  let handle: PluginListenerHandle | undefined
  let removed = false
  void AppChromeTv.addListener('mediaKey', (data) => {
    if (data?.key) listener(String(data.key))
  })
    .then((h) => {
      if (removed) void h.remove()
      else handle = h
    })
    .catch(() => undefined)
  return () => {
    removed = true
    void handle?.remove()
  }
}
