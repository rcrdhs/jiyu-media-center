import { isAllowedSyncUrl, progressSyncBaseUrl } from './config'
import type { ProgressSyncDevice, ProgressSyncRecord } from './types'

/** HTTP failure with the status so callers can tell "signed out" (401) from "retry later". */
export class SyncHttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Network / 5xx / 429 failures are worth retrying; 4xx (except 429) are not. */
export function isRetryableSyncError(err: unknown): boolean {
  if (err instanceof SyncHttpError) return err.status === 429 || err.status >= 500
  return true
}

async function request<T>(
  method: string,
  path: string,
  options?: { token?: string | null; body?: unknown; keepalive?: boolean },
): Promise<T> {
  const base = progressSyncBaseUrl()
  if (!base) throw new SyncHttpError('Progress sync is not configured', 0)
  if (!isAllowedSyncUrl(base)) throw new SyncHttpError('Sync server must use https://', 0)

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      keepalive: Boolean(options?.keepalive),
    })
  } catch (err) {
    throw new Error(`Sync server unreachable (${err instanceof Error ? err.message : 'network'})`)
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new SyncHttpError(data?.error || `Sync request failed (${res.status})`, res.status)
  }
  return data
}

export type SyncAuthResponse = {
  token: string
  userId: string
  deviceId: string
  label: string
  pairCode?: string
  pairCodeExpiresAt?: number
}

export function syncRegister(label: string): Promise<SyncAuthResponse> {
  return request<SyncAuthResponse>('POST', '/v1/auth/register', { body: { label } })
}

export function syncPair(code: string, label: string): Promise<SyncAuthResponse> {
  return request<SyncAuthResponse>('POST', '/v1/auth/pair', {
    body: { code: code.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), label },
  })
}

export function syncNewPairCode(token: string): Promise<{ pairCode: string; pairCodeExpiresAt: number }> {
  return request('POST', '/v1/auth/pair-code', { token })
}

export function syncSignOut(token: string): Promise<{ ok: boolean }> {
  return request('POST', '/v1/auth/signout', { token })
}

export async function syncListDevices(token: string): Promise<ProgressSyncDevice[]> {
  const data = await request<{ devices: ProgressSyncDevice[] }>('GET', '/v1/devices', { token })
  return Array.isArray(data.devices) ? data.devices : []
}

export function syncRevokeDevice(token: string, deviceId: string): Promise<{ ok: boolean; self?: boolean }> {
  return request('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`, { token })
}

export type SyncPullResponse = { entries: ProgressSyncRecord[]; rev: number; now: number }

export async function syncPull(token: string, since: number): Promise<SyncPullResponse> {
  const data = await request<SyncPullResponse>('GET', `/v1/progress?since=${Math.max(0, since | 0)}`, {
    token,
  })
  return {
    entries: Array.isArray(data.entries) ? data.entries : [],
    rev: Number(data.rev) || 0,
    now: Number(data.now) || Date.now(),
  }
}

/** Row sent to PUT /v1/progress — `ageMs` replaces the device clock. */
export type SyncPushRow = Omit<ProgressSyncRecord, 'updatedAt' | 'rev'> & { ageMs: number }

export type SyncPushResult = {
  id: string
  accepted: boolean
  rev?: number
  updatedAt?: number
  deleted?: boolean
  /** Server's newer row when ours was rejected. */
  current?: ProgressSyncRecord
}

export type SyncPushResponse = { results: SyncPushResult[]; rev: number; now: number }

export async function syncPush(
  token: string,
  entries: SyncPushRow[],
  options?: { keepalive?: boolean },
): Promise<SyncPushResponse> {
  const data = await request<SyncPushResponse>('PUT', '/v1/progress', {
    token,
    body: { entries },
    keepalive: options?.keepalive,
  })
  return {
    results: Array.isArray(data.results) ? data.results : [],
    rev: Number(data.rev) || 0,
    now: Number(data.now) || Date.now(),
  }
}
