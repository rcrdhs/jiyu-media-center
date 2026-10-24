/**
 * HTTP for Bilibili mainland / iQIYI lookups. Bilibili rejects data-center IPs, so every
 * request runs from the app itself:
 *  - Desktop: Electron main (`signalDesktop.biliFetch`, custom headers incl. Cookie/Range).
 *    Until main is restarted with that IPC: JSON via `fetchJsonGet` (no Cookie), bytes via
 *    renderer fetch (main's webRequest hook adds Referer/CORS to *.m4s CDN requests).
 *  - Android: CapacitorHttp (OkHttp) with Referer / Cookie / Range / UA.
 *  - Plain browser / node probes: fetch.
 */

import { CapacitorHttp } from '@capacitor/core'
import { isNativeHttpPlatform } from './nativeHttp'

export const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export type BiliFetchOptions = {
  referer?: string
  cookie?: string
  /** e.g. `bytes=0-2047` */
  range?: string
  accept?: string
  timeoutMs?: number
}

export type BiliTextResult = { ok: boolean; status: number; text: string; error: string }
export type BiliBytesResult = { ok: boolean; status: number; bytes: Uint8Array | null; error: string }

function buildHeaders(o: BiliFetchOptions, binary: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BILI_UA,
    Accept: o.accept || (binary ? '*/*' : 'application/json, text/plain, */*'),
  }
  if (o.referer) {
    headers.Referer = o.referer
    try {
      headers.Origin = new URL(o.referer).origin
    } catch {
      /* referer only */
    }
  }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.range) headers.Range = o.range
  return headers
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function desktop() {
  return typeof window !== 'undefined' ? window.signalDesktop : undefined
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

export async function biliFetchText(url: string, o: BiliFetchOptions = {}): Promise<BiliTextResult> {
  const timeoutMs = o.timeoutMs ?? 15_000
  const headers = buildHeaders(o, false)
  try {
    const d = desktop()
    if (d?.biliFetch) {
      const r = await d.biliFetch({ url, headers, timeoutMs })
      return { ok: r.ok, status: r.status, text: r.content || '', error: r.error || '' }
    }
    if (d?.fetchJsonGet) {
      // Pre-restart desktop: no custom headers (Cookie) through this bridge.
      const r = await d.fetchJsonGet(url, o.referer)
      return { ok: r.ok, status: r.status ?? 0, text: r.content || '', error: r.error || '' }
    }
    if (isNativeHttpPlatform()) {
      const res = await CapacitorHttp.get({
        url,
        headers,
        responseType: 'text',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      const ok = res.status >= 200 && res.status < 300
      return { ok, status: res.status, text, error: ok ? '' : `HTTP ${res.status}` }
    }
    const res = await fetchWithTimeout(url, headers, timeoutMs)
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, error: res.ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function biliFetchJson<T>(
  url: string,
  o: BiliFetchOptions = {},
): Promise<{ ok: boolean; status: number; data: T | null; error: string }> {
  const r = await biliFetchText(url, o)
  if (!r.text) return { ok: false, status: r.status, data: null, error: r.error || 'Empty response' }
  try {
    return { ok: r.ok, status: r.status, data: JSON.parse(r.text) as T, error: r.error }
  } catch {
    return { ok: false, status: r.status, data: null, error: r.error || 'Invalid JSON' }
  }
}

/** Binary GET (init / sidx byte ranges from the Bilibili CDN). */
export async function biliFetchBytes(url: string, o: BiliFetchOptions = {}): Promise<BiliBytesResult> {
  const timeoutMs = o.timeoutMs ?? 15_000
  const headers = buildHeaders(o, true)
  try {
    const d = desktop()
    if (d?.biliFetch) {
      const r = await d.biliFetch({ url, headers, timeoutMs, binary: true })
      const bytes = r.base64 ? base64ToBytes(r.base64) : null
      return { ok: r.ok && !!bytes, status: r.status, bytes, error: r.error || '' }
    }
    if (!d && isNativeHttpPlatform()) {
      const res = await CapacitorHttp.get({
        url,
        headers,
        responseType: 'arraybuffer',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      const ok = res.status >= 200 && res.status < 300
      if (!ok) return { ok, status: res.status, bytes: null, error: `HTTP ${res.status}` }
      const bytes =
        typeof res.data === 'string'
          ? base64ToBytes(res.data)
          : new Uint8Array(res.data as ArrayBuffer)
      return { ok: true, status: res.status, bytes, error: '' }
    }
    // Renderer / browser: Referer is a forbidden header (silently dropped; node probes keep
    // it). Desktop main adds the armed playback Referer to *.m4s CDN requests, so arm it
    // first — needed before a dev restart picks up the bilibili.com CDN rule in main.cjs.
    if (o.referer && d?.setPlaybackHeaders) {
      try {
        await d.setPlaybackHeaders({ url, referrer: o.referer })
      } catch {
        /* ignore */
      }
    }
    const res = await fetchWithTimeout(
      url,
      { ...(o.range ? { Range: o.range } : {}), ...(o.referer ? { Referer: o.referer } : {}) },
      timeoutMs,
    )
    if (!res.ok) return { ok: false, status: res.status, bytes: null, error: `HTTP ${res.status}` }
    return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), error: '' }
  } catch (err) {
    return { ok: false, status: 0, bytes: null, error: err instanceof Error ? err.message : String(err) }
  }
}
