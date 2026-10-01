/**
 * Cross-platform HTTP for catalog scrape / JSON APIs.
 * Desktop Electron → signalDesktop.fetchHtml / fetchJsonGet (CORS + CF helpers).
 * Android → CapacitorHttp (native, no WebView CORS), with WebView fallback for CF hosts.
 * Browser tab → plain fetch.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

export type NativeHttpResult = {
  ok: boolean
  content: string
  status: number
  error: string
}

export function isNativeHttpPlatform(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Hosts that CapacitorHttp/OkHttp routinely trip Cloudflare — prefer WebView. */
function prefersAndroidWebView(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return (
      host === 'cinetaro.to' ||
      host.endsWith('.cinetaro.to') ||
      host === 'cinextream.cc' ||
      host.endsWith('.ymovies.vip') ||
      host === 'ymovies.vip' ||
      host === 'freemovies.lol' ||
      host.endsWith('.freemovies.lol') ||
      host === 'eztv.re' ||
      host === 'eztvx.to' ||
      host.endsWith('.eztv.re')
    )
  } catch {
    return false
  }
}

function looksLikeCloudflareBlock(status: number, content: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 503) {
    return true
  }
  // 5xx host-down pages need a different message — not a solvable Verify challenge.
  if (status >= 520 && status < 530) return true
  const head = content.slice(0, 2500).toLowerCase()
  return (
    head.includes('just a moment') ||
    head.includes('cf-browser-verification') ||
    head.includes('attention required') ||
    head.includes('performing security verification') ||
    head.includes('security service to protect') ||
    (head.includes('cloudflare') && head.includes('error'))
  )
}

function looksLikeHostDown(status: number, content: string): boolean {
  if (status >= 520 && status < 530) return true
  const head = content.slice(0, 3500).toLowerCase()
  return (
    head.includes('error code 520') ||
    head.includes('error code 521') ||
    head.includes('error code 522') ||
    head.includes('web server is down') ||
    head.includes('host error') ||
    head.includes('origin is unreachable')
  )
}

function originReferer(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/`
  } catch {
    return undefined
  }
}

const androidUnlockedOrigins = new Set<string>()

async function fetchViaAndroidWebView(
  url: string,
  options?: { headers?: Record<string, string>; unlock?: boolean },
): Promise<NativeHttpResult | null> {
  try {
    const { androidBrowserFetchHtml, androidBrowserUnlockOrigin, isAndroidInAppBrowser } =
      await import('./androidBrowser')
    if (!isAndroidInAppBrowser()) return null
    if (options?.unlock) {
      const origin = new URL(url).origin
      if (!androidUnlockedOrigins.has(origin)) {
        // Don't steal the in-app browser while a sports/embed stream is open.
        try {
          const { androidBrowserGetState } = await import('./androidBrowser')
          const state = await androidBrowserGetState()
          const busyUrl = String(state?.url || '').trim()
          if (busyUrl && !/^about:blank$/i.test(busyUrl) && !busyUrl.startsWith(origin)) {
            return {
              ok: false,
              content: '',
              status: 503,
              error: 'Cloudflare Verify skipped — finish watching, then sync again',
            }
          }
        } catch {
          /* proceed — getState optional */
        }
        try {
          const { setTorrentSyncMessage } = await import('./torrentSyncStatus')
          setTorrentSyncMessage(`Cloudflare · complete Verify for ${new URL(url).hostname}…`, null)
        } catch {
          /* ignore */
        }
        const ok = await androidBrowserUnlockOrigin(origin)
        if (ok) {
          androidUnlockedOrigins.add(origin)
          try {
            const { setTorrentSyncMessage } = await import('./torrentSyncStatus')
            setTorrentSyncMessage('Cloudflare unlocked — continuing sync…', null)
          } catch {
            /* ignore */
          }
        } else {
          return {
            ok: false,
            content: '',
            status: 403,
            error: 'Cloudflare Verify cancelled or failed',
          }
        }
      }
    }
    const result = await androidBrowserFetchHtml(url, { headers: options?.headers })
    if (result.ok && result.content && !looksLikeCloudflareBlock(result.status, result.content)) {
      try {
        androidUnlockedOrigins.add(new URL(url).origin)
      } catch {
        /* ignore */
      }
    }
    return result
  } catch {
    return null
  }
}

export async function nativeFetchText(
  url: string,
  options?: {
    headers?: Record<string, string>
    quiet?: boolean
    /** Force WebView path (Android CF hosts). */
    preferWebView?: boolean
    /** Show a one-shot Verify overlay if the first WebView pass is challenged. */
    allowUnlock?: boolean
  },
): Promise<NativeHttpResult> {
  if (window.signalDesktop?.fetchHtml) {
    const headers = options?.headers || {}
    const referer =
      headers.Referer ||
      headers.referer ||
      (/(\.vtt|\.srt)(\?|$)|\/(?:english|en)(?:\.vtt)?(?:\?|$)/i.test(url)
        ? 'https://rivestream.ru/'
        : undefined)
    const result = await window.signalDesktop.fetchHtml(url, {
      quiet: Boolean(options?.quiet),
      referer,
    })
    return {
      ok: result.ok,
      content: result.content,
      status: result.ok ? 200 : result.status || 0,
      error: result.error || '',
    }
  }
  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(url)
    return {
      ok: result.ok,
      content: result.content,
      status: result.ok ? 200 : 0,
      error: result.error || '',
    }
  }

  if (isNativeHttpPlatform()) {
    const headers: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': DESKTOP_UA,
      ...(options?.headers || {}),
    }
    if (!headers.Referer) {
      const ref = originReferer(url)
      if (ref) headers.Referer = ref
    }

    const useWebViewFirst =
      options?.preferWebView === true || prefersAndroidWebView(url)

    if (useWebViewFirst) {
      let viaView = await fetchViaAndroidWebView(url, { headers })
      if (viaView?.ok && viaView.content && !looksLikeCloudflareBlock(viaView.status, viaView.content)) {
        return viaView
      }
      if (viaView && looksLikeHostDown(viaView.status, viaView.content)) {
        return {
          ok: false,
          content: viaView.content,
          status: viaView.status || 520,
          error: 'Host error — site origin is down behind Cloudflare. Try again later.',
        }
      }
      // Android: show in-app Verify for challenge pages (not host-down 5xx).
      if (options?.allowUnlock) {
        viaView = await fetchViaAndroidWebView(url, { headers, unlock: true })
        if (viaView?.ok && viaView.content && !looksLikeCloudflareBlock(viaView.status, viaView.content)) {
          return viaView
        }
        if (viaView && looksLikeHostDown(viaView.status, viaView.content || '')) {
          return {
            ok: false,
            content: viaView.content,
            status: viaView.status || 520,
            error: viaView.error || 'Host error — site origin is down. Try again later.',
          }
        }
      }
      // Fall through to CapacitorHttp — some hosts unblock OkHttp after WebView warm.
    }

    try {
      const res = await CapacitorHttp.get({
        url,
        headers,
        responseType: 'text',
        connectTimeout: 30_000,
        readTimeout: 45_000,
      })
      const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      const blocked = looksLikeCloudflareBlock(res.status, content)
      const ok = res.status >= 200 && res.status < 400 && !blocked
      if (!ok && blocked) {
        if (looksLikeHostDown(res.status, content)) {
          return {
            ok: false,
            content,
            status: res.status,
            error: 'Host error — site origin is down behind Cloudflare. Try again later.',
          }
        }
        let viaView = await fetchViaAndroidWebView(url, { headers })
        if (viaView?.ok && viaView.content && !looksLikeCloudflareBlock(viaView.status, viaView.content)) {
          return viaView
        }
        if (options?.allowUnlock) {
          viaView = await fetchViaAndroidWebView(url, { headers, unlock: true })
          if (viaView?.ok && viaView.content) return viaView
        }
      }
      return {
        ok,
        content,
        status: res.status,
        error: ok ? '' : `HTTP ${res.status}`,
      }
    } catch (err) {
      const viaView = await fetchViaAndroidWebView(url, {
        headers,
        unlock: Boolean(options?.allowUnlock),
      })
      if (viaView?.ok && viaView.content) return viaView
      return {
        ok: false,
        content: '',
        status: 0,
        error: err instanceof Error ? err.message : 'Native fetch failed',
      }
    }
  }

  try {
    const res = await fetch(url, { headers: options?.headers })
    const content = await res.text()
    return {
      ok: res.ok,
      content,
      status: res.status,
      error: res.ok ? '' : `HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      content: '',
      status: 0,
      error: err instanceof Error ? err.message : 'Fetch failed',
    }
  }
}

export async function nativeFetchJson<T = unknown>(
  url: string,
  options?: { headers?: Record<string, string>; referer?: string },
): Promise<{ ok: boolean; data: T | null; error: string }> {
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(
      url,
      options?.referer || undefined,
    )
    if (!result.ok) return { ok: false, data: null, error: result.error || 'JSON fetch failed' }
    try {
      return { ok: true, data: JSON.parse(result.content) as T, error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': DESKTOP_UA,
    ...(options?.headers || {}),
  }
  if (options?.referer) headers.Referer = options.referer

  if (isNativeHttpPlatform()) {
    try {
      // LiveXTV /replays is a multi-MB JSON payload — give OkHttp more time than catalog scrapes.
      const largeCatalog = /livextv-backend\.onrender\.com\/api\/replays/i.test(url)
      const res = await CapacitorHttp.get({
        url,
        headers,
        responseType: 'json',
        connectTimeout: largeCatalog ? 45_000 : 30_000,
        readTimeout: largeCatalog ? 120_000 : 45_000,
      })
      const ok = res.status >= 200 && res.status < 400
      if (!ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
      return { ok: true, data: res.data as T, error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Native JSON fetch failed',
      }
    }
  }

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
    const data = (await res.json()) as T
    return { ok: true, data, error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'JSON fetch failed',
    }
  }
}

export async function nativeFetchJsonPost<T = unknown>(
  url: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string>; referer?: string },
): Promise<{ ok: boolean; data: T | null; error: string }> {
  if (window.signalDesktop?.fetchJsonPost) {
    const result = await window.signalDesktop.fetchJsonPost(
      url,
      body,
      options?.referer || undefined,
    )
    if (!result.ok) return { ok: false, data: null, error: result.error || 'JSON POST failed' }
    try {
      return { ok: true, data: JSON.parse(result.content) as T, error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': DESKTOP_UA,
    ...(options?.headers || {}),
  }
  if (options?.referer) headers.Referer = options.referer

  if (isNativeHttpPlatform()) {
    try {
      const res = await CapacitorHttp.post({
        url,
        headers,
        data: body,
        connectTimeout: 30_000,
        readTimeout: 45_000,
      })
      const ok = res.status >= 200 && res.status < 400
      if (!ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
      return { ok: true, data: res.data as T, error: '' }
    } catch (err) {
      return {
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Native JSON POST failed',
      }
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as T, error: '' }
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'JSON POST failed',
    }
  }
}
