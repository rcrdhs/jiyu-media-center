/**
 * Pure access decision for the paywall gate (no DOM, no network) so it can be unit tested
 * with `npx tsx scripts/test-billing-access.mts`.
 *
 * The server is the source of truth (GET /v1/entitlement). The client keeps the last answer
 * and decides offline from it:
 *  - billing disabled on the server (404) -> allowed
 *  - entitled and accessUntil not reached (server clock, skew-corrected) -> allowed
 *  - paid plan whose accessUntil passed while we could not re-check -> allowed for
 *    offlineGraceMs after accessUntil (a renewal probably happened; we just could not see it)
 *  - trials get no offline extension
 *  - the local clock is never trusted to move backwards: effective now is
 *    max(now, checkedAt, lastSeen), so rolling the clock back does not extend access.
 * This is a convenience gate, not DRM: a modified client can always skip it.
 */

export type EntitlementStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'comp' | 'expired' | string

export type EntitlementSnapshot = {
  enabled: boolean
  provider: string | null
  entitled: boolean
  status: EntitlementStatus
  plan: string | null
  trialEndsAt: number | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  accessUntil: number | null
  canManage: boolean
  /** Server clock (ms) when the answer was produced. */
  now: number
  recheckAfterMs: number
  offlineGraceMs: number
}

export type CachedEntitlement = {
  snapshot: EntitlementSnapshot
  /** Local clock (ms) when the answer arrived. */
  checkedAt: number
  /** snapshot.now - checkedAt: add to a local time to estimate server time. */
  skewMs: number
  /** Account the answer belongs to; a different signed-in account ignores it. */
  userId: string | null
}

export type AccessReason =
  | 'flag-off'
  | 'billing-off'
  | 'entitled'
  | 'offline-grace'
  | 'unknown'
  | 'no-account'
  | 'not-entitled'

export type AccessDecision = {
  allowed: boolean
  reason: AccessReason
  /** Cached answer is older than recheckAfterMs (caller should refresh when online). */
  stale: boolean
  /** Local-clock ms when access ends (null = open-ended or not applicable). */
  accessUntilLocal: number | null
  /** Local-clock ms when offline grace ends, when reason is offline-grace. */
  graceUntilLocal: number | null
}

export const DEFAULT_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000
export const DEFAULT_RECHECK_MS = 6 * 60 * 60 * 1000
/** Statuses that renew on their own; canceled / cancel-at-period-end get no offline extension. */
const RENEWING_STATUSES = new Set(['active', 'past_due', 'comp'])

export type AccessInput = {
  flagOn: boolean
  signedIn: boolean
  userId: string | null
  cache: CachedEntitlement | null
  nowLocal: number
  /** Highest local time this device has seen (persisted); defends against clock rollback. */
  lastSeenLocal: number
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function effectiveNow(input: Pick<AccessInput, 'cache' | 'nowLocal' | 'lastSeenLocal'>): number {
  return Math.max(input.nowLocal, input.cache?.checkedAt ?? 0, input.lastSeenLocal || 0)
}

export function decideAccess(input: AccessInput): AccessDecision {
  const base = { stale: false, accessUntilLocal: null, graceUntilLocal: null }
  if (!input.flagOn) return { ...base, allowed: true, reason: 'flag-off' }

  const cache = input.cache && (!input.userId || !input.cache.userId || input.cache.userId === input.userId)
    ? input.cache
    : null
  if (cache && !cache.snapshot.enabled) return { ...base, allowed: true, reason: 'billing-off' }
  if (!input.signedIn) return { ...base, allowed: false, reason: 'no-account' }
  // Signed in but never heard back from the server: fail open until the first answer.
  if (!cache) return { ...base, allowed: true, reason: 'unknown', stale: true }

  const snap = cache.snapshot
  const now = effectiveNow({ cache, nowLocal: input.nowLocal, lastSeenLocal: input.lastSeenLocal })
  const recheck = Math.max(60_000, num(snap.recheckAfterMs, DEFAULT_RECHECK_MS))
  const stale = now - cache.checkedAt >= recheck
  const accessUntilLocal = snap.accessUntil == null ? null : snap.accessUntil - cache.skewMs

  if (snap.entitled && (accessUntilLocal == null || now < accessUntilLocal)) {
    return { ...base, allowed: true, reason: 'entitled', stale, accessUntilLocal }
  }
  if (snap.entitled && accessUntilLocal != null && !snap.cancelAtPeriodEnd && RENEWING_STATUSES.has(String(snap.status))) {
    const grace = Math.max(0, num(snap.offlineGraceMs, DEFAULT_OFFLINE_GRACE_MS))
    const graceUntilLocal = accessUntilLocal + grace
    if (now < graceUntilLocal) {
      return { allowed: true, reason: 'offline-grace', stale: true, accessUntilLocal, graceUntilLocal }
    }
  }
  return { ...base, allowed: false, reason: 'not-entitled', stale, accessUntilLocal }
}

/** Parse a GET /v1/entitlement body defensively (unknown fields ignored). */
export function parseSnapshot(raw: unknown, fallbackNow: number): EntitlementSnapshot {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const optNum = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  return {
    enabled: r.enabled !== false,
    provider: typeof r.provider === 'string' ? r.provider : null,
    entitled: r.entitled === true,
    status: typeof r.status === 'string' ? r.status : 'none',
    plan: typeof r.plan === 'string' ? r.plan : null,
    trialEndsAt: optNum(r.trialEndsAt),
    currentPeriodEnd: optNum(r.currentPeriodEnd),
    cancelAtPeriodEnd: r.cancelAtPeriodEnd === true,
    accessUntil: optNum(r.accessUntil),
    canManage: r.canManage === true,
    now: num(r.now, fallbackNow),
    recheckAfterMs: num(r.recheckAfterMs, DEFAULT_RECHECK_MS),
    offlineGraceMs: num(r.offlineGraceMs, DEFAULT_OFFLINE_GRACE_MS),
  }
}

/** Snapshot used when the server answers 404 (billing not enabled). */
export function billingOffSnapshot(now: number): EntitlementSnapshot {
  return {
    enabled: false,
    provider: null,
    entitled: true,
    status: 'none',
    plan: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    accessUntil: null,
    canManage: false,
    now,
    recheckAfterMs: DEFAULT_RECHECK_MS,
    offlineGraceMs: DEFAULT_OFFLINE_GRACE_MS,
  }
}
