/**
 * Optional bilibili.tv account (Settings → Bilibili), per device.
 *
 * The account cookie never reaches the renderer:
 *  - Desktop: Electron main captures it from the in-app browser (persist:jiyu-web) after the
 *    user taps Sign in, stores it with safeStorage, and adds it in `bili:fetch` when
 *    `tvSession: true` is set on a playurl / subtitle API request.
 *  - Android: the BiliSession plugin signs in inside a System WebView sheet (GeckoView can't
 *    expose its cookies), keeps the cookie Keystore-encrypted in app-private prefs, and its
 *    `fetch` adds it to the same two APIs only.
 * Plain browser / probes: never signed in.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import type { BiliTvSessionStatus } from '../types'
import { biliLog } from './biliLog'

export type { BiliTvSessionStatus }

type SessionFetchResult = {
  ok: boolean
  status: number
  content: string
  error?: string
  withSession?: boolean
}

interface BiliSessionPlugin {
  status(): Promise<BiliTvSessionStatus>
  signIn(options?: { timeoutMs?: number }): Promise<BiliTvSessionStatus & { ok: boolean; error?: string; cancelled?: boolean }>
  cancelSignIn(): Promise<BiliTvSessionStatus>
  signOut(): Promise<BiliTvSessionStatus>
  fetch(options: { url: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<SessionFetchResult>
}

const AndroidBiliSession = registerPlugin<BiliSessionPlugin>('BiliSession')

const SIGNED_OUT: BiliTvSessionStatus = { signedIn: false, encrypted: false, savedAt: 0 }
/** Path allowlist mirrored in main.cjs / BiliSessionPlugin.java. */
const SESSION_PATHS = new Set(['/intl/gateway/web/playurl', '/intl/gateway/web/v2/subtitle'])

function desktop() {
  return typeof window !== 'undefined' ? window.signalDesktop : undefined
}

function isAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** Sign-in is available on this device (desktop after a main restart; Android with the plugin). */
export function biliTvSessionSupported(): boolean {
  const d = desktop()
  if (d) return typeof d.biliTvSessionStatus === 'function'
  if (isAndroid()) {
    try {
      return Capacitor.isPluginAvailable('BiliSession')
    } catch {
      return false
    }
  }
  return false
}

let cached: BiliTvSessionStatus | null = null
const listeners = new Set<(s: BiliTvSessionStatus) => void>()
let desktopUnsub: (() => void) | null = null

function publish(s: BiliTvSessionStatus): BiliTvSessionStatus {
  const next = { signedIn: Boolean(s?.signedIn), encrypted: Boolean(s?.encrypted), savedAt: Number(s?.savedAt) || 0, capturing: Boolean(s?.capturing) }
  const changed = !cached || cached.signedIn !== next.signedIn || cached.savedAt !== next.savedAt || cached.capturing !== next.capturing
  cached = next
  if (changed) for (const fn of listeners) fn(next)
  return next
}

function ensureDesktopListener(): void {
  const d = desktop()
  if (desktopUnsub || !d?.onBiliTvSession) return
  desktopUnsub = d.onBiliTvSession((s) => {
    publish(s)
    biliLog('session.changed', { signedIn: Boolean(s?.signedIn) })
  })
}

export async function getBiliTvSessionStatus(): Promise<BiliTvSessionStatus> {
  if (!biliTvSessionSupported()) return SIGNED_OUT
  try {
    const d = desktop()
    if (d?.biliTvSessionStatus) {
      ensureDesktopListener()
      return publish(await d.biliTvSessionStatus())
    }
    return publish(await AndroidBiliSession.status())
  } catch {
    return cached || SIGNED_OUT
  }
}

export function onBiliTvSessionChange(fn: (s: BiliTvSessionStatus) => void): () => void {
  listeners.add(fn)
  ensureDesktopListener()
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Start sign-in.
 * Desktop: arms cookie capture in main and returns the page to open in the in-app browser
 * (`openUrl`); the status flips through `onBiliTvSessionChange` once the user signs in.
 * Android: opens the native sign-in sheet and resolves when it closes.
 */
export async function startBiliTvSignIn(): Promise<{
  status: BiliTvSessionStatus
  openUrl?: string
  error?: string
  cancelled?: boolean
}> {
  const d = desktop()
  if (d?.biliTvSignIn) {
    ensureDesktopListener()
    const r = await d.biliTvSignIn()
    biliLog('session.signIn.start', { platform: 'desktop', already: Boolean(r?.signedIn) })
    return { status: publish(r), openUrl: r.signedIn ? undefined : r.loginUrl }
  }
  if (isAndroid() && biliTvSessionSupported()) {
    biliLog('session.signIn.start', { platform: 'android' })
    const r = await AndroidBiliSession.signIn({ timeoutMs: 15 * 60_000 })
    biliLog('session.signIn.done', { ok: Boolean(r?.ok), cancelled: Boolean(r?.cancelled) })
    return { status: publish(r), error: r.ok ? undefined : r.error, cancelled: r.cancelled }
  }
  return { status: SIGNED_OUT, error: 'Bilibili sign-in is not available here' }
}

export async function cancelBiliTvSignIn(): Promise<void> {
  try {
    const d = desktop()
    if (d?.biliTvSignInCancel) publish(await d.biliTvSignInCancel())
    else if (isAndroid() && biliTvSessionSupported()) publish(await AndroidBiliSession.cancelSignIn())
  } catch {
    /* ignore */
  }
}

export async function signOutBiliTv(): Promise<BiliTvSessionStatus> {
  try {
    const d = desktop()
    if (d?.biliTvSignOut) return publish(await d.biliTvSignOut())
    if (isAndroid() && biliTvSessionSupported()) return publish(await AndroidBiliSession.signOut())
  } catch {
    /* ignore */
  }
  return publish(SIGNED_OUT)
}

function isSessionUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'api.bilibili.tv' && SESSION_PATHS.has(u.pathname)
  } catch {
    return false
  }
}

/**
 * JSON GET through the signed-in session (playurl / subtitle APIs only).
 * Returns null when not signed in / unsupported so the caller uses its anonymous path.
 */
export async function biliTvSessionJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  if (!isSessionUrl(url) || !biliTvSessionSupported()) return null
  const status = cached || (await getBiliTvSessionStatus())
  if (!status.signedIn) return null
  try {
    const d = desktop()
    const r: SessionFetchResult | null = d?.biliFetch
      ? await d.biliFetch({ url, headers, timeoutMs: 15_000, tvSession: true })
      : isAndroid()
        ? await AndroidBiliSession.fetch({ url, headers, timeoutMs: 15_000 })
        : null
    if (!r || !r.content) return null
    if (!r.withSession) biliLog('session.notApplied', { path: new URL(url).pathname })
    return JSON.parse(r.content) as T
  } catch (err) {
    biliLog('session.fetch.fail', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
