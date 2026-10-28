import { Link } from 'react-router-dom'
import { isPaywallFeatureEnabled } from '../lib/billing'

/** "Account & plan" entry in Library. Renders nothing unless the paywall flag is on. */
export function AccountPlanLink() {
  if (!isPaywallFeatureEnabled()) return null
  return (
    <>
      <h3 className="field-label" style={{ marginTop: '1.25rem' }}>
        Account &amp; plan
      </h3>
      <p className="field-hint" style={{ marginTop: '0.25rem', opacity: 0.75 }}>
        Trial status, subscription and billing for your sync account.
      </p>
      <Link className="ghost-btn" to="/account">
        Open Account &amp; plan
      </Link>
    </>
  )
}
