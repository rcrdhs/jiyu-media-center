/**
 * RiveStream (rivestream.ru) — TMDB-backed TV play via scrapper API.
 * Try native HLS in Jiyu Player first (with English captions when available);
 * fall back to the Rive embed in Web Browser.
 */

import { cleanShowDisplayTitle } from './torrents'
import { probeStreamUrl } from './streamHealth'

/** Keep as literals — avoid circular imports with tmdbTv / zenox. */
const TMDB_ANIME_SOURCE_ID = 'builtin-tmdb-anime'
const ZENOX_SOURCE_ID = 'builtin-zenox-animation'

export const RIVESTREAM_EMBED_ORIGIN = 'https://rivestream.ru'
export const RIVESTREAM_SCRAPPER_ORIGIN = 'https://scrapper.rivestream.app'
export const RIVESTREAM_PLAY_REFERER = 'https://rivestream.ru/'

/** Same public TMDB key embedded in RiveStream's client bundle (metadata lookup only). */
const TMDB_API = 'https://api.themoviedb.org/3'
const TMDB_KEY = 'd64117f26031a428449f102ced3aba73'

const TV_PROVIDERS = [
  // Pulse usually answers quickly; apex often hangs on kids titles.
  'pulse',
  'flowcast',
  'citadel',
  'solstice',
  'primevids',
  'apex',
  'quasar',
  'horizon',
  'guru',
  // Hindi-first — only as last resort when English providers fail.
  'hindicast',
] as const

/** Prefer providers known to return English .vtt captions (anime softsubs). */
const TV_PROVIDERS_CAPTION_FIRST = [
  'citadel',
  'flowcast',
  'pulse',
  'solstice',
  'primevids',
  'apex',
  'quasar',
  'horizon',
  'guru',
  'hindicast',
] as const

const NON_ENGLISH_AUDIO_HINT =
  /hindi|\bhin\b|hindicast|arabic|spanish|español|french|german|portuguese|russian|turkish|indonesian|vietnamese|tamil|telugu|urdu|korean|\bko\b|chinese|mandarin|cantonese|\bzh\b/i

function scoreEnglishAudioHint(blob: string): number {
  const text = String(blob || '').toLowerCase()
  let score = 0
  if (/english|\beng\b|\ben-?us\b|\ben\b/.test(text)) score += 20
  if (NON_ENGLISH_AUDIO_HINT.test(text)) score -= 25
  if (/japanese|\bjp\b|\bja\b/.test(text)) score -= 15
  if (/hindicast/.test(text)) score -= 30
  return score
}

export interface RivestreamHlsSource {
  url: string
  provider: string
  quality?: string
  subtitleUrl?: string
}

export type RivestreamPlayResult =
  | {
      ok: true
      mode: 'hls'
      url: string
      referer: string
      provider: string
      tmdbId: string
      season: number
      episode: number
      subtitleUrl?: string
      subtitleKind?: 'file'
    }
  | {
      ok: true
      mode: 'embed'
      url: string
      tmdbId: string
      season: number
      episode: number
    }
  | { ok: false; error: string }

/**
 * Starred Rive embed aggregators (Server N labels).
 * Prefer path-based hosts — VAP shells "Cloud:" ads; PRIME often Play→/undefined/ white.
 */
export const RIVESTREAM_EMBED_SERVER_ORDER = [
  'VUP',
  'VIDZ',
  'CIN',
  'MAP',
  'SUP',
  'AGGREGATOR',
  'TORR',
  'VAP',
  'EASY',
  'PRIME',
  'SMASH',
  'VID',
  'ADF',
] as const

export function rivestreamTvEmbedUrl(
  tmdbId: string | number,
  season: number,
  episode: number,
): string {
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  // jiyuAuto=1 tells the BrowserView inject to prefer Embed + Best-Server and hop on fail.
  return (
    `${RIVESTREAM_EMBED_ORIGIN}/embed?type=tv&id=${encodeURIComponent(String(tmdbId))}` +
    `&season=${s}&episode=${e}#jiyuAuto=1`
  )
}

export function isRivestreamEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    return host === 'rivestream.ru' || host.endsWith('.rivestream.ru')
  } catch {
    return /rivestream\.ru/i.test(url)
  }
}

/** TMDB TV id from catalog fields (NetMirror stores this; YMovies may cache after lookup). */
export function rivestreamTmdbIdFromItem(item: {
  netmirrorTmdbId?: string
  rivestreamTmdbId?: string
  cinetaroTmdbId?: string
}): string {
  return String(item.rivestreamTmdbId || item.cinetaroTmdbId || item.netmirrorTmdbId || '').trim()
}

/** Prefer providers/streams that ship English softsubs (Zenox + anime). */
export function shouldPreferRivestreamCaptions(item: {
  category?: string
  torrentSourceId?: string
}): boolean {
  if (item.category === 'anime') return true
  if (item.torrentSourceId === TMDB_ANIME_SOURCE_ID) return true
  if (item.torrentSourceId === ZENOX_SOURCE_ID) return true
  return false
}

/** JP audio + English softsubs — anime only (not Western Zenox kids/cartoons). */
export function shouldPreferRivestreamJapaneseAudio(item: {
  category?: string
  torrentSourceId?: string
}): boolean {
  if (item.category === 'anime') return true
  if (item.torrentSourceId === TMDB_ANIME_SOURCE_ID) return true
  return false
}

async function fetchScrapperJson(
  provider: string,
  tmdbId: string,
  season: number,
  episode: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url =
    `${RIVESTREAM_SCRAPPER_ORIGIN}/api/provider?provider=${encodeURIComponent(provider)}` +
    `&id=${encodeURIComponent(tmdbId)}&season=${season}&episode=${episode}`

  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, RIVESTREAM_PLAY_REFERER)
    if (!result.ok) {
      return { ok: false, error: result.error || `HTTP ${result.status}` }
    }
    try {
      return { ok: true, data: JSON.parse(result.content || 'null') }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      }
    }
  }

  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { nativeFetchJson } = await import('./nativeHttp')
      const result = await nativeFetchJson<unknown>(url, {
        referer: RIVESTREAM_PLAY_REFERER,
        headers: {
          Accept: 'application/json',
          Origin: RIVESTREAM_EMBED_ORIGIN,
        },
      })
      if (!result.ok) return { ok: false, error: result.error || 'RiveStream scrapper request failed' }
      return { ok: true, data: result.data }
    }
  } catch {
    /* fall through */
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Origin: RIVESTREAM_EMBED_ORIGIN,
        Referer: RIVESTREAM_PLAY_REFERER,
      },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'RiveStream scrapper request failed',
    }
  }
}

function extractHlsSource(
  data: unknown,
  options?: { preferJapaneseAudio?: boolean },
): RivestreamHlsSource | null {
  if (!data || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  const nested = root.data
  const lists = [
    Array.isArray(root.sources) ? root.sources : null,
    nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).sources)
      ? ((nested as Record<string, unknown>).sources as unknown[])
      : null,
  ].filter(Boolean) as unknown[][]

  const candidates: RivestreamHlsSource[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const url = String(row.url || '').trim()
      const format = String(row.format || row.quality || '').toLowerCase()
      if (!url) continue
      if (format === 'hls' || /\.m3u8/i.test(url) || /m3u8-proxy|\.m3u8\?/i.test(url)) {
        candidates.push({
          url,
          provider: String(row.source || row.label || 'rive'),
          quality: String(row.quality || ''),
        })
      }
    }
  }
  if (candidates.length === 0) return null
  if (options?.preferJapaneseAudio) {
    const jp = candidates.find((c) => /japanese|\bjp\b|\bja\b/i.test(c.quality || ''))
    if (jp) return jp
  }
  // Prefer English audio; never fall through to Hindi/other dubs when English exists.
  if (!options?.preferJapaneseAudio) {
    const ranked = [...candidates].sort((a, b) => {
      const aBlob = `${a.provider} ${a.quality} ${a.url}`
      const bBlob = `${b.provider} ${b.quality} ${b.url}`
      return scoreEnglishAudioHint(bBlob) - scoreEnglishAudioHint(aBlob)
    })
    const best = ranked[0]
    if (best && scoreEnglishAudioHint(`${best.provider} ${best.quality} ${best.url}`) >= 0) {
      return best
    }
    const en = candidates.find((c) => /english|\beng\b/i.test(`${c.quality} ${c.provider}`))
    if (en) return en
    const nonForeign = candidates.find(
      (c) => !NON_ENGLISH_AUDIO_HINT.test(`${c.quality} ${c.provider} ${c.url}`),
    )
    if (nonForeign) return nonForeign
  }
  return candidates[0]
}

function captionRows(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') return []
  const root = data as Record<string, unknown>
  const nested = root.data
  const lists = [
    Array.isArray(root.captions) ? root.captions : null,
    nested &&
    typeof nested === 'object' &&
    Array.isArray((nested as Record<string, unknown>).captions)
      ? ((nested as Record<string, unknown>).captions as unknown[])
      : null,
  ].filter(Boolean) as unknown[][]
  const out: Array<Record<string, unknown>> = []
  for (const list of lists) {
    for (const entry of list) {
      if (entry && typeof entry === 'object') out.push(entry as Record<string, unknown>)
    }
  }
  return out
}

/** Prefer English softsub / CC tracks from scrapper captions[]. */
export function pickEnglishCaptionUrl(data: unknown): string | undefined {
  const rows = captionRows(data)
  if (rows.length === 0) return undefined
  const scored = rows
    .map((row) => {
      const file = String(row.file || row.url || row.src || '').trim()
      if (!file || !/^https?:\/\//i.test(file)) return null
      const label = `${row.label || ''} ${row.language || ''} ${row.lang || ''}`.toLowerCase()
      let score = 0
      if (/\benglish\b|\beng\b|\ben\b/.test(label)) score += 10
      if (/\bcc\b|soft/.test(label)) score += 2
      if (/\.vtt(\?|$)/i.test(file) || /\/english\.vtt/i.test(file) || /\/english$/i.test(file)) {
        score += 3
      }
      if (/\.srt(\?|$)/i.test(file)) score += 1
      if (
        /arabic|spanish|french|german|portuguese|russian|turkish|indonesian|vietnamese|hindi/i.test(
          label,
        )
      ) {
        score -= 5
      }
      return { file, score }
    })
    .filter((row): row is { file: string; score: number } => Boolean(row))
    .sort((a, b) => b.score - a.score)
  const best = scored.find((r) => r.score >= 10) || scored[0]
  return best?.file
}

type HlsCandidate = {
  url: string
  provider: string
  quality?: string
  subtitleUrl?: string
}

function firstPlaylistMediaLine(text: string): string | null {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !line.startsWith('#')) return line
  }
  return null
}

function absolutizePlaylistUrl(baseUrl: string, maybeRelative: string): string | null {
  if (!maybeRelative) return null
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative
  try {
    return new URL(maybeRelative, baseUrl).toString()
  } catch {
    return null
  }
}

/**
 * Master playlist probes often succeed while CDN segments 403 ("Upstream error").
 * Only treat HLS as natively playable when the first media segment responds.
 */
async function rivestreamHlsSegmentsPlayable(
  masterUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let masterText = ''
  try {
    const res = await fetch(masterUrl, {
      headers: {
        Accept: '*/*',
        Referer: RIVESTREAM_PLAY_REFERER,
        Origin: RIVESTREAM_EMBED_ORIGIN,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, error: `HLS master HTTP ${res.status}` }
    masterText = await res.text()
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'HLS master fetch failed',
    }
  }
  if (!/#EXTM3U|#EXT-X-/i.test(masterText)) {
    return { ok: false, error: 'Not a valid HLS playlist' }
  }

  let mediaUrl = absolutizePlaylistUrl(masterUrl, firstPlaylistMediaLine(masterText) || '')
  if (!mediaUrl) return { ok: false, error: 'HLS playlist has no media lines' }

  if (/#EXT-X-STREAM-INF/i.test(masterText)) {
    let variantText = ''
    try {
      const res = await fetch(mediaUrl, {
        headers: {
          Accept: '*/*',
          Referer: RIVESTREAM_PLAY_REFERER,
          Origin: RIVESTREAM_EMBED_ORIGIN,
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, error: `HLS variant HTTP ${res.status}` }
      variantText = await res.text()
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'HLS variant fetch failed',
      }
    }
    mediaUrl = absolutizePlaylistUrl(mediaUrl, firstPlaylistMediaLine(variantText) || '')
    if (!mediaUrl) return { ok: false, error: 'HLS variant has no segments' }
  }

  const segProbe = await probeStreamUrl(mediaUrl, 10_000)
  if (!segProbe.ok) {
    return {
      ok: false,
      error: segProbe.error || `HLS segment failed (${segProbe.status || 0})`,
    }
  }
  return { ok: true }
}

function extractMp4Source(data: unknown): RivestreamHlsSource | null {
  if (!data || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  const nested = root.data
  const lists = [
    Array.isArray(root.sources) ? root.sources : null,
    nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).sources)
      ? ((nested as Record<string, unknown>).sources as unknown[])
      : null,
  ].filter(Boolean) as unknown[][]

  let best: RivestreamHlsSource | null = null
  let bestScore = -1
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const url = String(row.url || '').trim()
      if (!url || !/^https?:\/\//i.test(url)) continue
      const format = String(row.format || row.quality || '').toLowerCase()
      const isMp4 =
        format === 'mp4' ||
        /\.mp4(\?|#|$)/i.test(url) ||
        (/\/proxy\?/i.test(url) && !/m3u8-proxy/i.test(url))
      if (!isMp4) continue
      const qualityNum = Number(row.quality)
      const score = Number.isFinite(qualityNum) ? qualityNum : /1080|720|480/.test(format) ? 500 : 100
      if (score > bestScore) {
        bestScore = score
        best = {
          url,
          provider: String(row.source || row.label || 'rive'),
          quality: String(row.quality || ''),
        }
      }
    }
  }
  return best
}

/** Resolve a direct HLS URL from RiveStream scrapper providers (TV only). */
export async function resolveRivestreamHls(
  tmdbId: string,
  season: number,
  episode: number,
  options?: { preferCaptions?: boolean; preferJapaneseAudio?: boolean },
): Promise<
  | ({
      ok: true
    } & RivestreamHlsSource & {
        tmdbId: string
        season: number
        episode: number
        subtitleUrl?: string
      })
  | { ok: false; error: string }
> {
  const id = String(tmdbId || '').trim()
  if (!id) return { ok: false, error: 'Missing TMDB id' }
  const s = Math.max(1, season)
  const e = Math.max(1, episode)
  const preferCaptions = Boolean(options?.preferCaptions)
  const wantJapaneseAudio = Boolean(options?.preferJapaneseAudio)
  const providers = preferCaptions ? TV_PROVIDERS_CAPTION_FIRST : TV_PROVIDERS

  let lastError = 'No HLS sources'
  const captioned: HlsCandidate[] = []
  const plain: HlsCandidate[] = []
  const mp4Candidates: HlsCandidate[] = []
  /** English softsubs from any provider — including mp4-only rows — so Apex HLS can borrow FlowCast/Citadel VTTs. */
  const captionPool: string[] = []

  for (const provider of providers) {
    const result = await fetchScrapperJson(provider, id, s, e)
    if (!result.ok) {
      lastError = result.error
      continue
    }
    const hls = extractHlsSource(result.data, { preferJapaneseAudio: wantJapaneseAudio })
    const subtitleUrl = pickEnglishCaptionUrl(result.data)
    if (subtitleUrl) captionPool.push(subtitleUrl)
    if (hls?.url) {
      const row: HlsCandidate = {
        url: hls.url,
        provider,
        quality: hls.quality,
        subtitleUrl,
      }
      if (subtitleUrl) captioned.push(row)
      else plain.push(row)

      // Softsub path: take the first captioned HLS that actually plays — don't wait
      // for every CDN (timeouts were dropping Citadel captions and falling to Apex).
      if (preferCaptions && subtitleUrl) {
        if (window.signalDesktop?.setPlaybackHeaders) {
          void window.signalDesktop.setPlaybackHeaders({
            url: row.url,
            referrer: RIVESTREAM_PLAY_REFERER,
          })
        }
        const probe = await probeStreamUrl(row.url, 4500)
        if (probe.ok) {
          const deep = await rivestreamHlsSegmentsPlayable(row.url)
          if (deep.ok) {
            return {
              ok: true,
              url: row.url,
              provider: row.provider,
              quality: row.quality,
              subtitleUrl: row.subtitleUrl || captionPool[0],
              tmdbId: id,
              season: s,
              episode: e,
            }
          }
          lastError = deep.error || 'HLS segments unavailable'
        } else {
          lastError = probe.error || 'Stream probe failed'
        }
      }
    }
    const mp4 = extractMp4Source(result.data)
    if (mp4?.url) {
      mp4Candidates.push({
        url: mp4.url,
        provider,
        quality: mp4.quality,
        subtitleUrl,
      })
    }
  }

  const borrowedCaption = captionPool[0]
  const byEnglishAudio = (a: HlsCandidate, b: HlsCandidate) =>
    scoreEnglishAudioHint(`${b.provider} ${b.quality} ${b.url}`) -
    scoreEnglishAudioHint(`${a.provider} ${a.quality} ${a.url}`)

  // Prefer captioned streams when requested — do not let English-audio sorting
  // bury Citadel (JP audio + EN .vtt) under Apex (no captions).
  let ordered: HlsCandidate[]
  if (preferCaptions) {
    const cap = wantJapaneseAudio ? captioned : [...captioned].sort(byEnglishAudio)
    const rest = wantJapaneseAudio ? plain : [...plain].sort(byEnglishAudio)
    ordered = [...cap, ...rest]
  } else if (wantJapaneseAudio) {
    ordered = [...plain, ...captioned]
  } else {
    ordered = [...plain, ...captioned].sort(byEnglishAudio)
  }
  for (const candidate of ordered) {
    if (window.signalDesktop?.setPlaybackHeaders) {
      void window.signalDesktop.setPlaybackHeaders({
        url: candidate.url,
        referrer: RIVESTREAM_PLAY_REFERER,
      })
    }
    const probe = await probeStreamUrl(candidate.url, 4500)
    if (!probe.ok) {
      lastError = probe.error || 'Stream probe failed'
      continue
    }
    const deep = await rivestreamHlsSegmentsPlayable(candidate.url)
    if (!deep.ok) {
      lastError = deep.error || 'HLS segments unavailable'
      continue
    }
    return {
      ok: true,
      url: candidate.url,
      provider: candidate.provider,
      quality: candidate.quality,
      // Keep softsubs even when the winning CDN row had no captions array.
      subtitleUrl: candidate.subtitleUrl || borrowedCaption,
      tmdbId: id,
      season: s,
      episode: e,
    }
  }

  // Progressive MP4 when HLS playlists exist but CDN segments are blocked.
  // Prefer rows that already ship English captions when softsubs matter.
  const mp4Ordered = preferCaptions
    ? [
        ...mp4Candidates.filter((c) => c.subtitleUrl),
        ...mp4Candidates.filter((c) => !c.subtitleUrl),
      ]
    : mp4Candidates
  for (const candidate of mp4Ordered) {
    if (window.signalDesktop?.setPlaybackHeaders) {
      void window.signalDesktop.setPlaybackHeaders({
        url: candidate.url,
        referrer: RIVESTREAM_PLAY_REFERER,
      })
    }
    const probe = await probeStreamUrl(candidate.url, 6000)
    if (!probe.ok) {
      lastError = probe.error || 'MP4 probe failed'
      continue
    }
    return {
      ok: true,
      url: candidate.url,
      provider: candidate.provider,
      quality: candidate.quality,
      subtitleUrl: candidate.subtitleUrl || borrowedCaption,
      tmdbId: id,
      season: s,
      episode: e,
    }
  }

  return { ok: false, error: lastError }
}

/** Best-effort TMDB TV id for YMovies rows (title search; cached on item after first hit). */
export async function lookupRivestreamTmdbId(title: string): Promise<string | null> {
  const query = cleanShowDisplayTitle(title) || title.trim()
  if (!query) return null
  const url =
    `${TMDB_API}/search/tv?api_key=${encodeURIComponent(TMDB_KEY)}` +
    `&language=en-US&query=${encodeURIComponent(query)}&page=1`

  let data: unknown
  if (window.signalDesktop?.fetchJsonGet) {
    const result = await window.signalDesktop.fetchJsonGet(url, RIVESTREAM_PLAY_REFERER)
    if (!result.ok) return null
    try {
      data = JSON.parse(result.content || 'null')
    } catch {
      return null
    }
  } else {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      data = await res.json()
    } catch {
      return null
    }
  }

  const results = (data as { results?: Array<{ id?: number; name?: string }> })?.results
  if (!Array.isArray(results) || results.length === 0) return null
  const top = results[0]
  if (!top?.id) return null
  return String(top.id)
}

/**
 * HLS in native player when probe succeeds (with softsubs when scrapper provides them);
 * otherwise Rive embed URL for Web Browser.
 */
export async function resolveRivestreamPlay(options: {
  tmdbId: string
  season: number
  episode: number
  /** Prefer providers that ship English .vtt/.srt captions (anime / Zenox). */
  preferCaptions?: boolean
  /** Prefer Japanese audio tracks (anime). Independent of captions. */
  preferJapaneseAudio?: boolean
}): Promise<RivestreamPlayResult> {
  const id = String(options.tmdbId || '').trim()
  const season = Math.max(1, options.season ?? 1)
  const episode = Math.max(1, options.episode ?? 1)
  if (!id) return { ok: false, error: 'Missing TMDB id' }

  const hls = await resolveRivestreamHls(id, season, episode, {
    preferCaptions: options.preferCaptions,
    preferJapaneseAudio: options.preferJapaneseAudio,
  })
  if (hls.ok) {
    return {
      ok: true,
      mode: 'hls',
      url: hls.url,
      referer: RIVESTREAM_PLAY_REFERER,
      provider: hls.provider,
      tmdbId: id,
      season,
      episode,
      subtitleUrl: hls.subtitleUrl,
      subtitleKind: hls.subtitleUrl ? 'file' : undefined,
    }
  }

  return {
    ok: true,
    mode: 'embed',
    url: rivestreamTvEmbedUrl(id, season, episode),
    tmdbId: id,
    season,
    episode,
  }
}
