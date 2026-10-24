/**
 * iQIYI donghua lookup (anonymous). Stream endpoints (cache.video.iqiyi.com/dash) need a
 * client signature and are DRM'd for many titles, so Jiyu does NOT pull streams: it finds
 * the album + episode and opens the official iQIYI International play page
 * (www.iq.com/play/<id>, English subtitles) in the in-app Web Browser embed.
 *
 *   suggest.video.iqiyi.com (Chinese title) → strict match → pcw-api avlistinfo
 *   (episode list: order, playUrl v_<id>.html, payMark) → https://www.iq.com/play/<id>
 */

import { biliFetchJson } from './biliHttp'
import { biliLog } from './biliLog'
import { scoreDonghuaCandidate, type DonghuaMatchQuery } from './donghuaTitles'

export const IQ_INTL_ORIGIN = 'https://www.iq.com'
const IQIYI_REFERER = 'https://www.iqiyi.com/'
const PAGE_SIZE = 50

type SuggestItem = {
  aid?: number | string
  name?: string
  year?: number | string
  region?: string
  cid?: number
  cname?: string
  link_address?: string
}

type AvEpisode = {
  order?: number
  name?: string
  tvId?: number
  playUrl?: string
  payMark?: number
  duration?: string
  contentType?: number
  subtitle?: string
}

export type IqiyiAlbum = { aid: string; name: string; year: number; score: number }

export type IqiyiEpisodeResult =
  | {
      ok: true
      aid: string
      albumName: string
      url: string
      /** Mainland play page (geo-restricted outside CN). */
      mainlandUrl: string
      title: string
      vip: boolean
      total: number
    }
  | { ok: false; error: string }

export async function searchIqiyiAlbum(q: DonghuaMatchQuery & { keywords: string[] }): Promise<IqiyiAlbum | null> {
  let best: IqiyiAlbum | null = null
  const seen = new Set<string>()
  for (const keyword of q.keywords) {
    const r = await biliFetchJson<{ code?: number | string; data?: SuggestItem[] }>(
      `https://suggest.video.iqiyi.com/?if=mobile&key=${encodeURIComponent(keyword)}`,
      { referer: IQIYI_REFERER },
    )
    const items = Array.isArray(r.data?.data) ? r.data!.data! : []
    biliLog('iq.search', { keyword, status: r.status, hits: items.length, error: r.error || undefined })
    for (const it of items) {
      const aid = String(it.aid ?? '').trim()
      if (!aid || aid === '0' || seen.has(aid)) continue
      seen.add(aid)
      const name = String(it.name || '')
      const year = Number(it.year) || 0
      const s = scoreDonghuaCandidate({ ...q, episodeCount: undefined }, { title: name, year })
      let score = s.score
      if (it.cid === 4 || /动漫/.test(String(it.cname || ''))) score += 8
      biliLog('iq.candidate', { aid, name, year, kind: it.cname, region: it.region, score: Math.round(score), strong: s.strong, reason: s.reason })
      if (!s.strong) continue
      if (!best || score > best.score) best = { aid, name, year, score }
    }
    if (best) return best
  }
  return best
}

function iqCodeFromPlayUrl(playUrl: string): string {
  const m = /\/v_([0-9a-z]+)\.html/i.exec(String(playUrl || ''))
  return m ? m[1] : ''
}

export function iqIntlPlayUrl(code: string): string {
  return `${IQ_INTL_ORIGIN}/play/${encodeURIComponent(code)}?lang=en_us`
}

export async function fetchIqiyiEpisode(album: IqiyiAlbum, episode: number): Promise<IqiyiEpisodeResult> {
  const page = Math.max(1, Math.ceil(episode / PAGE_SIZE))
  const r = await biliFetchJson<{ code?: string; data?: { total?: number; epsodelist?: AvEpisode[] } }>(
    `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${encodeURIComponent(album.aid)}&page=${page}&size=${PAGE_SIZE}`,
    { referer: IQIYI_REFERER },
  )
  const list = r.data?.code === 'A00000' ? r.data.data?.epsodelist || [] : []
  const total = Number(r.data?.data?.total) || 0
  const row =
    list.find((e) => Number(e.order) === episode && (e.contentType == null || e.contentType === 1)) ||
    list.find((e) => Number(e.order) === episode)
  biliLog('iq.episodes', {
    aid: album.aid, page, status: r.status, code: r.data?.code, total, listed: list.length,
    episode, found: !!row, payMark: row?.payMark,
  })
  if (!row) return { ok: false, error: `Episode ${episode} not on iQIYI` }
  const code = iqCodeFromPlayUrl(String(row.playUrl || ''))
  if (!code) return { ok: false, error: 'iQIYI episode link missing' }
  return {
    ok: true,
    aid: album.aid,
    albumName: album.name,
    url: iqIntlPlayUrl(code),
    mainlandUrl: String(row.playUrl || '').replace(/^http:/, 'https:'),
    title: String(row.subtitle || row.name || ''),
    vip: Number(row.payMark) > 0,
    total,
  }
}
