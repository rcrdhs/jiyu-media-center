/**
 * Bilibili.tv (intl) — title-search OGV → episode list → playurl / embed.
 * Used as a Movy-style fallback for anime/TV when Movy/Atlantic miss.
 * Premium / DASH-without-usable-URL → official play page in Web Browser.
 */

import { nativeFetchJson } from './nativeHttp'

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

async function biliJson<T>(url: string): Promise<T | null> {
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

function normalizeTitle(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  const aw = new Set(na.split(' ').filter((w) => w.length > 1))
  const bw = nb.split(' ').filter((w) => w.length > 1)
  if (aw.size === 0 || bw.length === 0) return 0
  let hit = 0
  for (const w of bw) if (aw.has(w)) hit += 1
  return hit / Math.max(aw.size, bw.length)
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

async function fetchPlayurl(episodeId: string): Promise<{
  hlsUrl?: string
  videoUrl?: string
  audioUrl?: string
}> {
  const eid = String(episodeId || '').trim()
  if (!eid) return {}
  const data = await biliJson<{
    code?: number
    data?: {
      playurl?: {
        video?: Array<{
          video_resource?: { url?: string; backup_url?: string[] | null }
          stream_info?: { desc_words?: string }
        }>
        audio_resource?: Array<{ url?: string; backup_url?: string[] | null }>
      }
    }
  }>(
    apiUrl('/intl/gateway/web/playurl', {
      ep_id: eid,
      tk: '',
      qn: 64,
      type: 0,
      device: 'wap',
      tf: 0,
    }),
  )
  if (!data || data.code !== 0) return {}
  const videos = data.data?.playurl?.video || []
  let videoUrl = ''
  let hlsUrl = ''
  for (const v of videos) {
    const u = String(v.video_resource?.url || v.video_resource?.backup_url?.[0] || '').trim()
    if (!u) continue
    if (/\.m3u8(\?|$)/i.test(u)) {
      hlsUrl = u
      break
    }
    if (!videoUrl) videoUrl = u
  }
  const audioUrl = String(
    data.data?.playurl?.audio_resource?.[0]?.url ||
      data.data?.playurl?.audio_resource?.[0]?.backup_url?.[0] ||
      '',
  ).trim()
  return { hlsUrl: hlsUrl || undefined, videoUrl: videoUrl || undefined, audioUrl: audioUrl || undefined }
}

async function scoreSearchHit(
  item: SearchOgvItem,
  titles: string[],
  episodeCountHint?: number,
): Promise<{ item: SearchOgvItem; score: number; epCount: number }> {
  let bestTitle = 0
  for (const t of titles) bestTitle = Math.max(bestTitle, titleSimilarity(t, String(item.title || '')))
  let epCount = 0
  let score = bestTitle * 100
  if (isFreeHit(item)) score += 8
  if (isPremiumHit(item)) score -= 5
  if (/anime/i.test(String(item.season_type || '')) || item.season_type_enum === 4) score += 6
  if (episodeCountHint && episodeCountHint > 0 && item.season_id) {
    try {
      const eps = await fetchBilibiliEpisodes(item.season_id)
      epCount = eps.length
      if (epCount > 0) {
        const ratio = Math.min(epCount, episodeCountHint) / Math.max(epCount, episodeCountHint)
        if (ratio >= 0.9) score += 25
        else if (ratio >= 0.7) score += 12
        else if (Math.abs(epCount - episodeCountHint) <= 3) score += 18
        else score -= 10
      }
    } catch {
      /* ignore ep count fetch */
    }
  }
  return { item, score, epCount }
}

async function pickBestSeason(
  titles: string[],
  episodeCountHint?: number,
): Promise<SearchOgvItem | null> {
  const seen = new Set<string>()
  const candidates: SearchOgvItem[] = []
  for (const title of titles) {
    const hits = await searchBilibiliOgv(title)
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
  const scored = await Promise.all(top.map((c) => scoreSearchHit(c, titles, episodeCountHint)))
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 35) return null
  return best.item
}

/**
 * Resolve a Bilibili.tv play target for one episode.
 * Prefers free OGV; returns embed play-page URL when streams aren't usable natively.
 */
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
    hit = await pickBestSeason(titles, options.episodeCountHint)
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

  let row =
    episodes.find((ep, i) => episodeOrdinal(ep, i) === episode) ||
    episodes[Math.min(episode - 1, episodes.length - 1)]
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

  const premium = hit ? isPremiumHit(hit) : false
  const playPage = bilibiliPlayPageUrl(seasonId, episodeId)

  // Premium (or empty native streams) → official page; no VIP bypass.
  if (premium) {
    return {
      ok: true,
      mode: 'embed',
      url: playPage,
      referer: BILIBILI_TV_PLAY_REFERER,
      seasonId,
      episodeId,
      title: hit?.title,
      premium: true,
      provider: 'bilibili.tv',
    }
  }

  const streams = await fetchPlayurl(episodeId)
  if (streams.hlsUrl) {
    return {
      ok: true,
      mode: 'hls',
      url: streams.hlsUrl,
      referer: BILIBILI_TV_PLAY_REFERER,
      seasonId,
      episodeId,
      title: hit?.title,
      provider: 'bilibili.tv',
    }
  }
  // Separate DASH A/V — web Player is hls.js-only and Media3 DASH isn't wired
  // for m4s pairs yet, so open the official play page (plan v1).
  return {
    ok: true,
    mode: 'embed',
    url: playPage,
    referer: BILIBILI_TV_PLAY_REFERER,
    seasonId,
    episodeId,
    title: hit?.title,
    provider: 'bilibili.tv',
  }
}
