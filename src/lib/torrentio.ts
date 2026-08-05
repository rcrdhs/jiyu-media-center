/**
 * Torrentio Stremio addon client — TV trial.
 * With a Real-Debrid API key (Library settings), prefers cached HTTP streams;
 * otherwise returns magnets like before.
 */

import { getRealDebridToken, hasRealDebridToken } from './debridSettings'

/** Flip to false to disable Torrentio enrichment without deleting call sites. */
export const TORRENTIO_TV_TRIAL = true

const TORRENTIO_ORIGIN = 'https://torrentio.strem.fun'
/** Broader scrape set — season packs with peers beat single dead EZTV magnets. */
const TORRENTIO_PROVIDERS =
  'providers=eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,nyaasi,tokyotosho,bitsearch,limetorrents'
/** Prefer cached debrid links; skip “download to debrid” catalog noise. */
const TORRENTIO_DEBRID_OPTIONS = 'debridoptions=nodownloadlinks,nocatalog'
/** Try more candidates before giving up on an episode. */
const MAX_STREAMS = 14

export interface TorrentioMagnet {
  title: string
  uri: string
  seeders: number
  sizeBytes: number
  quality: number
  sourceLabel: string
  fileIndex?: number
  fileName?: string
  /** HTTP stream from debrid (vs magnet P2P). */
  kind?: 'http' | 'magnet'
  /** Real-Debrid cache hit ([RD+]). */
  cached?: boolean
}

interface TorrentioStream {
  name?: string
  title?: string
  infoHash?: string
  url?: string
  fileIdx?: number
  behaviorHints?: { filename?: string; bingeGroup?: string }
}

interface TorrentioResponse {
  streams?: TorrentioStream[]
}

async function fetchJson(url: string): Promise<{ ok: boolean; content: string; error: string }> {
  if (window.signalDesktop?.fetchHtml) {
    const result = await window.signalDesktop.fetchHtml(url)
    return { ok: result.ok, content: result.content, error: result.error || '' }
  }
  try {
    const res = await fetch(url)
    const content = await res.text()
    return { ok: res.ok, content, error: res.ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, content: '', error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

function extractInfoHash(stream: TorrentioStream): string | null {
  const direct = (stream.infoHash || '').trim().toLowerCase()
  if (/^[a-f0-9]{40}$/.test(direct) || /^[a-f0-9]{32}$/.test(direct)) return direct
  const fromUrl = /(?:^|\/)([a-f0-9]{40})(?:\/|$)/i.exec(stream.url || '')
  return fromUrl ? fromUrl[1].toLowerCase() : null
}

function streamTitle(stream: TorrentioStream): string {
  const fromHint = stream.behaviorHints?.filename?.trim()
  if (fromHint) return fromHint
  const body = (stream.title || '').replace(/\r/g, '')
  const first = body
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (first) return first
  const nameLine = (stream.name || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return nameLine || 'Torrentio release'
}

function parseSeeders(text: string): number {
  const m = /👤\s*(\d+)/u.exec(text)
  return m ? Number(m[1]) || 0 : 0
}

function parseSizeBytes(text: string): number {
  const m = /💾\s*(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|KB|KiB)/iu.exec(text)
  if (!m) return 0
  const value = Number(m[1])
  if (!Number.isFinite(value)) return 0
  const unit = m[2].toUpperCase()
  if (unit.startsWith('G')) return Math.round(value * 1024 * 1024 * 1024)
  if (unit.startsWith('M')) return Math.round(value * 1024 * 1024)
  if (unit.startsWith('K')) return Math.round(value * 1024)
  return 0
}

function parseQualityHint(title: string): number {
  const m = /\b(2160|1080|720|480)p\b/i.exec(title)
  if (m) return Number(m[1])
  if (/\b4k\b|\buhd\b/i.test(title)) return 2160
  return 0
}

/** Embed file hints so Electron can open the right episode inside a season pack. */
function magnetForHash(
  hash: string,
  title: string,
  hints?: { fileIndex?: number; fileName?: string },
): string {
  let uri = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`
  if (typeof hints?.fileIndex === 'number' && Number.isFinite(hints.fileIndex) && hints.fileIndex >= 0) {
    uri += `&_jiyuFileIdx=${Math.floor(hints.fileIndex)}`
  }
  if (hints?.fileName) {
    uri += `&_jiyuFileName=${encodeURIComponent(hints.fileName)}`
  }
  return uri
}

function providerLabel(stream: TorrentioStream): string {
  const m = /⚙️\s*([^\n]+)/u.exec(stream.title || '')
  const provider = m?.[1]?.trim()
  return provider ? `Torrentio/${provider}` : 'Torrentio'
}

function hevcScore(title: string) {
  return /\b(x265|h\.?265|hevc)\b/i.test(title) ? 1 : 0
}

function foreignAudioScore(title: string) {
  if (/\b(truefrench|vff|vfq|vostfr|french|fran[cç]ais|\bvf\b)/i.test(title)) return 4
  if (/\b(german|deutsch|italian|latino|castellano|hindi|russian|dutch|\bnl\b)/i.test(title))
    return 3
  if (/\b(multi|dual[\s._-]?audio|dublado|dubbed)\b/i.test(title)) return 2
  if (/\b(english|\beng\b)\b/i.test(title)) return 0
  return 1
}

function isCachedDebridLabel(stream: TorrentioStream): boolean {
  const blob = `${stream.name || ''}\n${stream.title || ''}`
  return /\[(?:RD|AD|PM|DL|ED|OC|TB)\+\]/i.test(blob)
}

/** True when a play candidate is a debrid/direct HTTP URL (not magnet / .torrent). */
export function isDebridHttpPlayUrl(uri: string): boolean {
  if (!uri || /^magnet:/i.test(uri)) return false
  try {
    const u = new URL(uri)
    if (!/^https?:$/i.test(u.protocol)) return false
    if (/\.torrent$/i.test(u.pathname)) return false
    if (/^127\.0\.0\.1$/i.test(u.hostname) || /^localhost$/i.test(u.hostname)) return false
    return true
  } catch {
    return false
  }
}

function torrentioConfigPath(): string {
  const parts = [TORRENTIO_PROVIDERS]
  const token = getRealDebridToken()
  if (token) {
    parts.push(`realdebrid=${token}`)
    parts.push(TORRENTIO_DEBRID_OPTIONS)
  }
  return parts.join('|')
}

/**
 * Fetch Torrentio streams for one series episode (IMDb digits without tt).
 * When Real-Debrid is configured, HTTP/cached links are preferred.
 */
export async function fetchTorrentioEpisodeStreams(
  imdbDigits: string,
  season: number,
  episode: number,
): Promise<TorrentioMagnet[]> {
  if (!TORRENTIO_TV_TRIAL) return []
  const id = String(imdbDigits).replace(/^tt/i, '')
  if (!/^\d+$/.test(id) || season < 1 || episode < 0) return []

  const url =
    `${TORRENTIO_ORIGIN}/${torrentioConfigPath()}` +
    `/stream/series/tt${id}:${season}:${episode}.json`

  const fetched = await fetchJson(url)
  if (!fetched.ok || !fetched.content) return []

  let parsed: TorrentioResponse
  try {
    parsed = JSON.parse(fetched.content) as TorrentioResponse
  } catch {
    return []
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const byKey = new Map<string, TorrentioMagnet>()
  const debridOn = hasRealDebridToken()

  for (const stream of streams) {
    const title = streamTitle(stream)
    const blob = `${stream.title || ''}\n${stream.name || ''}`
    const fileName = stream.behaviorHints?.filename?.trim() || undefined
    const fileIndex =
      typeof stream.fileIdx === 'number' && Number.isFinite(stream.fileIdx)
        ? stream.fileIdx
        : undefined
    const cached = isCachedDebridLabel(stream)
    const httpUrl = typeof stream.url === 'string' ? stream.url.trim() : ''
    const useHttp = debridOn && isDebridHttpPlayUrl(httpUrl)

    let uri = ''
    let kind: 'http' | 'magnet' = 'magnet'
    let dedupeKey = ''

    if (useHttp) {
      uri = httpUrl
      kind = 'http'
      dedupeKey = `http:${httpUrl}`
    } else {
      const hash = extractInfoHash(stream)
      if (!hash) continue
      uri = magnetForHash(hash, title, { fileIndex, fileName })
      kind = 'magnet'
      dedupeKey = `magnet:${hash}`
    }

    const next: TorrentioMagnet = {
      title,
      uri,
      seeders: parseSeeders(blob),
      sizeBytes: parseSizeBytes(blob),
      quality: parseQualityHint(`${title}\n${blob}`),
      sourceLabel: providerLabel(stream),
      fileIndex,
      fileName,
      kind,
      cached,
    }
    const prev = byKey.get(dedupeKey)
    if (
      !prev ||
      Number(next.cached) > Number(prev.cached) ||
      (next.kind === 'http' && prev.kind !== 'http') ||
      next.seeders > prev.seeders ||
      (next.seeders === prev.seeders &&
        foreignAudioScore(next.title) < foreignAudioScore(prev.title))
    ) {
      byKey.set(dedupeKey, next)
    }
  }

  return [...byKey.values()]
    .sort(
      (a, b) =>
        // Cached debrid HTTP first — this is the stability win.
        Number(b.cached) - Number(a.cached) ||
        (a.kind === 'http' ? 0 : 1) - (b.kind === 'http' ? 0 : 1) ||
        b.seeders - a.seeders ||
        foreignAudioScore(a.title) - foreignAudioScore(b.title) ||
        hevcScore(a.title) - hevcScore(b.title) ||
        (a.quality > 1080 ? 1 : 0) - (b.quality > 1080 ? 1 : 0) ||
        b.quality - a.quality ||
        a.sizeBytes - b.sizeBytes,
    )
    .slice(0, MAX_STREAMS)
}
