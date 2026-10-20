/**
 * Wyzie Subs — softsub lookup when a stream has no captions.
 *
 * Desktop: Electron IPC injects WYZIE_API_KEY in main (never in the bundle). Without a
 * local key (installed builds) main — or, on an older main, the renderer — uses the
 * jiyu-wyzie Worker instead.
 * Android / Tizen / web: call WYZIE_PROXY_URL (Cloudflare Worker) — Worker holds the key.
 * Never put WYZIE_API_KEY in Vite envPrefix / APK / wgt.
 */

import { subsLog } from './subsLog'

/** Public jiyu-wyzie Worker (no secrets; holds the Wyzie + OpenSubtitles keys server-side). */
export const DEFAULT_SUBTITLE_PROXY_URL = 'https://jiyu-wyzie.free-river.workers.dev'

export type WyzieSubtitleHit = {
  id?: string
  url?: string
  format?: string
  language?: string
  display?: string
  fileName?: string
  release?: string
  isHearingImpaired?: boolean
  downloadCount?: number
}

export type WyzieResolveResult =
  | {
      ok: true
      subtitleUrl: string
      subtitleKind: 'file'
      source: 'wyzie'
      via?: 'direct' | 'worker'
      hit?: WyzieSubtitleHit
    }
  | { ok: false; error: string; via?: 'direct' | 'worker' }

/**
 * Public proxy base URL only — no secrets. WYZIE_PROXY_URL in .env overrides; otherwise
 * the jiyu-wyzie Worker, so builds without the env value still get softsubs.
 */
export function getWyzieProxyUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>
  return String(env.WYZIE_PROXY_URL || env.VITE_WYZIE_PROXY_URL || DEFAULT_SUBTITLE_PROXY_URL)
    .trim()
    .replace(/\/+$/, '')
}

/** Desktop IPC (direct key or main-side Worker fallback) or the Worker itself. */
export function isWyzieAvailable(): boolean {
  if (typeof window !== 'undefined' && window.signalDesktop?.resolveWyzieSubtitle) return true
  return Boolean(getWyzieProxyUrl())
}

/** Electron main answered "no local key" (main before the Worker fallback, or IPC broke). */
export function isMissingKeyError(error: string | undefined): boolean {
  return /API_KEY missing|api key missing|no api key/i.test(String(error || ''))
}

function scoreHit(hit: WyzieSubtitleHit, season?: number, episode?: number): number {
  let score = 0
  const lang = `${hit.language || ''} ${hit.display || ''}`.toLowerCase()
  if (/^en\b|english/.test(lang)) score += 20
  if (hit.isHearingImpaired) score -= 8
  const fmt = String(hit.format || '').toLowerCase()
  if (fmt === 'vtt' || fmt === 'srt') score += 6
  if (fmt === 'ass' || fmt === 'ssa') score += 3
  score += Math.min(10, Math.floor((Number(hit.downloadCount) || 0) / 5000))
  if (season != null && episode != null && season >= 1 && episode >= 1) {
    const blob = `${hit.fileName || ''} ${hit.release || ''} ${hit.display || ''}`.toLowerCase()
    const tag = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    const tagLoose = `s${season}e${episode}`
    if (blob.includes(tag) || blob.includes(tagLoose)) score += 50
    else if (/s\d{1,2}e\d{1,3}/i.test(blob)) score -= 40
    // Absolute ep# packs (One Piece "1122", "E292") — match when SxxExx is absent.
    if (episode >= 50) {
      const ep = String(episode)
      const abs =
        new RegExp(`(?:^|[^0-9])0*${ep}(?:[^0-9]|$)`).test(blob) ||
        new RegExp(`\\be0*${ep}\\b`).test(blob)
      if (abs) score += 35
    }
  }
  return score
}

function withVttOutput(downloadUrl: string): string {
  try {
    const u = new URL(downloadUrl)
    u.searchParams.set('to', 'vtt')
    u.searchParams.set('plain', '1')
    return u.toString()
  } catch {
    const sep = downloadUrl.includes('?') ? '&' : '?'
    return `${downloadUrl}${sep}to=vtt&plain=1`
  }
}

/** Soft Worker gate — browsers may strip User-Agent; X-Jiyu-Client still gets through. */
function proxyClientHeaders(tag: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'} (${tag})`,
    'X-Jiyu-Client': `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'}`,
  }
}

/**
 * GET a jiyu-wyzie Worker URL. Desktop uses the renderer's own fetch (Worker sends CORS *
 * and accepts X-Jiyu-Client) — the fetchJsonGet IPC sends a plain Chrome UA without the
 * client header, which the Worker gate rejects with 403.
 */
export async function fetchSubtitleProxyText(
  url: string,
  tag: string,
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const headers = proxyClientHeaders(tag)
  const isDesktop = typeof window !== 'undefined' && Boolean(window.signalDesktop)

  if (isDesktop) {
    try {
      const res = await fetch(url, { headers })
      return { ok: res.ok, status: res.status, text: await res.text() }
    } catch (err) {
      return {
        ok: false,
        status: 0,
        text: '',
        error: err instanceof Error ? err.message : `${tag} proxy request failed`,
      }
    }
  }

  try {
    const { nativeFetchText } = await import('./nativeHttp')
    const r = await nativeFetchText(url, {
      headers: {
        ...headers,
        Referer: getWyzieProxyUrl() + '/',
      },
    })
    return { ok: r.ok, status: r.status, text: String(r.content || ''), error: r.error }
  } catch {
    /* fall through */
  }

  try {
    const res = await fetch(url, { headers })
    return { ok: res.ok, status: res.status, text: await res.text() }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: err instanceof Error ? err.message : `${tag} proxy request failed`,
    }
  }
}

async function resolveViaProxy(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<WyzieResolveResult> {
  const base = getWyzieProxyUrl()
  if (!base) return { ok: false, error: 'WYZIE_PROXY_URL missing' }

  const id = String(options.tmdbId || '').trim()
  if (!id) return { ok: false, error: 'No TMDB id for Wyzie' }

  const params = new URLSearchParams({
    id,
    language: options.language || 'en',
    format: 'srt,vtt,ass',
    limit: '12',
  })
  if (options.season != null && options.episode != null) {
    params.set('season', String(Math.max(1, options.season)))
    params.set('episode', String(Math.max(1, options.episode)))
  }

  const res = await fetchSubtitleProxyText(`${base}/search?${params.toString()}`, 'Wyzie')
  if (!res.ok) {
    let detail = res.error || `HTTP ${res.status}`
    try {
      const err = JSON.parse(res.text) as { message?: string; details?: string }
      detail = err.message || err.details || detail
    } catch {
      /* keep */
    }
    return { ok: false, error: detail, via: 'worker' }
  }

  let hits: WyzieSubtitleHit[] = []
  try {
    const parsed = JSON.parse(res.text) as unknown
    if (Array.isArray(parsed)) hits = parsed as WyzieSubtitleHit[]
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
      hits = (parsed as { data: WyzieSubtitleHit[] }).data
    }
  } catch {
    return { ok: false, error: 'Invalid Wyzie proxy response', via: 'worker' }
  }

  const ranked = hits
    .filter((h) => h && /^https?:\/\//i.test(String(h.url || '')))
    .sort(
      (a, b) =>
        scoreHit(b, options.season, options.episode) - scoreHit(a, options.season, options.episode),
    )
  const best = ranked[0]
  if (!best?.url) return { ok: false, error: 'No Wyzie subtitles for this episode', via: 'worker' }

  return {
    ok: true,
    subtitleUrl: withVttOutput(best.url),
    subtitleKind: 'file',
    source: 'wyzie',
    via: 'worker',
    hit: best,
  }
}

export type WyzieAnyLanguageResult =
  | { ok: true; hits: (WyzieSubtitleHit & { subtitleUrl: string })[]; via: 'worker' }
  | { ok: false; error: string; via: 'worker' }

/**
 * Every Wyzie track for the episode, any language (translation fallback). Always via the
 * Worker - same request on desktop dev, installed builds and Android; no local keys involved.
 */
export async function listWyzieHitsAnyLanguage(options: {
  tmdbId: string | number
  season?: number
  episode?: number
}): Promise<WyzieAnyLanguageResult> {
  const started = Date.now()
  const target = { tmdbId: options.tmdbId, season: options.season, episode: options.episode, language: 'any' }
  const base = getWyzieProxyUrl()
  const id = String(options.tmdbId || '').trim()
  if (!base || !id) {
    const error = !base ? 'WYZIE_PROXY_URL missing' : 'No TMDB id for Wyzie'
    subsLog('wyzie', { ...target, path: 'worker', via: 'worker', ok: false, error })
    return { ok: false, error, via: 'worker' }
  }
  const params = new URLSearchParams({ id, format: 'srt,vtt,ass' })
  if (options.season != null && options.episode != null) {
    params.set('season', String(Math.max(1, options.season)))
    params.set('episode', String(Math.max(1, options.episode)))
  }
  const res = await fetchSubtitleProxyText(`${base}/search?${params.toString()}`, 'Wyzie')
  let result: WyzieAnyLanguageResult
  if (!res.ok) {
    let detail = res.error || `HTTP ${res.status}`
    try {
      const err = JSON.parse(res.text) as { message?: string; details?: string }
      detail = err.message || err.details || detail
    } catch {
      /* keep */
    }
    result = { ok: false, error: detail, via: 'worker' }
  } else {
    let hits: WyzieSubtitleHit[] = []
    try {
      const parsed = JSON.parse(res.text) as unknown
      if (Array.isArray(parsed)) hits = parsed as WyzieSubtitleHit[]
      else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
        hits = (parsed as { data: WyzieSubtitleHit[] }).data
      }
    } catch {
      hits = []
    }
    const usable = hits
      .filter((h) => h && /^https?:\/\//i.test(String(h.url || '')))
      .map((h) => ({ ...h, subtitleUrl: withVttOutput(String(h.url)) }))
    result = usable.length
      ? { ok: true, hits: usable, via: 'worker' }
      : { ok: false, error: 'No subtitles found', via: 'worker' }
  }
  subsLog('wyzie', {
    ...target,
    path: 'worker',
    via: 'worker',
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    hits: result.ok ? result.hits.length : 0,
    languages: result.ok ? [...new Set(result.hits.map((h) => h.language || '?'))].join(',') : undefined,
    ms: Date.now() - started,
  })
  return result
}

export async function resolveWyzieSubtitle(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<WyzieResolveResult> {
  const started = Date.now()
  const target = { tmdbId: options.tmdbId, season: options.season, episode: options.episode, language: options.language }
  // Prefer Electron main: local .env key, or (current main) its own Worker fallback.
  if (window.signalDesktop?.resolveWyzieSubtitle) {
    let ipc: WyzieResolveResult
    try {
      ipc = await window.signalDesktop.resolveWyzieSubtitle(options)
    } catch (err) {
      ipc = { ok: false, error: err instanceof Error ? err.message : 'Wyzie IPC failed' }
    }
    const ipcFailedHard = !ipc.ok && (isMissingKeyError(ipc.error) || /IPC failed|No handler/i.test(ipc.error))
    if (ipc.ok || !ipcFailedHard || !getWyzieProxyUrl()) {
      subsLog('wyzie', {
        ...target,
        path: 'ipc',
        via: ipc.via,
        ok: ipc.ok,
        error: ipc.ok ? undefined : ipc.error,
        host: ipc.ok ? ipc.subtitleUrl : undefined,
        ms: Date.now() - started,
      })
      return ipc
    }
    // Main has no key (and no Worker fallback of its own): ask the Worker from here.
    const viaWorker = await resolveViaProxy(options)
    subsLog('wyzie', {
      ...target,
      path: 'renderer-worker',
      via: 'worker',
      after: ipc.error,
      ok: viaWorker.ok,
      error: viaWorker.ok ? undefined : viaWorker.error,
      host: viaWorker.ok ? viaWorker.subtitleUrl : undefined,
      ms: Date.now() - started,
    })
    return viaWorker
  }

  if (getWyzieProxyUrl()) {
    const viaWorker = await resolveViaProxy(options)
    subsLog('wyzie', {
      ...target,
      path: 'worker',
      via: 'worker',
      ok: viaWorker.ok,
      error: viaWorker.ok ? undefined : viaWorker.error,
      host: viaWorker.ok ? viaWorker.subtitleUrl : undefined,
      ms: Date.now() - started,
    })
    return viaWorker
  }

  subsLog('wyzie', { ...target, ok: false, error: 'no IPC and no Worker URL' })
  return {
    ok: false,
    error: 'Wyzie unavailable — set WYZIE_PROXY_URL (Worker) or use desktop with WYZIE_API_KEY',
  }
}
