/**
 * Stack of dismiss handlers for full-screen overlays (Added today, etc.).
 * Android hardware Back and Escape can clear the top overlay without the Close button.
 */

type DismissFn = () => void

const stack: DismissFn[] = []

export function pushOverlayDismiss(fn: DismissFn): () => void {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** Returns true when an overlay consumed the dismiss. */
export function dismissTopOverlay(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top()
  return true
}
