/**
 * Device Home → Android system picture-in-picture.
 * The in-app corner player is separate; this is the floating window after Jiyu leaves.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type AppChromePlugin = {
  setHomePip: (options: { enabled: boolean; width: number; height: number }) => Promise<{ ok?: boolean }>
  addListener: (
    event: 'systemPip',
    listener: (event: { active?: boolean }) => void,
  ) => Promise<PluginListenerHandle>
}

const AppChrome = registerPlugin<AppChromePlugin>('AppChrome')

export function isAndroidSystemPipHost(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

export async function setAndroidHomePip(options: {
  enabled: boolean
  width: number
  height: number
}): Promise<void> {
  if (!isAndroidSystemPipHost()) return
  try {
    await AppChrome.setHomePip(options)
  } catch {
    /* older builds */
  }
}

let systemPipExitAt = 0

/** Record system PiP enter/leave (SystemPipBridge). */
export function markAndroidSystemPip(active: boolean): void {
  systemPipExitAt = active ? 0 : Date.now()
}

/** True in system PiP or within `ms` after expanding out of it. */
export function androidSystemPipSettling(ms = 2000): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('is-system-pip')) {
    return true
  }
  return systemPipExitAt > 0 && Date.now() - systemPipExitAt < ms
}

export function onAndroidSystemPip(listener: (active: boolean) => void): () => void {
  if (!isAndroidSystemPipHost()) return () => {}
  let handle: PluginListenerHandle | undefined
  let removed = false
  void AppChrome.addListener('systemPip', (event) => {
    listener(Boolean(event?.active))
  }).then((h) => {
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
