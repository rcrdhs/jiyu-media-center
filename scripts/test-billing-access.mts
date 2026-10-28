// Unit checks for the client paywall decision (src/lib/billing/access.ts).
// Run: npx tsx scripts/test-billing-access.mts
import { billingOffSnapshot, decideAccess, parseSnapshot, type CachedEntitlement } from '../src/lib/billing/access.ts'

const H = 3_600_000
const D = 24 * H
let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

const T0 = 1_800_000_000_000
function cache(over: Record<string, unknown>, at = T0, skewMs = 0, userId: string | null = 'u1'): CachedEntitlement {
  return { snapshot: parseSnapshot({ enabled: true, now: at + skewMs, recheckAfterMs: 6 * H, offlineGraceMs: 72 * H, ...over }, at), checkedAt: at, skewMs, userId }
}
const base = { flagOn: true, signedIn: true, userId: 'u1', nowLocal: T0, lastSeenLocal: T0 }

let d = decideAccess({ ...base, flagOn: false, signedIn: false, cache: null })
check('flag off: always allowed', d.allowed && d.reason === 'flag-off', d)
d = decideAccess({ ...base, cache: { snapshot: billingOffSnapshot(T0), checkedAt: T0, skewMs: 0, userId: 'u1' } })
check('server billing off (404): allowed', d.allowed && d.reason === 'billing-off', d)
d = decideAccess({ ...base, signedIn: false, userId: null, cache: null })
check('no account: paywall (start trial)', !d.allowed && d.reason === 'no-account', d)
d = decideAccess({ ...base, cache: null })
check('signed in, never checked: fail open + stale', d.allowed && d.reason === 'unknown' && d.stale, d)

const trial = cache({ entitled: true, status: 'trialing', trialEndsAt: T0 + 2 * D, accessUntil: T0 + 2 * D })
d = decideAccess({ ...base, cache: trial, nowLocal: T0 + D, lastSeenLocal: T0 + D })
check('trial day 1: allowed, stale after 6h', d.allowed && d.reason === 'entitled' && d.stale, d)
d = decideAccess({ ...base, cache: trial, nowLocal: T0 + 3 * D, lastSeenLocal: T0 + 3 * D })
check('trial over (offline): no grace for trials', !d.allowed && d.reason === 'not-entitled', d)

const paid = cache({ entitled: true, status: 'active', plan: 'monthly', currentPeriodEnd: T0 + 10 * D, accessUntil: T0 + 12 * D })
d = decideAccess({ ...base, cache: paid, nowLocal: T0 + 5 * D, lastSeenLocal: T0 + 5 * D })
check('active mid-period: allowed', d.allowed && d.reason === 'entitled', d)
d = decideAccess({ ...base, cache: paid, nowLocal: T0 + 13 * D, lastSeenLocal: T0 + 13 * D })
check('active, accessUntil passed offline: offline grace', d.allowed && d.reason === 'offline-grace' && d.graceUntilLocal === T0 + 15 * D, d)
d = decideAccess({ ...base, cache: paid, nowLocal: T0 + 16 * D, lastSeenLocal: T0 + 16 * D })
check('active, grace over: paywall', !d.allowed && d.reason === 'not-entitled', d)

const canceling = cache({ entitled: true, status: 'active', cancelAtPeriodEnd: true, accessUntil: T0 + 2 * D })
d = decideAccess({ ...base, cache: canceling, nowLocal: T0 + 3 * D, lastSeenLocal: T0 + 3 * D })
check('cancel at period end: no grace after end', !d.allowed, d)

const expired = cache({ entitled: false, status: 'expired', accessUntil: T0 - D })
d = decideAccess({ ...base, cache: expired })
check('expired: paywall', !d.allowed && d.reason === 'not-entitled', d)

const comp = cache({ entitled: true, status: 'comp', accessUntil: null })
d = decideAccess({ ...base, cache: comp, nowLocal: T0 + 400 * D, lastSeenLocal: T0 + 400 * D })
check('comp forever: allowed', d.allowed && d.reason === 'entitled', d)

// Clock rollback: device was at T0+3d (trial over), user sets the clock back to T0.
d = decideAccess({ ...base, cache: trial, nowLocal: T0, lastSeenLocal: T0 + 3 * D })
check('clock rolled back: does not revive an ended trial', !d.allowed, d)

// Skew: device clock 1 day behind the server. Server says accessUntil = server T0+2d.
const skewed = cache({ entitled: true, status: 'trialing', accessUntil: T0 + 2 * D }, T0 - D, D)
d = decideAccess({ ...base, cache: skewed, nowLocal: T0 + 0.5 * D, lastSeenLocal: T0 + 0.5 * D })
check('skew-corrected end (local clock 1d slow): still on before local end', d.allowed && d.accessUntilLocal === T0 + D, d)
d = decideAccess({ ...base, cache: skewed, nowLocal: T0 + 1.5 * D, lastSeenLocal: T0 + 1.5 * D })
check('skew-corrected end (local clock 1d slow): already ended', !d.allowed && d.accessUntilLocal === T0 + D, d)

d = decideAccess({ ...base, userId: 'u2', cache: expired })
check('cache from another account is ignored', d.allowed && d.reason === 'unknown', d)

const junk = parseSnapshot({ entitled: 'yes', accessUntil: 'soon', now: 'x' }, 123)
check('parseSnapshot is defensive', junk.entitled === false && junk.accessUntil === null && junk.now === 123, junk)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
