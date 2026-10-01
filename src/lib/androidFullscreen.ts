/**
 * Android hardware Back → in-app navigation (not Activity.finish).
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type AppChromePlugin = {
  setImmersive: (options: { enabled: boolean }) => Promise<void>
  setBackHandling: (options: { enabled: boolean }) => Promise<{ ok?: boolean }>
  moveTaskToBack: () => Promise<void>
  exitApp: () => Promise<void>
  addListener: (
    event: 'backButton',
    listener: () => void,
  ) => Promise<PluginListenerHandle>
}

const AppChrome = registerPlugin<AppChromePlugin>('AppChrome')

export function isAndroidShell(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

/** Hide/show system bars while the CSS player shell covers the screen. */
export async function setAndroidImmersiveFullscreen(enabled: boolean): Promise<void> {
  if (!isAndroidShell()) return
  try {
    await AppChrome.setImmersive({ enabled })
  } catch {
    /* plugin missing on older builds */
  }
  try {
    document.documentElement.classList.toggle('android-player-fs', enabled)
  } catch {
    /* ignore */
  }
}

export async function setAndroidBackHandling(enabled: boolean): Promise<void> {
  if (!isAndroidShell()) return
  try {
    await AppChrome.setBackHandling({ enabled })
  } catch {
    /* ignore */
  }
}

export async function androidMoveTaskToBack(): Promise<void> {
  if (!isAndroidShell()) return
  try {
    await AppChrome.moveTaskToBack()
  } catch {
    /* ignore */
  }
}

/** Finish the Android task after the user confirmed Back→exit. */
export async function androidExitApp(): Promise<void> {
  if (!isAndroidShell()) return
  try {
    await AppChrome.exitApp()
  } catch {
    try {
      await AppChrome.moveTaskToBack()
    } catch {
      /* ignore */
    }
  }
}

export function onAndroidBackButton(listener: () => void): () => void {
  if (!isAndroidShell()) return () => {}
  let handle: PluginListenerHandle | undefined
  let removed = false
  void AppChrome.addListener('backButton', listener).then((h) => {
    if (removed) {
      void h.remove()
      return
    }
    handle = h
  })
  return () => {
    removed = true
    void handle?.remove()
  }
}

/** WebBrowserPage listens and runs leaveEmbed() (PiP + return path). */
export const ANDROID_LEAVE_WEB_EMBED_EVENT = 'jiyu:android-leave-web-embed'
