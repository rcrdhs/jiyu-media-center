import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createProgressSyncAccount,
  getProgressSyncStatus,
  subscribeProgressSync,
  type ProgressSyncStatus,
} from '../lib/progressSync'
import {
  getAccessDecision,
  isPaywallFeatureEnabled,
  listBillingPlans,
  openBillingPortal,
  readEntitlementCache,
  refreshEntitlement,
  startCheckout,
  subscribeBilling,
  type AccessDecision,
  type BillingPlan,
} from '../lib/billing'

function when(ts: number | null | undefined): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return '-'
  }
}

const STATUS_LABEL: Record<string, string> = {
  none: 'No plan',
  trialing: 'Free trial',
  active: 'Subscribed',
  past_due: 'Payment problem (still active for now)',
  canceled: 'Canceled (active until period end)',
  comp: 'Complimentary',
  expired: 'Expired',
}

/** Account / plan screen. Only linked from the UI when the paywall flag is on. */
export function AccountPage() {
  const flagOn = isPaywallFeatureEnabled()
  const [sync, setSync] = useState<ProgressSyncStatus>(() => getProgressSyncStatus())
  const [decision, setDecision] = useState<AccessDecision>(() => getAccessDecision())
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!flagOn) return
    const update = () => {
      setSync(getProgressSyncStatus())
      setDecision(getAccessDecision())
    }
    const offA = subscribeBilling(update)
    const offB = subscribeProgressSync(update)
    return () => {
      offA()
      offB()
    }
  }, [flagOn])

  const reload = useCallback(async () => {
    try {
      setDecision(await refreshEntitlement())
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
    try {
      setPlans(await listBillingPlans())
    } catch {
      setPlans(null)
    }
  }, [])

  useEffect(() => {
    if (flagOn) void reload()
  }, [flagOn, sync.signedIn, reload])

  async function run(action: () => Promise<void>, okMsg: string) {
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      await action()
      setNote(okMsg)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!flagOn) {
    return (
      <section style={{ padding: '2rem', maxWidth: 640 }}>
        <h2>Account</h2>
        <p className="field-hint">Plans are not enabled in this build. Jiyu is free to use.</p>
        <Link className="ghost-btn" to="/library">
          Back to Library
        </Link>
      </section>
    )
  }

  const snap = readEntitlementCache()?.snapshot ?? null
  const billingOff = decision.reason === 'billing-off'

  return (
    <section style={{ padding: '2rem', maxWidth: 640 }}>
      <h2>Account &amp; plan</h2>

      {!sync.configured ? (
        <p className="field-hint">Set a sync server in Library first; plans are tied to your sync account.</p>
      ) : !sync.signedIn ? (
        <>
          <p className="field-hint">
            Your plan is attached to your Jiyu sync account, so it works on every linked device.
            Already have an account on another device? Link this device with a pair code in Library.
          </p>
          <button
            type="button"
            className="primary-btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await createProgressSyncAccount('This device')
                setDecision(await refreshEntitlement())
              }, 'Account created')
            }
          >
            Create account and start free trial
          </button>
        </>
      ) : billingOff ? (
        <p className="field-hint">This sync server does not use plans. Everything is available.</p>
      ) : (
        <>
          <p className="field-label" style={{ marginTop: '0.5rem' }}>
            Status: <strong>{STATUS_LABEL[String(snap?.status ?? 'none')] ?? String(snap?.status)}</strong>
            {snap?.plan && snap.plan !== 'trial' ? ` (${snap.plan})` : ''}
          </p>
          {snap?.status === 'trialing' ? (
            <p className="field-hint">Trial ends {when(snap.trialEndsAt)}</p>
          ) : null}
          {snap?.currentPeriodEnd ? (
            <p className="field-hint">
              {snap.cancelAtPeriodEnd ? 'Access ends' : 'Renews'} {when(snap.currentPeriodEnd)}
            </p>
          ) : null}
          {decision.reason === 'offline-grace' ? (
            <p className="field-hint">
              Offline: could not confirm your renewal. Access continues until {when(decision.graceUntilLocal)}; connect
              to the internet to refresh.
            </p>
          ) : null}
          {decision.reason === 'unknown' ? (
            <p className="field-hint">Checking your plan...</p>
          ) : null}

          {snap?.status !== 'active' && snap?.status !== 'comp' ? (
            <>
              <h3 className="field-label" style={{ marginTop: '1rem' }}>
                Plans
              </h3>
              {plans === null ? (
                <p className="field-hint">Plans unavailable offline.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {plans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      className="primary-btn"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => startCheckout(plan.id),
                          'Checkout opened in your browser. Come back here and press Refresh when done.',
                        )
                      }
                    >
                      {plan.label}
                      {plan.priceLabel ? ` - ${plan.priceLabel}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
            {snap?.canManage ? (
              <button
                type="button"
                className="ghost-btn"
                disabled={busy}
                onClick={() => run(() => openBillingPortal(), 'Billing page opened in your browser')}
              >
                Manage subscription
              </button>
            ) : null}
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => run(reload, 'Refreshed')}>
              Refresh
            </button>
          </div>
          {snap?.provider === 'test' || snap?.provider === 'stripe' ? (
            <p className="field-hint" style={{ opacity: 0.6, marginTop: '0.75rem' }}>
              Test mode: no real payments are taken by this build.
            </p>
          ) : null}
        </>
      )}

      {note ? <p className="field-hint">{note}</p> : null}
      {err ? (
        <p className="field-hint" role="alert" style={{ color: 'var(--danger, #f66)' }}>
          {err}
        </p>
      ) : null}
    </section>
  )
}
