/**
 * Bilibili.tv (intl) — title-search OGV → episode list → playurl DASH (Jiyu's player via
 * biliDashHls) / embed.
 * Premium without a signed-in account, region blocks and streams with no usable URL →
 * official play page in Web Browser.
 */

import { nativeFetchJson } from './nativeHttp'
import { biliLog } from './biliLog'
import type { BiliDashSource, BiliDashTrack } from './bilibiliCn'
import { biliTvSessionJson, getBiliTvSessionStatus } from './biliSession'
import { scoreDonghuaCandidate } from './donghuaTitles'

export const BILIBILI_TV_ORIGIN = 'https://www.bilibili.tv'
export const BILIBILI_TV_API = 'https://api.bilibili.tv'
export const BILIBILI_TV_PLAY_REFERER = 'https://www.bilibili.tv/'

const LOCALE = 'en_US'
const PLATFORM = 'web'

export type BilibiliPlayResult =
  | {
      ok: true
      mode: 'hls' | 'dash' | 'embed'
      url: string
      referer: string
      seasonId: string
      episodeId: string
      title?: string
      premium?: boolean
      provider: string
      /** mode 'dash': the DASH pair for biliDashHls (url = play page, the embed fallback). */
      dash?: BiliDashSource
      /** mode 'dash': e.g. "480P" — the picked quality. */
      qualityLabel?: string
    }
  | { ok: false; error: string }

export type BilibiliResolveOptions = {
  title: string
  /** Alternate names (TMDB original_name, aliases). */
  altTitles?: string[]
  season?: number
  episode: number
  /** Playlist length hint for matching the right OGV. */
  episodeCountHint?: number
  /** Cached season id from a prior successful resolve. */
  seasonId?: string
  /** TMDB first-air year (strict matching). */
  year?: number
}

type SearchOgvItem = {
  title?: string
  season_id?: string
  season_type?: string
  season_type_enum?: number
  description?: string
  index_show?: string
  pay_policy_enum?: number
  label?: number
  corner_mark?: { text?: string } | null
  styles?: Array<{ title?: string }>
}

type EpisodeRow = {
  episode_id?: string
  short_title_display?: string
  title_display?: string
  /** 0 = free, 2 = Premium-only episode. */
  limit?: number
  corner_mark?: { text?: string; image?: string } | null
}

function apiUrl(path: string, params: Record<string, string | number>): string {
  const qs = new URLSearchParams({
    s_locale: LOCALE,
    platform: PLATFORM,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  })
  return `${BILIBILI_TV_API}${path}?${qs.toString()}`
}

/**
 * `session`: playurl / subtitle calls — go through the signed-in account when there is one
 * (cookie added natively; see biliSession.ts), else anonymous.
 */
async function biliJson<T>(url: string, opts: { session?: boolean } = {}): Promise<T | null> {
  if (opts.session) {
    const viaSession = await biliTvSessionJson<T>(url, {
      Accept: 'application/json',
      Referer: BILIBILI_TV_PLAY_REFERER,
      Origin: BILIBILI_TV_ORIGIN,
    })
    if (viaSession != null) return viaSession
  }
  const r = await nativeFetchJson<T>(url, {
    referer: BILIBILI_TV_PLAY_REFERER,
    headers: {
      Accept: 'application/json',
      Origin: BILIBILI_TV_ORIGIN,
    },
  })
  if (!r.ok || r.data == null) return null
  return r.data
}

function isFreeHit(item: SearchOgvItem): boolean {
  const mark = String(item.corner_mark?.text || '').toLowerCase()
  return mark === 'free' || mark.includes('free')
}

function isPremiumHit(item: SearchOgvItem): boolean {
  const mark = String(item.corner_mark?.text || '').toLowerCase()
  if (mark.includes('premium') || mark.includes('vip')) return true
  // pay_policy_enum 3 observed for Free OGV; other policies → treat as Premium UI.
  if (isFreeHit(item)) return false
  if (item.pay_policy_enum != null && item.pay_policy_enum !== 3) return true
  return false
}

export function bilibiliPlayPageUrl(seasonId: string, episodeId?: string): string {
  const sid = String(seasonId || '').trim()
  const eid = String(episodeId || '').trim()
  if (!sid) return `${BILIBILI_TV_ORIGIN}/en/anime`
  if (eid) return `${BILIBILI_TV_ORIGIN}/en/play/${sid}/${eid}`
  return `${BILIBILI_TV_ORIGIN}/en/play/${sid}`
}

export async function searchBilibiliOgv(keyword: string): Promise<SearchOgvItem[]> {
  const q = String(keyword || '').trim()
  if (!q) return []
  const data = await biliJson<{
    code?: number
    data?: { modules?: Array<{ type?: string; items?: SearchOgvItem[] }> }
  }>(apiUrl('/intl/gateway/web/v2/search_v2', { keyword: q, pn: 1, ps: 20 }))
  if (!data || data.code !== 0) return []
  const modules = data.data?.modules || []
  const ogv: SearchOgvItem[] = []
  for (const mod of modules) {
    if (String(mod.type || '').toLowerCase() !== 'ogv') continue
    for (const item of mod.items || []) {
      if (item?.season_id) ogv.push(item)
    }
  }
  return ogv
}

export async function fetchBilibiliEpisodes(seasonId: string): Promise<EpisodeRow[]> {
  const sid = String(seasonId || '').trim()
  if (!sid) return []
  const data = await biliJson<{
    code?: number
    data?: { sections?: Array<{ episodes?: EpisodeRow[] }> }
  }>(apiUrl('/intl/gateway/web/v2/ogv/play/episodes', { season_id: sid }))
  if (!data || data.code !== 0) return []
  const out: EpisodeRow[] = []
  for (const section of data.data?.sections || []) {
    for (const ep of section.episodes || []) {
      if (ep?.episode_id) out.push(ep)
    }
  }
  return out
}

function episodeOrdinal(row: EpisodeRow, index: number): number {
  const short = String(row.short_title_display || '')
  const m = /^E(\d{1,4})$/i.exec(short.trim())
  if (m) return Number(m[1])
  const title = String(row.title_display || '')
  const m2 = /\bE(?:P(?:isode)?)?\s*(\d{1,4})\b/i.exec(title)
  if (m2) return Number(m2[1])
  return index + 1
}

type TvSegmentBase = { range?: string; index_range?: string } | null | undefined

type TvVideoRow = {
  video_resource?: {
    quality?: number
    bandwidth?: number
    codec_id?: number
    codecs?: string
    url?: string
    backup_url?: string[] | null
    segment_base?: TvSegmentBase
    width?: number
    height?: number
    mime_type?: string
  } | null
  stream_info?: { quality?: number; desc_words?: string } | null
}

type TvAudioRow = {
  quality?: number
  bandwidth?: number
  codecs?: string
  url?: string
  backup_url?: string[] | null
  segment_base?: TvSegmentBase
}

export type TvDashResult =
  | {
      ok: true
      source: BiliDashSource
      qualityLabel: string
      /** Qualities with a stream URL for this request (e.g. ["480P","360P",…]). */
      available: string[]
      /** Listed but locked (empty URL — sign-in / Premium). */
      locked: string[]
      signedIn: boolean
    }
  | { ok: false; error: string; code?: number; locked?: string[]; signedIn: boolean }

function parseTvRange(s: string | undefined): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim())
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  return b >= a ? [a, b] : null
}

function httpsUrl(u: unknown): string {
  return String(u || '').trim().replace(/^\/\//, 'https://').replace(/^http:/, 'https:')
}

function canPlayType(mime: string, codecs: string): boolean {
  try {
    const MS = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
    if (!MS?.isTypeSupported) return /^avc1|^mp4a/i.test(codecs)
    return MS.isTypeSupported(`${mime || 'video/mp4'}; codecs="${codecs}"`)
  } catch {
    return false
  }
}

function qualityLabel(row: TvVideoRow): string {
  return String(row.stream_info?.desc_words || (row.video_resource?.height ? `${row.video_resource.height}P` : row.video_resource?.quality || '?'))
}

/**
 * bilibili.tv `playurl` → a DASH pair for biliDashHls. Video: the tallest AVC rendition with a
 * URL (HEVC only when MSE says it can play it); audio: the highest-bandwidth AAC track.
 * Anonymous requests get URLs up to 480P; 720P+ need a signed-in account (1080P+/4K often
 * Premium).
 */
export async function fetchTvDash(episodeId: string): Promise<TvDashResult> {
  const eid = String(episodeId || '').trim()
  const signedIn = (await getBiliTvSessionStatus().catch(() => null))?.signedIn === true
  if (!eid) return { ok: false, error: 'No episode id', signedIn }
  const data = await biliJson<{
    code?: number
    message?: string
    data?: {
      playurl?: {
        quality?: number
        duration?: number
        video?: TvVideoRow[] | null
        audio_resource?: TvAudioRow[] | null
      } | null
    }
  }>(
    apiUrl('/intl/gateway/web/playurl', {
      ep_id: eid,
      tk: '',
      qn: 112,
      type: 0,
      device: 'wap',
      tf: 0,
    }),
    { session: true },
  )
  if (!data) return { ok: false, error: 'playurl request failed', signedIn }
  if (data.code !== 0) {
    return { ok: false, error: `playurl code ${data.code}${data.message ? ` (${data.message})` : ''}`, code: data.code, signedIn }
  }
  const pu = data.data?.playurl
  const rows = pu?.video || []
  const seen = new Set<string>()
  const available: string[] = []
  const locked: string[] = []
  for (const r of rows) {
    const label = qualityLabel(r)
    const has = Boolean(httpsUrl(r.video_resource?.url) || r.video_resource?.backup_url?.length)
    const key = `${label}|${has}`
    if (seen.has(key)) continue
    seen.add(key)
    ;(has ? available : locked).push(label)
  }
  const lockedOnly = locked.filter((l) => !available.includes(l))

  const toVideo = (r: TvVideoRow): BiliDashTrack | null => {
    const v = r.video_resource
    if (!v) return null
    const urls = [httpsUrl(v.url), ...(v.backup_url || []).map(httpsUrl)].filter(Boolean)
    const init = parseTvRange(v.segment_base?.range)
    const index = parseTvRange(v.segment_base?.index_range)
    if (urls.length === 0 || !init || !index) return null
    return {
      url: urls[0],
      backups: urls.slice(1),
      codecs: String(v.codecs || ''),
      bandwidth: Number(v.bandwidth) || 0,
      width: Number(v.width) || undefined,
      height: Number(v.height) || undefined,
      init,
      index,
    }
  }
  const isAvc = (r: TvVideoRow) => r.video_resource?.codec_id === 7 || /^avc1/i.test(String(r.video_resource?.codecs || ''))
  const playable = rows
    .map((r) => ({ r, t: toVideo(r) }))
    .filter((x): x is { r: TvVideoRow; t: BiliDashTrack } => Boolean(x.t))
    .filter((x) => isAvc(x.r) || canPlayType(String(x.r.video_resource?.mime_type || 'video/mp4'), x.t.codecs))
    .sort((a, b) => {
      const dh = (b.t.height || 0) - (a.t.height || 0)
      if (dh) return dh
      // Same height: AVC first (widest hardware support), then higher bandwidth.
      const da = Number(isAvc(b.r)) - Number(isAvc(a.r))
      return da || b.t.bandwidth - a.t.bandwidth
    })
  const pick = playable[0]

  const audio = (pu?.audio_resource || [])
    .map((a): BiliDashTrack | null => {
      const urls = [httpsUrl(a.url), ...(a.backup_url || []).map(httpsUrl)].filter(Boolean)
      const init = parseTvRange(a.segment_base?.range)
      const index = parseTvRange(a.segment_base?.index_range)
      if (urls.length === 0 || !init || !index) return null
      return { url: urls[0], backups: urls.slice(1), codecs: String(a.codecs || 'mp4a.40.2'), bandwidth: Number(a.bandwidth) || 0, init, index }
    })
    .filter((a): a is BiliDashTrack => Boolean(a))
    .sort((a, b) => b.bandwidth - a.bandwidth)[0]

  biliLog('tv.playurl', {
    episodeId: eid, signedIn, available, locked: lockedOnly,
    pick: pick ? `${qualityLabel(pick.r)} ${pick.t.codecs}` : 'none', audio: audio ? `${audio.codecs} ${audio.bandwidth}` : 'none',
  })
  if (!pick) return { ok: false, error: rows.length ? 'No playable video stream (locked)' : 'No video streams', locked: lockedOnly, signedIn }
  if (!audio) return { ok: false, error: 'No audio stream', locked: lockedOnly, signedIn }
  return {
    ok: true,
    source: {
      video: pick.t,
      audio,
      durationSec: (Number(pu?.duration) || 0) / 1000,
      quality: Number(pick.r.video_resource?.quality || pu?.quality) || 0,
      referer: BILIBILI_TV_PLAY_REFERER,
    },
    qualityLabel: qualityLabel(pick.r),
    available,
    locked: lockedOnly,
    signedIn,
  }
}

async function scoreSearchHit(
  item: SearchOgvItem,
  titles: string[],
  episodeCountHint?: number,
  year?: number,
  season?: number,
): Promise<{ item: SearchOgvItem; score: number; epCount: number; strong: boolean; reason: string }> {
  let epCount = 0
  if (item.season_id) {
    try {
      epCount = (await fetchBilibiliEpisodes(item.season_id)).length
    } catch {
      /* ignore ep count fetch */
    }
  }
  const m = scoreDonghuaCandidate(
    { titles, year, episodeCount: episodeCountHint, season },
    { title: String(item.title || ''), episodeCount: epCount || undefined },
  )
  let score = m.score
  if (isFreeHit(item)) score += 8
  if (isPremiumHit(item)) score -= 5
  if (/anime/i.test(String(item.season_type || '')) || item.season_type_enum === 4) score += 6
  // bilibili.tv hits carry no year: a good title + matching episode count is enough.
  const strong = m.strong || (!m.yearBad && m.titleSim >= 0.75 && m.epMatch)
  return { item, score, epCount, strong, reason: strong ? 'strong' : m.reason }
}

async function pickBestSeason(
  titles: string[],
  episodeCountHint?: number,
  year?: number,
  season?: number,
): Promise<SearchOgvItem | null> {
  const seen = new Set<string>()
  const candidates: SearchOgvItem[] = []
  for (const title of titles) {
    const hits = await searchBilibiliOgv(title)
    biliLog('tv.search', { keyword: title, hits: hits.length })
    for (const h of hits) {
      const sid = String(h.season_id || '')
      if (!sid || seen.has(sid)) continue
      seen.add(sid)
      candidates.push(h)
    }
    if (candidates.length >= 8) break
  }
  if (candidates.length === 0) return null
  // Score top few (episode fetch is the expensive part).
  const top = candidates.slice(0, 6)
  const scored = await Promise.all(top.map((c) => scoreSearchHit(c, titles, episodeCountHint, year, season)))
  for (const s of scored) {
    biliLog('tv.candidate', {
      seasonId: s.item.season_id, title: s.item.title, eps: s.epCount, score: Math.round(s.score),
      strong: s.strong, reason: s.reason,
    })
  }
  const strong = scored.filter((s) => s.strong).sort((a, b) => b.score - a.score)
  return strong[0]?.item ?? null
}

/**
 * Resolve a Bilibili.tv play target for one episode.
 * Prefers free OGV; returns embed play-page URL when streams aren't usable natively.
 */
/** One subtitle track of a bilibili.tv episode (URLs carry a ~3-day auth_key). */
export type BilibiliTvSubtitleTrack = {
  /** lang_key as given: en, zh-Hans, zh-Hant, th, vi, id, ms, ar… */
  langKey: string
  label: string
  url: string
  format: 'json' | 'ass' | 'srt' | 'vtt'
}

function subtitleFormat(url: string): BilibiliTvSubtitleTrack['format'] {
  const path = String(url || '').split('?')[0].toLowerCase()
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'ass'
  if (path.endsWith('.srt')) return 'srt'
  if (path.endsWith('.vtt')) return 'vtt'
  return 'json'
}

/**
 * Episode subtitle tracks: `/intl/gateway/web/v2/subtitle`. `video_subtitle[]` has a plain
 * JSON track (`srt.url`, Bilibili `{body:[{from,to,content}]}` despite the name) and a styled
 * `ass.url`; `subtitles[]` is the older list (mostly .ass). Plain JSON first per language.
 */
export async function fetchBilibiliTvSubtitleTracks(episodeId: string): Promise<BilibiliTvSubtitleTrack[]> {
  const eid = String(episodeId || '').trim()
  if (!eid) return []
  type Ref = { url?: string } | null | undefined
  const data = await biliJson<{
    code?: number
    data?: {
      video_subtitle?: Array<{ lang?: string; lang_key?: string; srt?: Ref; ass?: Ref }> | null
      subtitles?: Array<{ lang?: string; lang_key?: string; url?: string }> | null
    }
  }>(apiUrl('/intl/gateway/web/v2/subtitle', { episode_id: eid }), { session: true })
  if (!data || data.code !== 0) {
    biliLog('tv.subs.fail', { episodeId: eid, code: data?.code })
    return []
  }
  const out: BilibiliTvSubtitleTrack[] = []
  const seen = new Set<string>()
  const push = (langKey: string | undefined, label: string | undefined, url: string | undefined) => {
    const u = String(url || '').trim().replace(/^\/\//, 'https://')
    const key = String(langKey || '').trim()
    if (!u || !key || !/^https?:\/\//i.test(u)) return
    const format = subtitleFormat(u)
    const sig = `${key}|${format}`
    if (seen.has(sig)) return
    seen.add(sig)
    out.push({ langKey: key, label: String(label || key), url: u, format })
  }
  for (const v of data.data?.video_subtitle || []) {
    push(v?.lang_key, v?.lang, v?.srt?.url)
    push(v?.lang_key, v?.lang, v?.ass?.url)
  }
  for (const v of data.data?.subtitles || []) push(v?.lang_key, v?.lang, v?.url)
  return out
}

export async function resolveBilibiliPlay(
  options: BilibiliResolveOptions,
): Promise<BilibiliPlayResult> {
  const titles = [
    String(options.title || '').trim(),
    ...(options.altTitles || []).map((t) => String(t || '').trim()),
  ].filter(Boolean)
  if (titles.length === 0) return { ok: false, error: 'No title for Bilibili lookup' }

  const episode = Math.max(1, Math.floor(options.episode || 1))
  let seasonId = String(options.seasonId || '').trim()
  let hit: SearchOgvItem | null = null

  if (!seasonId) {
    hit = await pickBestSeason(titles, options.episodeCountHint, options.year, options.season)
    seasonId = String(hit?.season_id || '').trim()
  }
  if (!seasonId) return { ok: false, error: 'No Bilibili match for this title' }

  const episodes = await fetchBilibiliEpisodes(seasonId)
  if (episodes.length === 0) {
    return {
      ok: true,
      mode: 'embed',
      url: bilibiliPlayPageUrl(seasonId),
      referer: BILIBILI_TV_PLAY_REFERER,
      seasonId,
      episodeId: '',
      title: hit?.title,
      premium: hit ? isPremiumHit(hit) : undefined,
      provider: 'bilibili.tv',
    }
  }

  const row =
    episodes.find((ep, i) => episodeOrdinal(ep, i) === episode) ||
    (episode <= episodes.length ? episodes[episode - 1] : undefined)
  // Never play a different episode (old fallback clamped to the last one).
  if (!row) return { ok: false, error: `Episode ${episode} not on bilibili.tv yet` }
  const episodeId = String(row?.episode_id || '').trim()
  if (!episodeId) {
    return {
      ok: true,
      mode: 'embed',
      url: bilibiliPlayPageUrl(seasonId),
      referer: BILIBILI_TV_PLAY_REFERER,
      seasonId,
      episodeId: '',
      title: hit?.title,
      provider: 'bilibili.tv',
    }
  }

  // Per-episode lock: `limit` 2 = Premium-only episode (anonymous playurl → code 10004004);
  // 0 = free even inside a "Premium" season (e.g. Link Click E1, E13+).
  const episodeLocked = Number(row?.limit) === 2
  const premium = episodeLocked || (hit ? isPremiumHit(hit) : false)
  const playPage = bilibiliPlayPageUrl(seasonId, episodeId)

  const embed: Extract<BilibiliPlayResult, { ok: true }> = {
    ok: true,
    mode: 'embed',
    url: playPage,
    referer: BILIBILI_TV_PLAY_REFERER,
    seasonId,
    episodeId,
    title: hit?.title,
    premium: premium || undefined,
    provider: 'bilibili.tv',
  }

  // DASH → Jiyu's player (biliDashHls). Premium-locked episodes only with a signed-in account
  // (the user's own Premium). Region block / locked / no stream → the official play page.
  const signedIn = (await getBiliTvSessionStatus().catch(() => null))?.signedIn === true
  if (episodeLocked && !signedIn) return embed
  const dash = await fetchTvDash(episodeId)
  if (!dash.ok) {
    biliLog('tv.dash.miss', { episodeId, error: dash.error, code: dash.code, locked: dash.locked, signedIn: dash.signedIn })
    return embed
  }
  return {
    ...embed,
    premium: episodeLocked || undefined,
    mode: 'dash',
    dash: dash.source,
    qualityLabel: dash.qualityLabel,
  }
}
