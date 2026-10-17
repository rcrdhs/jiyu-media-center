import { useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/** History-state flag: this entry was pushed by opening the overlay in-app. */
const PUSHED_KEY = 'jiyuOverlayPushed'

function wasPushed(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[PUSHED_KEY] === true
  )
}

/**
 * Overlay open-state kept in the URL (`?name=value`) instead of component state,
 * so opening a title and coming Back (browser/Electron history, Android hardware
 * Back via AndroidBackBridge, in-app Back links that use `state.from`) reopens
 * the same overlay instead of dropping the user on the bare page.
 */
export function useUrlOverlay<T extends string>(name: string, allowed: readonly T[]) {
  const location = useLocation()
  const navigate = useNavigate()
  const raw = new URLSearchParams(location.search).get(name)
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null
  // Backdrop click + pointerup can both fire for one tap; close a given entry once.
  const closedKey = useRef<string | null>(null)

  const open = useCallback(
    (next: T) => {
      const params = new URLSearchParams(location.search)
      if (params.get(name) === next) return
      params.set(name, next)
      navigate(
        { pathname: location.pathname, search: `?${params.toString()}` },
        { state: { [PUSHED_KEY]: true } },
      )
    },
    [location.pathname, location.search, name, navigate],
  )

  const close = useCallback(() => {
    if (closedKey.current === location.key) return
    const params = new URLSearchParams(location.search)
    if (!params.has(name)) return
    closedKey.current = location.key
    // Opened in-app: pop our own entry so Back history stays clean.
    if (wasPushed(location.state)) {
      navigate(-1)
      return
    }
    params.delete(name)
    const search = params.toString()
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '' },
      { replace: true },
    )
  }, [location.key, location.pathname, location.search, location.state, name, navigate])

  return [value, open, close] as const
}