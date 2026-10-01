/**
 * Wyzie Subs — softsub lookup when a stream has no captions.
 *
 * Desktop: Electron IPC injects WYZIE_API_KEY in main (never in the bundle).
 * Android / Tizen / web: call WYZIE_PROXY_URL (Cloudflare Worker) — Worker holds the key.
 * Never put WYZIE_API_KEY in Vite envPrefix / APK / wgt.
 */

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
  | { ok: true; subtitleUrl: string; subtitleKind: 'file'; source: 'wyzie'; hit?: WyzieSubtitleHit }
  | { ok: false; error: string }

/** Public proxy base URL only — no secrets. Set WYZIE_PROXY_URL in .env for mobile/TV builds. */
export function getWyzieProxyUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>
  return String(env.WYZIE_PROXY_URL || env.VITE_WYZIE_PROXY_URL || '')
    .trim()
    .replace(/\/+$/, '')
}

export function isWyzieAvailable(): boolean {
  if (typeof window !== 'undefined' && window.signalDesktop?.resolveWyzieSubtitle) return true
  return Boolean(getWyzieProxyUrl())
}

function scoreHit(hit: WyzieSubtitleHit): number {
  let score = 0
  const lang = `${hit.language || ''} ${hit.display || ''}`.toLowerCase()
  if (/^en\b|english/.test(lang)) score += 20
  if (hit.isHearingImpaired) score -= 8
  const fmt = String(hit.format || '').toLowerCase()
  if (fmt === 'vtt' || fmt === 'srt') score += 6
  if (fmt === 'ass' || fmt === 'ssa') score += 3
  score += Math.min(10, Math.floor((Number(hit.downloadCount) || 0) / 5000))
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

async function fetchProxySearch(searchUrl: string): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Soft gate on the Worker — must contain "Jiyu" (or Electron for desktop fallback).
    'User-Agent': `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'} (Wyzie)`,
  }

  if (typeof window !== 'undefined' && window.signalDesktop?.fetchJsonGet) {
    const r = await window.signalDesktop.fetchJsonGet(searchUrl, getWyzieProxyUrl() + '/')
    return { ok: r.ok, status: r.status, text: String(r.content || ''), error: r.error }
  }

  try {
    const { nativeFetchText } = await import('./nativeHttp')
    const r = await nativeFetchText(searchUrl, {
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
    const res = await fetch(searchUrl, { headers })
    return { ok: res.ok, status: res.status, text: await res.text() }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: err instanceof Error ? err.message : 'Wyzie proxy request failed',
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

  const res = await fetchProxySearch(`${base}/search?${params.toString()}`)
  if (!res.ok) {
    let detail = res.error || `HTTP ${res.status}`
    try {
      const err = JSON.parse(res.text) as { message?: string; details?: string }
      detail = err.message || err.details || detail
    } catch {
      /* keep */
    }
    return { ok: false, error: detail }
  }

  let hits: WyzieSubtitleHit[] = []
  try {
    const parsed = JSON.parse(res.text) as unknown
    if (Array.isArray(parsed)) hits = parsed as WyzieSubtitleHit[]
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
      hits = (parsed as { data: WyzieSubtitleHit[] }).data
    }
  } catch {
    return { ok: false, error: 'Invalid Wyzie proxy response' }
  }

  const ranked = hits
    .filter((h) => h && /^https?:\/\//i.test(String(h.url || '')))
    .sort((a, b) => scoreHit(b) - scoreHit(a))
  const best = ranked[0]
  if (!best?.url) return { ok: false, error: 'No Wyzie subtitles for this episode' }

  return {
    ok: true,
    subtitleUrl: withVttOutput(best.url),
    subtitleKind: 'file',
    source: 'wyzie',
    hit: best,
  }
}

export async function resolveWyzieSubtitle(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
}): Promise<WyzieResolveResult> {
  // Prefer Electron main (local .env key) when available.
  if (window.signalDesktop?.resolveWyzieSubtitle) {
    try {
      return await window.signalDesktop.resolveWyzieSubtitle(options)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Wyzie IPC failed' }
    }
  }

  if (getWyzieProxyUrl()) {
    return resolveViaProxy(options)
  }

  return {
    ok: false,
    error: 'Wyzie unavailable — set WYZIE_PROXY_URL (Worker) or use desktop with WYZIE_API_KEY',
  }
}
