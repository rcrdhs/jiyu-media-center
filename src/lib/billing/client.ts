/**
 * Entitlement client: talks to the jiyu-sync billing routes with the existing sync token,
 * caches the last answer for offline use, and opens hosted checkout / portal pages in the
 * system browser. Nothing here runs unless isPaywallFeatureEnabled() (see flag.ts).
 */
import { getProgressSyncStatus, subscribeProgressSync } from '../progressSync'
import { isAllowedSyncUrl, progressSyncBaseUrl } from '../progressSync/config'
import { loadSyncToken } from '../progressSync/secretStore'
import { SyncHttpError } from '../progressSync/transport'
import {
  billingOffSnapshot,
  decideAccess,
  parseSnapshot,
  type AccessDecision,
  type CachedEntitlement,
} from './access'
import { isPaywallFeatureEnabled } from './flag'

export const BILLING_EVENT = 'jiyu-billing-changed'
const CACHE_KEY = 'jiyu.billing.entitlement.v1'
const LAST_SEEN_KEY = 'jiyu.billing.lastSeen.v1'

export type BillingPlan = { id: string; label: string; priceLabel: string | null }

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(BILLING_EVENT))
  } catch {
    /* ignore */
  }
}

export function readEntitlementCache(): CachedEntitlement | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedEntitlement
    if (!parsed?.snapshot || !Number.isFinite(parsed.checkedAt)) return null
    return parsed
  } catch {
    return null
  }
}

function writeEntitlementCache(value: CachedEntitlement | null) {
  try {
    if (value) localStorage.setItem(CACHE_KEY, JSON.stringify(value))
    else localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
  emit()
}

/** Highest local clock seen; only ever moves forward. */
function touchLastSeen(now: number): number {
  let seen = 0
  try {
    seen = Number(localStorage.getItem(LAST_SEEN_KEY)) || 0
    if (now > seen) localStorage.setItem(LAST_SEEN_KEY, String(now))
  } catch {
    /* ignore */
  }
  return Math.max(seen, now)
}

export function getAccessDecision(): AccessDecision {
  const status = getProgressSyncStatus()
  const now = Date.now()
  const lastSeen = touchLastSeen(now)
  return decideAccess({
    flagOn: isPaywallFeatureEnabled(),
    signedIn: status.configured && status.signedIn,
    userId: status.userId,
    cache: readEntitlementCache(),
    nowLocal: now,
    lastSeenLocal: lastSeen,
  })
}

async function billingRequest<T>(method: string, path: string, withToken: boolean): Promise<T> {
  const base = progressSyncBaseUrl()
  if (!base) throw new SyncHttpError('Sync server is not configured', 0)
  if (!isAllowedSyncUrl(base)) throw new SyncHttpError('Sync server must use https://', 0)
  const token = withToken ? await loadSyncToken() : null
  if (withToken && !token) throw new SyncHttpError('Not signed in', 401)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'POST' ? '{}' : undefined,
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch (err) {
    throw new Error(`Sync server unreachable (${err instanceof Error ? err.message : 'network'})`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new SyncHttpError(data?.error || `Request failed (${res.status})`, res.status)
  return data
}

let inflight: Promise<AccessDecision> | null = null

/**
 * Ask the server for this account's entitlement and cache it. Network errors keep the old
 * cache (offline grace applies); 404 means billing is off on this server (allowed).
 */
export function refreshEntitlement(): Promise<AccessDecision> {
  if (!isPaywallFeatureEnabled()) return Promise.resolve(getAccessDecision())
  if (inflight) return inflight
  inflight = (async () => {
    const status = getProgressSyncStatus()
    if (!status.configured || !status.signedIn) return getAccessDecision()
    const checkedAt = Date.now()
    try {
      const raw = await billingRequest<unknown>('GET', '/v1/entitlement', true)
      const snapshot = parseSnapshot(raw, checkedAt)
      writeEntitlementCache({ snapshot, checkedAt, skewMs: snapshot.now - checkedAt, userId: status.userId })
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 404) {
        writeEntitlementCache({ snapshot: billingOffSnapshot(checkedAt), checkedAt, skewMs: 0, userId: status.userId })
      } else if (err instanceof SyncHttpError && err.status === 401) {
        writeEntitlementCache(null)
      } else {
        throw err
      }
    }
    return getAccessDecision()
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export async function listBillingPlans(): Promise<BillingPlan[]> {
  const data = await billingRequest<{ plans?: BillingPlan[] }>('GET', '/v1/billing/plans', false)
  return Array.isArray(data.plans) ? data.plans : []
}

/** Open a URL in the system browser (never the in-app browser) for hosted payment pages. */
export function openExternalUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Refusing to open a non-http URL')
  if (window.signalDesktop?.openExternal) {
    void window.signalDesktop.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function postForUrl(path: string, body: unknown): Promise<string> {
  const base = progressSyncBaseUrl()
  const token = await loadSyncToken()
  if (!base || !isAllowedSyncUrl(base) || !token) throw new SyncHttpError('Sign in to sync first', 401)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch (err) {
    throw new Error(`Sync server unreachable (${err instanceof Error ? err.message : 'network'})`)
  }
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok || !data.url) throw new SyncHttpError(data.error || `Request failed (${res.status})`, res.status)
  return data.url
}

export async function startCheckout(plan: string): Promise<void> {
  openExternalUrl(await postForUrl('/v1/billing/checkout', { plan }))
}

export async function openBillingPortal(): Promise<void> {
  openExternalUrl(await postForUrl('/v1/billing/portal', {}))
}

export function subscribeBilling(onChange: () => void): () => void {
  const handler = () => onChange()
  window.addEventListener(BILLING_EVENT, handler)
  window.addEventListener('storage', handler)
  const offSync = subscribeProgressSync(handler)
  return () => {
    window.removeEventListener(BILLING_EVENT, handler)
    window.removeEventListener('storage', handler)
    offSync()
  }
}
