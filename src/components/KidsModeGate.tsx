import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { isKidsModeEnabled, subscribeKidsMode } from '../lib/kidsMode'

function pathAllowedInKidsMode(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true
  if (pathname === '/section/kids' || pathname.startsWith('/section/kids/')) return true
  if (pathname.startsWith('/show/') || pathname.startsWith('/watch/')) return true
  if (pathname === '/library' || pathname.startsWith('/library')) return true
  return false
}

/** When Kids mode is on, block non-Kids browse routes (Library stays for PIN exit). */
export function KidsModeGate({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [kidsMode, setKidsMode] = useState(isKidsModeEnabled)

  useEffect(() => subscribeKidsMode(() => setKidsMode(isKidsModeEnabled())), [])

  if (kidsMode && !pathAllowedInKidsMode(location.pathname)) {
    return <Navigate to="/section/kids" replace />
  }

  return children
}
