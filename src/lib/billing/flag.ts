/**
 * Paywall feature flag. OFF unless the build sets VITE_JIYU_PAYWALL=1, or (dev server only)
 * localStorage "jiyu.billing.devPaywall" is "1". With the flag off nothing in src/lib/billing
 * runs: no network calls, no gate, no Account link. See docs/payments.md.
 */
export const DEV_PAYWALL_KEY = 'jiyu.billing.devPaywall'

export function isPaywallFeatureEnabled(): boolean {
  const env = import.meta.env as unknown as Record<string, string | boolean | undefined>
  if (env.VITE_JIYU_PAYWALL === '1') return true
  if (env.DEV === true) {
    try {
      return localStorage.getItem(DEV_PAYWALL_KEY) === '1'
    } catch {
      return false
    }
  }
  return false
}
