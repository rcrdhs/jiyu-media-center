/**
 * Single owner for Jiyu OS fullscreen so native Player, web embeds, and PiP
 * don't fight each other (Esc double-toggles, PiP clearing embed Full, etc.).
 */

export type FullscreenOwner = 'native' | 'web' | 'multi' | null

let owner: FullscreenOwner = null
const listeners = new Set<(owner: FullscreenOwner) => void>()

function notify() {
  for (const listener of listeners) {
    try {
      listener(owner)
    } catch {
      /* ignore */
    }
  }
}

export function getFullscreenOwner(): FullscreenOwner {
  return owner
}

/** Assign who may drive Full next (does not toggle OS fullscreen by itself). */
export function claimFullscreenOwner(next: FullscreenOwner): void {
  if (owner === next) return
  owner = next
  notify()
}

export function subscribeFullscreenOwner(listener: (owner: FullscreenOwner) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * True when the in-app browser is actively holding fullscreen — not merely
 * because an idle web PiP / /web page is mounted beside a native stream.
 */
export function webSurfaceOwnsFullscreen(): boolean {
  if (typeof document === 'undefined') return false
  if (owner === 'web') return true
  return Boolean(
    document.querySelector('.web-browser-page.is-fullscreen') ||
      document.querySelector('.web-browser-pip-fs-bar') ||
      document.querySelector('.web-embed-tile.is-fullscreen') ||
      document.querySelector('.multi-view.is-fullscreen'),
  )
}

export async function enterOsFullscreen(nextOwner: Exclude<FullscreenOwner, null>): Promise<void> {
  owner = nextOwner
  notify()
  try {
    const { isAndroidShell, setAndroidImmersiveFullscreen } = await import('./androidFullscreen')
    if (isAndroidShell()) {
      await setAndroidImmersiveFullscreen(true)
      return
    }
  } catch {
    /* ignore */
  }
  try {
    await window.signalDesktop?.setFullScreen?.(true)
  } catch {
    /* ignore */
  }
}

export async function exitOsFullscreen(options?: {
  /** Only clear if this owner currently holds FS (or force). */
  onlyIfOwner?: FullscreenOwner
  force?: boolean
}): Promise<void> {
  if (!options?.force && options?.onlyIfOwner && owner && owner !== options.onlyIfOwner) {
    return
  }
  owner = null
  notify()
  try {
    const { isAndroidShell, setAndroidImmersiveFullscreen } = await import('./androidFullscreen')
    if (isAndroidShell()) {
      await setAndroidImmersiveFullscreen(false)
    }
  } catch {
    /* ignore */
  }
  try {
    await window.signalDesktop?.setFullScreen?.(false)
  } catch {
    /* ignore */
  }
  try {
    await window.signalDesktop?.exitFullScreen?.()
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    try {
      await document.exitFullscreen()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Stream ended, PiP closed, or another title selected — drop a sticky web claim
 * so the current stream can take Full. Exits OS FS only when web held it.
 */
export async function handFullscreenToCurrentStream(
  next: Exclude<FullscreenOwner, null> | null,
): Promise<void> {
  if (owner === 'web' && next !== 'web') {
    await exitOsFullscreen({ force: true })
  }
  claimFullscreenOwner(next)
}

/** Sync owner from Electron leave/enter when we didn't initiate the change. */
export function syncFullscreenOwnerFromOs(fullScreen: boolean, preferOwner?: FullscreenOwner) {
  if (fullScreen) {
    if (!owner) {
      owner = preferOwner || (webSurfaceOwnsFullscreen() ? 'web' : 'native')
      notify()
    }
    return
  }
  owner = null
  notify()
}
