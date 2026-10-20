/**
 * OpenSubtitles.com — secondary softsub lookup when Wyzie has nothing.
 *
 * Desktop: Electron IPC uses OPENSUBTITLES_API_KEY from main .env (never Vite); without a
 * local key main — or, on an older main, the renderer — uses the jiyu-wyzie Worker.
 * Android / web: same WYZIE_PROXY_URL Worker with /opensubtitles (Worker holds the key).
 */

import { fetchSubtitleProxyText, getWyzieProxyUrl, isMissingKeyError } from './wyzie'
import { subsLog } from './subsLog'

export type OpenSubtitlesResolveResult =
  | {
      ok: true
      subtitleUrl: string
      subtitleKind: 'file'
      source: 'opensubtitles'
      via?: 'direct' | 'worker'
    }
  | { ok: false; error: string; via?: 'direct' | 'worker' }

/** Desktop IPC (direct key or main-side Worker fallback) or the Worker itself. */
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

  const r = await fetchSubtitleProxyText(`${base}/opensubtitles?${params.toString()}`, 'OpenSubtitles')
  const { ok, status, text, error } = r

  if (!ok) {
    let detail = error || `HTTP ${status}`
    try {
      const err = JSON.parse(text) as { message?: string; error?: string }
      detail = err.message || err.error || detail
    } catch {
      /* keep */
    }
    return { ok: false, error: detail, via: 'worker' }
  }

  try {
    const parsed = JSON.parse(text) as { ok?: boolean; subtitleUrl?: string; error?: string }
    const url = String(parsed.subtitleUrl || '').trim()
    if (!parsed.ok || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: parsed.error || 'No OpenSubtitles for this episode', via: 'worker' }
    }
    return { ok: true, subtitleUrl: url, subtitleKind: 'file', source: 'opensubtitles', via: 'worker' }
  } catch {
    return { ok: false, error: 'Invalid OpenSubtitles proxy response', via: 'worker' }
  }
}

export async function resolveOpenSubtitlesSubtitle(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<OpenSubtitlesResolveResult> {
  const started = Date.now()
  const target = { tmdbId: options.tmdbId, season: options.season, episode: options.episode, language: options.language }
  const log = (path: string, r: OpenSubtitlesResolveResult, extra?: Record<string, unknown>) =>
    subsLog('opensubtitles', {
      ...target,
      path,
      via: r.via,
      ...extra,
      ok: r.ok,
      error: r.ok ? undefined : r.error,
      host: r.ok ? r.subtitleUrl : undefined,
      ms: Date.now() - started,
    })

  if (window.signalDesktop?.resolveOpenSubtitlesSubtitle) {
    let ipc: OpenSubtitlesResolveResult
    try {
      ipc = await window.signalDesktop.resolveOpenSubtitlesSubtitle(options)
    } catch (err) {
      ipc = { ok: false, error: err instanceof Error ? err.message : 'OpenSubtitles IPC failed' }
    }
    const ipcFailedHard = !ipc.ok && (isMissingKeyError(ipc.error) || /IPC failed|No handler/i.test(ipc.error))
    if (ipc.ok || !ipcFailedHard || !getWyzieProxyUrl()) {
      log('ipc', ipc)
      return ipc
    }
    // Main has no key (and no Worker fallback of its own): ask the Worker from here.
    const viaWorker = await resolveViaProxy(options)
    log('renderer-worker', viaWorker, { after: ipc.error })
    return viaWorker
  }

  if (getWyzieProxyUrl()) {
    const viaWorker = await resolveViaProxy(options)
    log('worker', viaWorker)
    return viaWorker
  }

  const none: OpenSubtitlesResolveResult = {
    ok: false,
    error: 'OpenSubtitles unavailable — set OPENSUBTITLES_API_KEY (desktop) or deploy Worker secret',
  }
  log('none', none)
  return none
}
