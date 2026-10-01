/**
 * Capacitor InAppBrowser overlay — Android stand-in for Electron WebContentsView.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { BrowserBounds, BrowserNavState } from '../types'

type InAppBrowserPlugin = {
  show: (bounds: BrowserBounds) => Promise<{ ok: boolean; error?: string }>
  hide: (options?: { blank?: boolean; pause?: boolean }) => Promise<{ ok: boolean }>
  setBounds: (bounds: BrowserBounds) => Promise<{ ok: boolean }>
  navigate: (options: { url: string }) => Promise<{
    ok: boolean
    url?: string
    error?: string
    /** Reserved; Android in-app browser always stays in-process (GeckoView). */
    external?: boolean
  }>
  goBack: () => Promise<{ ok: boolean }>
  goForward: () => Promise<{ ok: boolean }>
  reload: () => Promise<{ ok: boolean }>
  execute: (options: { script: string }) => Promise<{ ok: boolean; result?: unknown }>
  clickCenter: (options?: { aggressive?: boolean }) => Promise<{ ok: boolean; error?: string }>
  tapPlay: () => Promise<{ ok: boolean; error?: string }>
  setVolume: (options: { percent: number }) => Promise<{ ok: boolean }>
  getVolume: () => Promise<{ ok: boolean; percent?: number }>
  fetchHtml: (options: {
    url: string
    headers?: Record<string, string>
  }) => Promise<{
    ok: boolean
    content?: string
    status?: number
    error?: string
  }>
  unlockOrigin: (options: { origin: string; timeoutMs?: number }) => Promise<{
    ok: boolean
    error?: string
  }>
  getState: () => Promise<BrowserNavState & { ok: boolean }>
  multiShow: (options: {
    id: string
    url: string
    x?: number
    y?: number
    width?: number
    height?: number
    bounds?: BrowserBounds
    primary?: boolean
  }) => Promise<{ ok: boolean; error?: string }>
  multiSetBounds: (options: {
    id: string
    x?: number
    y?: number
    width?: number
    height?: number
    bounds?: BrowserBounds
  }) => Promise<{ ok: boolean }>
  multiSetAudio: (options: { id: string; muted: boolean }) => Promise<{ ok: boolean }>
  multiSpotlight: (options: { id: string }) => Promise<{ ok: boolean }>
  multiNudge: (options: { id: string }) => Promise<{ ok: boolean }>
  multiHide: (options?: {
    id?: string
    blank?: boolean
    destroy?: boolean
  }) => Promise<{ ok: boolean }>
  multiHideAll: (options?: { blank?: boolean }) => Promise<{ ok: boolean }>
  addListener: (
    event: 'nav',
    listener: (nav: BrowserNavState) => void,
  ) => Promise<PluginListenerHandle>
}

const NativeBrowser = registerPlugin<InAppBrowserPlugin>('InAppBrowser')

export function isAndroidInAppBrowser(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** True when either Electron or Android overlay browser can host pages. */
export function isInAppBrowserAvailable(): boolean {
  if (window.signalDesktop?.isDesktop || window.signalDesktop?.browserNavigate) return true
  if (/Electron/i.test(navigator.userAgent)) return true
  return isAndroidInAppBrowser()
}

export async function androidBrowserShow(bounds: BrowserBounds) {
  return NativeBrowser.show(bounds)
}

export async function androidBrowserHide(options?: { blank?: boolean; pause?: boolean }) {
  return NativeBrowser.hide(options)
}

export async function androidBrowserSetBounds(bounds: BrowserBounds) {
  return NativeBrowser.setBounds(bounds)
}

export async function androidBrowserNavigate(url: string) {
  return NativeBrowser.navigate({ url })
}

export async function androidBrowserGoBack() {
  return NativeBrowser.goBack()
}

export async function androidBrowserGoForward() {
  return NativeBrowser.goForward()
}

export async function androidBrowserReload() {
  return NativeBrowser.reload()
}

export async function androidBrowserGetState(): Promise<BrowserNavState | null> {
  try {
    const state = await NativeBrowser.getState()
    if (!state?.ok && state?.ok !== undefined) return null
    return {
      url: state.url || '',
      title: state.title || 'Web browser',
      canGoBack: Boolean(state.canGoBack),
      canGoForward: Boolean(state.canGoForward),
      loading: Boolean(state.loading),
      external: Boolean((state as { external?: boolean }).external),
    }
  } catch {
    return null
  }
}

export async function androidBrowserFetchHtml(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<{
  ok: boolean
  content: string
  status: number
  error: string
}> {
  const result = await NativeBrowser.fetchHtml({
    url,
    headers: options?.headers,
  })
  return {
    ok: Boolean(result.ok),
    content: result.content || '',
    status: result.status || 0,
    error: result.error || '',
  }
}

/** Show the in-app browser so the user can complete Cloudflare Verify once. */
export async function androidBrowserUnlockOrigin(
  origin: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  try {
    const result = await NativeBrowser.unlockOrigin({ origin, timeoutMs })
    return Boolean(result.ok)
  } catch {
    return false
  }
}

export async function androidBrowserExecute(script: string): Promise<{ ok: boolean; result?: unknown }> {
  try {
    return await NativeBrowser.execute({ script })
  } catch {
    return { ok: false }
  }
}

/** Tap the paused play button. Does nothing when a video is already playing. */
export async function androidBrowserTapPlay(): Promise<boolean> {
  try {
    const result = await NativeBrowser.tapPlay()
    return Boolean(result.ok)
  } catch {
    return false
  }
}

export async function androidBrowserClickCenter(aggressive = false): Promise<boolean> {
  try {
    const result = await NativeBrowser.clickCenter({ aggressive })
    return Boolean(result.ok)
  } catch {
    return false
  }
}

export async function androidBrowserSetVolume(percent: number): Promise<void> {
  try {
    await NativeBrowser.setVolume({ percent })
  } catch {
    /* ignore */
  }
}

export async function androidBrowserGetVolume(): Promise<number> {
  try {
    const result = await NativeBrowser.getVolume()
    return Math.max(0, Math.min(100, Number(result.percent) || 100))
  } catch {
    return 100
  }
}

export function androidBrowserOnNav(listener: (nav: BrowserNavState) => void) {
  let handle: PluginListenerHandle | undefined
  void NativeBrowser.addListener('nav', listener).then((h) => {
    handle = h
  })
  return () => {
    void handle?.remove()
  }
}

function boundsPayload(id: string, bounds: BrowserBounds) {
  return {
    id,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    bounds,
  }
}

export async function androidBrowserMultiShow(payload: {
  id: string
  url: string
  bounds: BrowserBounds
  primary?: boolean
}) {
  return NativeBrowser.multiShow({
    ...boundsPayload(payload.id, payload.bounds),
    url: payload.url,
    primary: Boolean(payload.primary),
  })
}

export async function androidBrowserMultiSetBounds(payload: {
  id: string
  bounds: BrowserBounds
}) {
  return NativeBrowser.multiSetBounds(boundsPayload(payload.id, payload.bounds))
}

export async function androidBrowserMultiSetAudio(payload: { id: string; muted: boolean }) {
  return NativeBrowser.multiSetAudio(payload)
}

export async function androidBrowserMultiSpotlight(payload: { id: string }) {
  return NativeBrowser.multiSpotlight(payload)
}

export async function androidBrowserMultiNudge(payload: { id: string }) {
  return NativeBrowser.multiNudge(payload)
}

export async function androidBrowserMultiHide(payload?: {
  id?: string
  blank?: boolean
  destroy?: boolean
}) {
  return NativeBrowser.multiHide(payload || {})
}

export async function androidBrowserMultiHideAll(options?: { blank?: boolean }) {
  return NativeBrowser.multiHideAll(options || {})
}
