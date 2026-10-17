/**
 * OpenSubtitles.com — secondary softsub lookup when Wyzie has nothing.
 *
 * Desktop: Electron IPC uses OPENSUBTITLES_API_KEY from main .env (never Vite).
 * Android / web: same WYZIE_PROXY_URL Worker with /opensubtitles (Worker holds the key).
 */

import { getWyzieProxyUrl } from './wyzie'

export type OpenSubtitlesResolveResult =
  | { ok: true; subtitleUrl: string; subtitleKind: 'file'; source: 'opensubtitles' }
  | { ok: false; error: string }

export function isOpenSubtitlesAvailable(): boolean {
  if (typeof window !== 'undefined' && window.signalDesktop?.resolveOpenSubtitlesSubtitle) {
    return true
  }
  return Boolean(getWyzieProxyUrl())
}

async function resolveViaProxy(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<OpenSubtitlesResolveResult> {
  const base = getWyzieProxyUrl()
  if (!base) return { ok: false, error: 'Subtitle proxy URL missing' }

  const id = String(options.tmdbId || '').trim()
  if (!id) return { ok: false, error: 'No TMDB id for OpenSubtitles' }

  const params = new URLSearchParams({
    id,
    language: options.language || 'en',
  })
  if (options.season != null && options.episode != null) {
    params.set('season', String(Math.max(1, options.season)))
    params.set('episode', String(Math.max(1, options.episode)))
  }

  const searchUrl = `${base}/opensubtitles?${params.toString()}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'} (OpenSubtitles)`,
    // Browsers may strip User-Agent; Worker also accepts this custom header.
    'X-Jiyu-Client': `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'}`,
  }

  let text = ''
  let ok = false
  let status = 0
  let error: string | undefined

  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    const r = await window.signalDesktop.fetchJsonGet(searchUrl, base + '/')
    ok = r.ok
    status = r.status
    text = String(r.content || '')
    error = r.error
  } else {
    try {
      const { nativeFetchText } = await import('./nativeHttp')
      const r = await nativeFetchText(searchUrl, {
        headers: { ...headers, Referer: base + '/' },
      })
      ok = r.ok
      status = r.status
      text = String(r.content || '')
      error = r.error
    } catch {
      try {
        const res = await fetch(searchUrl, { headers })
        ok = res.ok
        status = res.status
        text = await res.text()
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'OpenSubtitles proxy request failed',
        }
      }
    }
  }

  if (!ok) {
    let detail = error || `HTTP ${status}`
    try {
      const err = JSON.parse(text) as { message?: string; error?: string }
      detail = err.message || err.error || detail
    } catch {
      /* keep */
    }
    return { ok: false, error: detail }
  }

  try {
    const parsed = JSON.parse(text) as { ok?: boolean; subtitleUrl?: string; error?: string }
    const url = String(parsed.subtitleUrl || '').trim()
    if (!parsed.ok || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: parsed.error || 'No OpenSubtitles for this episode' }
    }
    return { ok: true, subtitleUrl: url, subtitleKind: 'file', source: 'opensubtitles' }
  } catch {
    return { ok: false, error: 'Invalid OpenSubtitles proxy response' }
  }
}

export async function resolveOpenSubtitlesSubtitle(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<OpenSubtitlesResolveResult> {
  if (window.signalDesktop?.resolveOpenSubtitlesSubtitle) {
    try {
      return await window.signalDesktop.resolveOpenSubtitlesSubtitle(options)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'OpenSubtitles IPC failed',
      }
    }
  }

  if (getWyzieProxyUrl()) {
    return resolveViaProxy(options)
  }

  return {
    ok: false,
    error: 'OpenSubtitles unavailable — set OPENSUBTITLES_API_KEY (desktop) or deploy Worker secret',
  }
}
