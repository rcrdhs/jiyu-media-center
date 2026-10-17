import { progressSyncBaseUrl } from './config'
import type { ProgressSyncRecord, ProgressSyncSession } from './types'

async function request<T>(
  method: string,
  path: string,
  options?: { token?: string; body?: unknown },
): Promise<T> {
  const base = progressSyncBaseUrl()
  if (!base) throw new Error('Progress sync is not configured')

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new Error(data?.error || `Sync request failed (${res.status})`)
  }
  return data
}

export async function syncRegister(label?: string): Promise<ProgressSyncSession> {
  const data = await request<ProgressSyncSession>('POST', '/v1/auth/register', {
    body: { label: label || 'Jiyu' },
  })
  return {
    token: data.token,
    userId: data.userId,
    pairCode: data.pairCode,
    label: data.label || label || 'Jiyu',
  }
}

export async function syncPair(code: string): Promise<ProgressSyncSession> {
  const data = await request<ProgressSyncSession>('POST', '/v1/auth/pair', {
    body: { code: code.trim().toUpperCase() },
  })
  return {
    token: data.token,
    userId: data.userId,
    pairCode: data.pairCode || code.trim().toUpperCase(),
    label: data.label || 'Linked device',
  }
}

export async function syncPull(token: string): Promise<ProgressSyncRecord[]> {
  const data = await request<{ entries: ProgressSyncRecord[] }>('GET', '/v1/progress', {
    token,
  })
  return Array.isArray(data.entries) ? data.entries : []
}

export async function syncPush(token: string, entries: ProgressSyncRecord[]): Promise<void> {
  if (entries.length === 0) return
  await request('PUT', '/v1/progress', {
    token,
    body: { entries },
  })
}

export async function syncDelete(token: string, id: string): Promise<void> {
  await request('DELETE', `/v1/progress/${encodeURIComponent(id)}`, { token })
}
