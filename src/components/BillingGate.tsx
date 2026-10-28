import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  getAccessDecision,
  isPaywallFeatureEnabled,
  refreshEntitlement,
  subscribeBilling,
  type AccessDecision,
} from '../lib/billing'

/** Routes that stay reachable behind the paywall (settings, sign-in, the plan screen). */
function pathAlwaysAllowed(pathname: string): boolean {
  return pathname === '/account' || pathname === '/library' || pathname.startsWith('/library')
}

function GateInner({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [decision, setDecision] = useState<AccessDecision>(() => getAccessDecision())

  useEffect(() => {
    const update = () => setDecision(getAccessDecision())
    const refresh = () => {
      refreshEntitlement().then(setDecision, () => update())
    }
    refresh()
    const off = subscribeBilling(update)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', onVisible)
    // Re-evaluate locally every minute (trial end / grace end) and re-check the server when stale.
    const id = window.setInterval(() => {
      const next = getAccessDecision()
      setDecision(next)
      if (next.stale && navigator.onLine !== false) refresh()
    }, 60_000)
    return () => {
      off()
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(id)
    }
  }, [])

  if (decision.allowed || pathAlwaysAllowed(location.pathname)) return children

  return (
    <section className="page" style={{ padding: '2rem', maxWidth: 560 }}>
      <h2>{decision.reason === 'no-account' ? 'Start your free trial' : 'Your Jiyu access has ended'}</h2>
      <p className="field-hint">
        {decision.reason === 'no-account'
          ? 'Create a Jiyu account to start the trial. Your Continue watching list stays on this device.'
          : 'Choose a plan to keep watching. Your Library and settings stay available.'}
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <Link className="primary-btn" to="/account">
          See plans
        </Link>
        <Link className="ghost-btn" to="/library">
          Library
        </Link>
      </div>
    </section>
  )
}

/**
 * Trial / paywall gate. With the paywall flag off (the default) this renders its children
 * unchanged and does nothing else: no requests, no timers.
 */
export function BillingGate({ children }: { children: ReactNode }) {
  if (!isPaywallFeatureEnabled()) return children
  return <GateInner>{children}</GateInner>
}
