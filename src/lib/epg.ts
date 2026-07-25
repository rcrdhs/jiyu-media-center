import type { StreamItem } from '../types'
import { normalizeTitleKey } from './dedupe'

const EPG_URL_KEY = 'jiyu.epg.url'

/**
 * Default XMLTV packs that cover Jiyu’s IPTV shelves (US sports/news brands + JM locals)
 * plus Free TV (mjh) channels seeded in Library. Matched by tvg-id / title — not every
 * world feed will have listings.
 */
export const DEFAULT_EPG_URLS = [
  'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_JM1.xml.gz',
  'https://i.mjh.nz/all/epg.xml.gz',
] as const

/** @deprecated Prefer DEFAULT_EPG_URLS — kept for older call sites. */
export const DEFAULT_EPG_URL = DEFAULT_EPG_URLS[0]

/** Keep programmes around “now” so huge guides stay usable */
const PAST_MS = 6 * 3600_000
const FUTURE_MS = 48 * 3600_000
const PARSE_CHUNK = 400

/** Extra ids tried when matching local / common brands to epgshare-style channel ids. */
const EPG_ID_ALIASES: Record<string, string[]> = {
  'local-tvj': ['Television.Jamaica.jm', 'TVJ.jm', 'TVJ.jm@SD', 'TVJ.Sports.jm'],
  'local-cvm': ['CVM.Television.Limited.jm', 'CVM.jm'],
  'local-nationwide': ['Jamaican.News.Network.jm'],
  tvj: ['Television.Jamaica.jm', 'TVJ.Sports.jm'],
  cvm: ['CVM.Television.Limited.jm'],
  nationwide: ['Jamaican.News.Network.jm'],
}

export interface EpgChannel {
  id: string
  name: string
}

export interface EpgProgramme {
  channelId: string
  title: string
  description?: string
  start: number
  stop: number
}

export interface EpgData {
  channels: EpgChannel[]
  programmes: EpgProgramme[]
  /** Indexed listings for fast now/next / day views */
  byChannel: Map<string, EpgProgramme[]>
  channelById: Map<string, EpgChannel>
  channelByName: Map<string, string>
  fetchedAt: number
  sourceUrl: string
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function compactKey(key: string): string {
  return key.replace(/[^a-z0-9]+/g, '')
}

/** Drop regional / feed suffixes so "ESPN HD East" can match stream title "ESPN". */
function softTitleKeys(name: string): string[] {
  const base = normalizeTitleKey(name)
  if (!base) return []
  const keys = new Set<string>([base])
  const stripped = base
    .replace(
      /\b(east|west|pacific|atlantic|north|south|central|outer market|alternate|alt|feed|overflow|hd|sd|network|channel|television|tv|usa|us)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped) keys.add(stripped)
  const parts = stripped.split(' ').filter(Boolean)
  if (parts.length >= 2) keys.add(parts.slice(0, 2).join(' '))
  if (parts.length >= 1 && parts[0].length >= 4) keys.add(parts[0])
  return [...keys]
}

function buildIndexes(
  channels: EpgChannel[],
  programmes: EpgProgramme[],
  sourceUrl: string,
): EpgData {
  const byChannel = new Map<string, EpgProgramme[]>()
  for (const p of programmes) {
    const list = byChannel.get(p.channelId)
    if (list) list.push(p)
    else byChannel.set(p.channelId, [p])
  }
  for (const list of byChannel.values()) {
    list.sort((a, b) => a.start - b.start)
  }

  const channelById = new Map<string, EpgChannel>()
  const channelByName = new Map<string, string>()
  for (const ch of channels) {
    channelById.set(ch.id, ch)
    channelById.set(ch.id.toLowerCase(), ch)
    // IPTV-Org style: CNN.us@SD ↔ CNN.us
    const bare = ch.id.split('@')[0]
    if (bare && bare !== ch.id) {
      if (!channelById.has(bare)) channelById.set(bare, ch)
      if (!channelById.has(bare.toLowerCase())) channelById.set(bare.toLowerCase(), ch)
    }
    for (const key of softTitleKeys(ch.name)) {
      if (!channelByName.has(key)) channelByName.set(key, ch.id)
      const compact = compactKey(key)
      if (compact && !channelByName.has(compact)) channelByName.set(compact, ch.id)
    }
  }

  return {
    channels,
    programmes,
    byChannel,
    channelById,
    channelByName,
    fetchedAt: Date.now(),
    sourceUrl,
  }
}

/** Split a manual / default EPG field into one or more http(s) URLs. */
export function parseEpgUrlList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  const parts = raw
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter((p) => /^https?:\/\//i.test(p))
  return [...new Set(parts)]
}

export function mergeEpgData(parts: EpgData[]): EpgData | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  const channels: EpgChannel[] = []
  const programmes: EpgProgramme[] = []
  const seenChannel = new Set<string>()
  for (const part of parts) {
    for (const ch of part.channels) {
      if (seenChannel.has(ch.id)) continue
      seenChannel.add(ch.id)
      channels.push(ch)
    }
    programmes.push(...part.programmes)
  }
  return buildIndexes(
    channels,
    programmes,
    parts.map((p) => p.sourceUrl).join(', '),
  )
}

/** Pull url-tvg / x-tvg-url from #EXTM3U header line(s) */
export function extractEpgUrlsFromM3U(content: string): string[] {
  const urls: string[] = []
  const lines = content.split(/\r?\n/).slice(0, 40)
  for (const line of lines) {
    if (!line.startsWith('#EXTM3U') && !/url-tvg|x-tvg-url/i.test(line)) continue
    const attrs = [...line.matchAll(/(?:url-tvg|x-tvg-url)="([^"]+)"/gi)]
    for (const m of attrs) {
      for (const part of m[1].split(/[,;]/)) {
        const u = part.trim()
        if (/^https?:\/\//i.test(u)) urls.push(u)
      }
    }
    const bare = line.match(/(?:url-tvg|x-tvg-url)=([^\s,]+)/i)
    if (bare?.[1] && /^https?:\/\//i.test(bare[1])) urls.push(bare[1].trim())
  }
  return [...new Set(urls)]
}

export function getManualEpgUrl(): string {
  try {
    return localStorage.getItem(EPG_URL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setManualEpgUrl(url: string) {
  try {
    if (!url.trim()) localStorage.removeItem(EPG_URL_KEY)
    else localStorage.setItem(EPG_URL_KEY, url.trim())
  } catch {
    /* ignore */
  }
}

/** Parse XMLTV timestamp: 20240101120000 +0000 or 20240101120000 */
export function parseXmltvTime(raw: string): number {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/)
  if (!m) return Date.parse(raw) || 0
  const [, y, mo, d, h, mi, s, tz] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  if (!tz) return Date.parse(iso + 'Z') || 0
  const sign = tz.startsWith('-') ? -1 : 1
  const th = Number(tz.slice(1, 3))
  const tm = Number(tz.slice(3, 5))
  const offsetMs = sign * (th * 60 + tm) * 60_000
  return Date.parse(iso + 'Z') - offsetMs
}

function innerTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i'))
  return m?.[1]?.trim() ?? ''
}

/**
 * Non-blocking XMLTV parse. Yields to the UI thread and keeps only a
 * near-term programme window so huge guides (e.g. PlutoTV .gz) stay usable.
 */
export async function parseXmltvAsync(xml: string, sourceUrl: string): Promise<EpgData> {
  const trimmed = xml.trim()
  if (!trimmed.startsWith('<') && !trimmed.startsWith('\uFEFF<')) {
    throw new Error(
      /\.gz(\?|#|$)/i.test(sourceUrl)
        ? 'EPG looks compressed — restart Jiyu so gzip guides can decompress, then Refresh guide.'
        : 'EPG response is not XML (check the URL; .gz guides need decompression).',
    )
  }

  await yieldToMain()

  const channels: EpgChannel[] = []
  const channelRe = /<channel\s+([^>]*)>([\s\S]*?)<\/channel>/gi
  let cm: RegExpExecArray | null
  let n = 0
  while ((cm = channelRe.exec(trimmed)) !== null) {
    const id = /(?:^|\s)id="([^"]*)"/i.exec(cm[1])?.[1] || ''
    if (!id) continue
    const name = innerTag(cm[2], 'display-name') || id
    channels.push({ id, name })
    if (++n % PARSE_CHUNK === 0) await yieldToMain()
  }

  if (channels.length === 0 && !/<tv[\s>]/i.test(trimmed)) {
    throw new Error('Invalid XMLTV document')
  }

  await yieldToMain()

  const now = Date.now()
  const windowStart = now - PAST_MS
  const windowEnd = now + FUTURE_MS
  const programmes: EpgProgramme[] = []
  const programmeRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/gi
  let pm: RegExpExecArray | null
  n = 0
  while ((pm = programmeRe.exec(trimmed)) !== null) {
    const attrs = pm[1]
    const channelId = /(?:^|\s)channel="([^"]*)"/i.exec(attrs)?.[1] || ''
    const startRaw = /(?:^|\s)start="([^"]*)"/i.exec(attrs)?.[1] || ''
    const stopRaw = /(?:^|\s)stop="([^"]*)"/i.exec(attrs)?.[1] || ''
    if (!channelId || !startRaw) continue
    const start = parseXmltvTime(startRaw)
    if (!start) continue
    const stop = stopRaw ? parseXmltvTime(stopRaw) : start + 3600_000
    if (stop < windowStart || start > windowEnd) continue
    programmes.push({
      channelId,
      title: innerTag(pm[2], 'title') || 'Untitled',
      description: innerTag(pm[2], 'desc') || undefined,
      start,
      stop,
    })
    if (++n % PARSE_CHUNK === 0) await yieldToMain()
  }

  await yieldToMain()
  return buildIndexes(channels, programmes, sourceUrl)
}

async function decodeMaybeGzip(bytes: Uint8Array, url: string): Promise<string> {
  const magicGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  const looksGzip = /\.gz(\?|#|$)/i.test(url) || magicGzip

  if (!looksGzip) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This environment cannot decompress gzip EPG files')
  }

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

export async function fetchEpgXml(url: string): Promise<string> {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('EPG URL must start with http:// or https://')
  }

  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(trimmed)
    if (!result.ok) throw new Error(result.error || `EPG fetch failed (${result.status})`)
    if (!result.content || result.content.length < 20) {
      throw new Error('EPG response was empty')
    }
    if (!result.content.trim().startsWith('<') && !result.content.trim().startsWith('\uFEFF<')) {
      throw new Error(
        'EPG is not XML after download. Quit and relaunch Jiyu (gzip support is in the desktop process), then Refresh guide.',
      )
    }
    return result.content
  }

  const response = await fetch(trimmed, {
    redirect: 'follow',
    headers: {
      Accept: 'application/xml, text/xml, application/gzip, */*',
    },
  })
  if (!response.ok) throw new Error(`EPG fetch failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const xml = await decodeMaybeGzip(bytes, trimmed)
  if (!xml.trim()) throw new Error('EPG response was empty')
  return xml
}

function lookupChannelId(data: EpgData, id: string): string | null {
  const direct =
    data.channelById.get(id) ||
    data.channelById.get(id.toLowerCase()) ||
    data.channelById.get(id.split('@')[0]) ||
    data.channelById.get(id.split('@')[0].toLowerCase())
  return direct?.id ?? null
}

export function matchEpgChannelId(item: StreamItem, data: EpgData): string | null {
  const aliasKeys = [item.id, item.tvgId, normalizeTitleKey(item.title)].filter(
    Boolean,
  ) as string[]
  for (const key of aliasKeys) {
    for (const alias of EPG_ID_ALIASES[key] || EPG_ID_ALIASES[key.toLowerCase()] || []) {
      const hit = lookupChannelId(data, alias)
      if (hit) return hit
    }
  }

  if (item.tvgId) {
    const byId = lookupChannelId(data, item.tvgId)
    if (byId) return byId
  }

  for (const key of softTitleKeys(item.title)) {
    const byName = data.channelByName.get(key) || data.channelByName.get(compactKey(key))
    if (byName) return byName
  }
  return null
}

/** Fetch + parse one or more XMLTV URLs and merge into a single guide. */
export async function loadEpgFromUrls(urls: string[]): Promise<EpgData> {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))]
  if (unique.length === 0) throw new Error('No EPG URL provided')

  const parts: EpgData[] = []
  const errors: string[] = []
  for (const url of unique) {
    try {
      const xml = await fetchEpgXml(url)
      const parsed = await parseXmltvAsync(xml, url)
      if (parsed.channels.length === 0 && parsed.programmes.length === 0) {
        errors.push(`${url}: empty guide`)
        continue
      }
      parts.push(parsed)
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const merged = mergeEpgData(parts)
  if (!merged) {
    throw new Error(errors[0] || 'EPG loaded but contained no programmes')
  }
  return merged
}

export function nowNext(
  data: EpgData,
  channelId: string,
  at = Date.now(),
): { now?: EpgProgramme; next?: EpgProgramme } {
  const list = data.byChannel.get(channelId) ?? []
  const now = list.find((p) => p.start <= at && at < p.stop)
  const next = list.find((p) => p.start > at)
  return { now, next }
}

export function programmesForDay(
  data: EpgData,
  channelId: string,
  dayStart: number,
): EpgProgramme[] {
  const dayEnd = dayStart + 24 * 3600_000
  const list = data.byChannel.get(channelId) ?? []
  return list.filter((p) => p.stop > dayStart && p.start < dayEnd)
}

export function startOfLocalDay(ts = Date.now()): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function formatEpgTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
