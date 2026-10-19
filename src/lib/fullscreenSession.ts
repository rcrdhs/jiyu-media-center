/**
 * Single owner for Jiyu OS fullscreen so native Player, web embeds, and PiP
 * don't fight each other (Esc double-toggles, PiP clearing embed Full, etc.).
 */

export type FullscreenOwner = 'native' | 'web' | 'multi' | null

let owner: FullscreenOwner = null
/** An OS fullscreen exit is already running; a second one adds nothing. */
let osExitInFlight = false
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
  return webSurfaceFullscreenMounted()
}

/** A web / multi-view surface is actually on screen in its fullscreen layout (DOM only). */
export function webSurfaceFullscreenMounted(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(
    document.querySelector('.web-browser-page.is-fullscreen') ||
      document.querySelector('.web-browser-pip-fs-bar') ||
      document.querySelector('.web-embed-tile.is-fullscreen') ||
      document.querySelector('.multi-view.is-fullscreen'),
  )
}

/**
 * True when Full should use OS/immersive fullscreen only — not the HTML
 * Fullscreen API. Electron's HTML FS enter/leave races `exitOsFullscreen` and
 * makes the Full button look broken; Android WebView requestFullscreen crops.
 */
export function usesOsFullscreenOnly(): boolean {
  if (typeof window !== 'undefined' && window.signalDesktop?.setFullScreen) return true
  try {
    // Inline Capacitor check — avoid importing androidFullscreen at module load.
    const cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
      }
    ).Capacitor
    return Boolean(cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android')
  } catch {
    return false
  }
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
  // Re-entry guard: an exit still in flight already covers this call, so a
  // force-exit echo from main can't start another round trip (ping-pong).
  if (osExitInFlight) return
  osExitInFlight = true
  try {
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
  } finally {
    osExitInFlight = false
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
