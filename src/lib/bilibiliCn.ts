/**
 * Bilibili mainland (bilibili.com) donghua lookup — anonymous, from the app itself.
 *
 *   buvid (x/frontend/finger/spi) → WBI-signed search (media_bangumi, then media_ft)
 *   → strict title / year / episode-count match → pgc season view → episode mapping
 *   (trailers 预告 / PV and members-only 会员 episodes skipped) → pgc playurl DASH.
 *
 * Fan-upload fallback: WBI video search "<zh> 第N集" / "EP N" → strict filter (exact
 * episode marker, no compilations / trailers / clips, ≥4 min, longest first)
 * → x/web-interface/view → x/player/wbi/playurl DASH.
 *
 * Streams are DASH (separate fMP4 video / audio with SegmentBase); see biliDashHls.ts.
 * CDN needs no cookie; Referer https://www.bilibili.com/ is sent anyway.
 */

import { md5Hex } from './md5'
import { biliFetchJson } from './biliHttp'
import { biliLog } from './biliLog'
import {
  normalizeTitleKey,
  scoreDonghuaCandidate,
  toSimplified,
  type DonghuaMatchQuery,
} from './donghuaTitles'

export const BILIBILI_CN_API = 'https://api.bilibili.com'
export const BILIBILI_CN_REFERER = 'https://www.bilibili.com/'

// ── session: buvid + WBI keys ────────────────────────────────────────────────

const BUVID_KEY = 'jiyu.biliCn.buvid.v1'
const WBI_TTL_MS = 6 * 60 * 60 * 1000
let buvidCookie = ''
let wbiMixin: { key: string; at: number } | null = null

async function getCookie(): Promise<string> {
  if (buvidCookie) return buvidCookie
  try {
    const raw = globalThis.localStorage?.getItem(BUVID_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { b3?: string; b4?: string; at?: number }
      if (p.b3 && p.at && Date.now() - p.at < 30 * 24 * 3600 * 1000) {
        buvidCookie = `buvid3=${p.b3}; buvid4=${encodeURIComponent(p.b4 || '')}`
        return buvidCookie
      }
    }
  } catch {
    /* ignore */
  }
  const r = await biliFetchJson<{ code?: number; data?: { b_3?: string; b_4?: string } }>(
    `${BILIBILI_CN_API}/x/frontend/finger/spi`,
    { referer: BILIBILI_CN_REFERER },
  )
  const b3 = String(r.data?.data?.b_3 || '')
  const b4 = String(r.data?.data?.b_4 || '')
  if (!b3) {
    biliLog('cn.buvid.fail', { status: r.status, error: r.error })
    return ''
  }
  buvidCookie = `buvid3=${b3}; buvid4=${encodeURIComponent(b4)}`
  try {
    globalThis.localStorage?.setItem(BUVID_KEY, JSON.stringify({ b3, b4, at: Date.now() }))
  } catch {
    /* ignore */
  }
  return buvidCookie
}

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function keyFromUrl(u: string): string {
  return String(u || '').split('/').pop()?.split('.')[0] || ''
}

async function getWbiMixin(): Promise<string> {
  if (wbiMixin && Date.now() - wbiMixin.at < WBI_TTL_MS) return wbiMixin.key
  const cookie = await getCookie()
  const r = await biliFetchJson<{
    code?: number
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }>(`${BILIBILI_CN_API}/x/web-interface/nav`, { referer: BILIBILI_CN_REFERER, cookie })
  const img = r.data?.data?.wbi_img
  const orig = keyFromUrl(img?.img_url || '') + keyFromUrl(img?.sub_url || '')
  if (orig.length < 64) {
    biliLog('cn.wbi.fail', { status: r.status, code: r.data?.code, error: r.error })
    return ''
  }
  const key = MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32)
  wbiMixin = { key, at: Date.now() }
  return key
}

/** WBI-signed query string (adds wts + w_rid). */
export function signWbiQuery(params: Record<string, string | number>, mixin: string, nowSec?: number): string {
  const p: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) p[k] = String(v)
  p.wts = String(nowSec ?? Math.round(Date.now() / 1000))
  const query = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k].replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${query}&w_rid=${md5Hex(query + mixin)}`
}

async function wbiGet<T>(path: string, params: Record<string, string | number>) {
  const [cookie, mixin] = await Promise.all([getCookie(), getWbiMixin()])
  if (!mixin) return { ok: false, status: 0, data: null as T | null, error: 'No WBI keys' }
  return biliFetchJson<T>(`${BILIBILI_CN_API}${path}?${signWbiQuery(params, mixin)}`, {
    referer: BILIBILI_CN_REFERER,
    cookie,
  })
}

function stripHtml(s: string): string {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

// ── PGC (official) ───────────────────────────────────────────────────────────

type PgcSearchHit = {
  season_id?: number
  media_id?: number
  title?: string
  org_title?: string
  ep_size?: number
  pubtime?: number
  season_type_name?: string
  areas?: string
}

export type CnSeasonMatch = {
  seasonId: string
  title: string
  year: number
  epSize: number
  score: number
}

/** Search media_bangumi then media_ft with every Chinese (then Latin) title. */
export async function searchCnSeason(q: DonghuaMatchQuery & { keywords: string[] }): Promise<CnSeasonMatch | null> {
  const seen = new Set<string>()
  let best: CnSeasonMatch | null = null
  for (const keyword of q.keywords) {
    for (const type of ['media_bangumi', 'media_ft']) {
      const r = await wbiGet<{ code?: number; data?: { result?: PgcSearchHit[] } }>(
        '/x/web-interface/wbi/search/type',
        { search_type: type, keyword, page: 1 },
      )
      const hits = r.data?.code === 0 ? r.data?.data?.result || [] : []
      biliLog('cn.search', {
        keyword, type, status: r.status, code: r.data?.code, hits: hits.length, error: r.error || undefined,
      })
      for (const h of hits) {
        const sid = String(h.season_id || '')
        if (!sid || seen.has(sid)) continue
        seen.add(sid)
        const title = stripHtml(h.title || '')
        const year = h.pubtime ? new Date(h.pubtime * 1000).getUTCFullYear() : 0
        const epSize = Number(h.ep_size) || 0
        const s1 = scoreDonghuaCandidate(q, { title, year, episodeCount: epSize })
        const s2 = h.org_title ? scoreDonghuaCandidate(q, { title: stripHtml(h.org_title), year, episodeCount: epSize }) : s1
        const s = s2.score > s1.score ? s2 : s1
        biliLog('cn.candidate', {
          seasonId: sid, title, year, epSize, kind: h.season_type_name, area: h.areas,
          score: Math.round(s.score), titleSim: Number(s.titleSim.toFixed(2)), strong: s.strong, reason: s.reason,
        })
        if (!s.strong) continue
        if (!best || s.score > best.score) best = { seasonId: sid, title, year, epSize, score: s.score }
      }
      if (best && best.score >= 110) return best
    }
    if (best) return best
  }
  return best
}

type PgcEpisode = {
  id?: number
  ep_id?: number
  cid?: number
  aid?: number
  bvid?: string
  title?: string
  long_title?: string
  badge?: string
  status?: number
  duration?: number
  section_type?: number
}

const TRAILER_RE = /预告|預告|\bpv\b|花絮|先导|先導|片花|trailer|teaser|preview/i

function isTrailerEp(e: PgcEpisode): boolean {
  if (e.section_type === 1) return true
  if (TRAILER_RE.test(String(e.badge || ''))) return true
  if (TRAILER_RE.test(`${e.long_title || ''}`) && Number(e.duration || 0) < 4 * 60_000) return true
  return false
}

function isMembersEp(e: PgcEpisode): boolean {
  const badge = String(e.badge || '')
  if (/会员|會員|付费|付費|vip/i.test(badge)) return true
  return e.status === 13
}

function epNumber(e: PgcEpisode): number {
  const t = String(e.title || '').trim()
  if (/^\d{1,4}$/.test(t)) return Number(t)
  const m = /第\s*(\d{1,4})\s*[集话話]/.exec(`${t} ${e.long_title || ''}`)
  return m ? Number(m[1]) : 0
}

export type CnEpisode = {
  epId: string
  cid: string
  title: string
  durationSec: number
  /** For the subtitle lookup (`x/player/wbi/v2`). */
  aid?: string
  bvid?: string
}

export async function fetchCnSeasonEpisode(
  seasonId: string,
  episode: number,
): Promise<{ ok: true; ep: CnEpisode; regularCount: number } | { ok: false; error: string }> {
  const r = await biliFetchJson<{ code?: number; result?: { title?: string; episodes?: PgcEpisode[] } }>(
    `${BILIBILI_CN_API}/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`,
    { referer: BILIBILI_CN_REFERER, cookie: await getCookie() },
  )
  const all = r.data?.code === 0 ? r.data.result?.episodes || [] : []
  if (all.length === 0) {
    biliLog('cn.season.fail', { seasonId, status: r.status, code: r.data?.code, error: r.error })
    return { ok: false, error: 'Bilibili season has no episodes' }
  }
  const regular = all.filter((e) => !isTrailerEp(e))
  const byNumber = regular.find((e) => epNumber(e) === episode)
  const row = byNumber || (regular.every((e) => epNumber(e) === 0) ? regular[episode - 1] : undefined)
  biliLog('cn.season', {
    seasonId, total: all.length, regular: regular.length, trailers: all.length - regular.length,
    episode, found: !!row, title: row?.title, badge: row?.badge, status: row?.status,
  })
  if (!row) return { ok: false, error: `Episode ${episode} not on Bilibili yet` }
  if (isMembersEp(row)) return { ok: false, error: `Episode ${episode} is members-only on Bilibili` }
  const epId = String(row.ep_id || row.id || '')
  const cid = String(row.cid || '')
  if (!epId || !cid) return { ok: false, error: 'Bilibili episode ids missing' }
  return {
    ok: true,
    ep: {
      epId,
      cid,
      aid: row.aid ? String(row.aid) : undefined,
      bvid: row.bvid ? String(row.bvid) : undefined,
      title: [row.title, row.long_title].filter(Boolean).join(' '),
      durationSec: Math.round(Number(row.duration || 0) / 1000),
    },
    regularCount: regular.length,
  }
}

// ── DASH streams ─────────────────────────────────────────────────────────────

type DashTrack = {
  id?: number
  base_url?: string
  baseUrl?: string
  backup_url?: string[] | null
  backupUrl?: string[] | null
  bandwidth?: number
  codecs?: string
  codecid?: number
  width?: number
  height?: number
  frame_rate?: string
  segment_base?: { initialization?: string; index_range?: string }
  SegmentBase?: { Initialization?: string; indexRange?: string }
}

type DashInfo = { duration?: number; video?: DashTrack[]; audio?: DashTrack[] | null }

export type BiliDashTrack = {
  url: string
  backups: string[]
  codecs: string
  bandwidth: number
  width?: number
  height?: number
  init: [number, number]
  index: [number, number]
}

export type BiliDashSource = {
  video: BiliDashTrack
  audio: BiliDashTrack
  durationSec: number
  quality: number
  referer: string
}

function parseRange(s: string | undefined): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim())
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  return b >= a ? [a, b] : null
}

function toTrack(t: DashTrack): BiliDashTrack | null {
  const url = String(t.base_url || t.baseUrl || '').trim()
  const init = parseRange(t.segment_base?.initialization || t.SegmentBase?.Initialization)
  const index = parseRange(t.segment_base?.index_range || t.SegmentBase?.indexRange)
  if (!url || !init || !index) return null
  return {
    url: url.replace(/^http:/, 'https:'),
    backups: (t.backup_url || t.backupUrl || []).map((u) => String(u).replace(/^http:/, 'https:')),
    codecs: String(t.codecs || ''),
    bandwidth: Number(t.bandwidth) || 0,
    width: t.width,
    height: t.height,
    init,
    index,
  }
}

/** Highest ≤1080p AVC video + best AAC audio (HEVC / AV1 / FLAC skipped for compatibility). */
export function pickDashTracks(dash: DashInfo | undefined | null): Omit<BiliDashSource, 'quality' | 'referer'> | null {
  if (!dash) return null
  const videos = (dash.video || [])
    .filter((v) => v.codecid === 7 || /^avc1/i.test(String(v.codecs || '')))
    .filter((v) => !v.height || v.height <= 1080)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
  const audios = (dash.audio || [])
    .filter((a) => /^mp4a/i.test(String(a.codecs || '')))
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
  for (const v of videos) {
    const vt = toTrack(v)
    if (!vt) continue
    for (const a of audios) {
      const at = toTrack(a)
      if (at) return { video: vt, audio: at, durationSec: Number(dash.duration) || 0 }
    }
  }
  return null
}

export async function fetchCnPgcDash(ep: CnEpisode): Promise<{ ok: true; source: BiliDashSource } | { ok: false; error: string }> {
  const url =
    `${BILIBILI_CN_API}/pgc/player/web/v2/playurl?ep_id=${encodeURIComponent(ep.epId)}` +
    `&cid=${encodeURIComponent(ep.cid)}&qn=80&fnver=0&fnval=4048&fourk=1`
  const r = await biliFetchJson<{
    code?: number
    message?: string
    result?: {
      video_info?: { quality?: number; is_preview?: number; dash?: DashInfo }
      play_check?: { play_detail?: string }
    }
  }>(url, { referer: BILIBILI_CN_REFERER, cookie: await getCookie() })
  const vi = r.data?.result?.video_info
  const playDetail = String(r.data?.result?.play_check?.play_detail || '')
  biliLog('cn.playurl', {
    epId: ep.epId, status: r.status, code: r.data?.code, message: r.data?.message, quality: vi?.quality,
    preview: vi?.is_preview, playDetail, videos: vi?.dash?.video?.length ?? 0,
  })
  if (r.data?.code !== 0 || !vi) return { ok: false, error: r.data?.message || r.error || 'Bilibili playurl failed' }
  if (vi.is_preview === 1 || /PREVIEW/i.test(playDetail)) {
    return { ok: false, error: 'Bilibili only offers a members preview for this episode' }
  }
  const picked = pickDashTracks(vi.dash)
  if (!picked) return { ok: false, error: 'No AVC/AAC DASH tracks from Bilibili' }
  return { ok: true, source: { ...picked, quality: Number(vi.quality) || 0, referer: BILIBILI_CN_REFERER } }
}

// ── fan uploads (UGC) ────────────────────────────────────────────────────────

type UgcHit = {
  bvid?: string
  aid?: number
  title?: string
  author?: string
  duration?: string
  play?: number
  typename?: string
}

const UGC_REJECT_RE =
  /合集|合辑|一口气|连看|全集|预告|預告|\bpv\b|花絮|片段|切片|解说|解說|混剪|\bamv\b|\bmad\b|速看|抢先看|搶先看|reaction|反应|看点|盘点|高能|名场面|剪辑|剪輯|cut|鬼畜|手书|cos|配音|翻唱|漫画|小说|动态漫|有声|广播剧|\d+\s*[-~—–至到]\s*\d+\s*[集话]/i

function durationSec(s: string | undefined): number {
  const parts = String(s || '').split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function hasEpisodeMarker(title: string, episode: number): boolean {
  const t = toSimplified(title.normalize('NFKC'))
  const n = String(episode)
  const res = [
    new RegExp(`第\\s*0*${n}\\s*[集话期]`),
    new RegExp(`\\bE(?:P)?\\s*0*${n}(?!\\d)`, 'i'),
    new RegExp(`(?:^|[^\\d])0*${n}\\s*[集话](?!\\d)`),
  ]
  return res.some((re) => re.test(t))
}

/** Exported for probes / tests. */
export function acceptUgcHit(h: { title: string; durationSec: number }, zhTitles: string[], episode: number): string {
  const title = stripHtml(h.title)
  const key = normalizeTitleKey(title)
  if (!zhTitles.some((z) => {
    const zk = normalizeTitleKey(z.split(/[:：]/)[0] || z)
    return zk.length >= 2 && key.includes(zk)
  })) return 'title'
  if (UGC_REJECT_RE.test(title)) return 'compilation/clip'
  if (!hasEpisodeMarker(title, episode)) return 'episode marker'
  if (h.durationSec < 240) return 'too short'
  return ''
}

export async function findCnFanUpload(
  zhTitles: string[],
  episode: number,
  expectDurationSec = 0,
): Promise<{ ok: true; source: BiliDashSource; bvid: string; cid: string; title: string } | { ok: false; error: string }> {
  const base = zhTitles[0]
  if (!base) return { ok: false, error: 'No Chinese title for fan uploads' }
  const short = base.split(/[:：]/)[0].trim() || base
  const keywords = [`${short} 第${episode}集`, `${short} EP${episode}`]
  const accepted: Array<{ bvid: string; title: string; dur: number; play: number }> = []
  const seen = new Set<string>()
  for (const keyword of keywords) {
    const r = await wbiGet<{ code?: number; data?: { result?: UgcHit[] } }>(
      '/x/web-interface/wbi/search/type',
      { search_type: 'video', keyword, page: 1 },
    )
    const hits = r.data?.code === 0 ? r.data.data?.result || [] : []
    const reasons: Record<string, number> = {}
    for (const h of hits) {
      const bvid = String(h.bvid || '')
      if (!bvid || seen.has(bvid)) continue
      seen.add(bvid)
      const dur = durationSec(h.duration)
      const why = acceptUgcHit({ title: String(h.title || ''), durationSec: dur }, zhTitles, episode)
      if (why) {
        reasons[why] = (reasons[why] || 0) + 1
        continue
      }
      // A full episode should be roughly the official length when we know it.
      if (expectDurationSec > 0 && (dur < expectDurationSec * 0.6 || dur > expectDurationSec * 2.2)) {
        reasons.length = (reasons.length || 0) + 1
        continue
      }
      accepted.push({ bvid, title: stripHtml(h.title || ''), dur, play: Number(h.play) || 0 })
    }
    biliLog('fan.search', { keyword, status: r.status, code: r.data?.code, hits: hits.length, accepted: accepted.length, rejected: reasons })
    if (accepted.length > 0) break
  }
  if (accepted.length === 0) return { ok: false, error: 'No matching fan upload' }
  accepted.sort((a, b) => b.dur - a.dur || b.play - a.play)
  for (const cand of accepted.slice(0, 3)) {
    // pagelist is not behind the -412 risk gate that plain x/web-interface/view hits.
    type Page = { cid?: number; page?: number; part?: string; duration?: number }
    const pl = await biliFetchJson<{ code?: number; data?: Page[] }>(
      `${BILIBILI_CN_API}/x/player/pagelist?bvid=${encodeURIComponent(cand.bvid)}`,
      { referer: BILIBILI_CN_REFERER, cookie: await getCookie() },
    )
    let pages: Page[] = pl.data?.code === 0 && Array.isArray(pl.data.data) ? pl.data.data : []
    let viewCode = pl.data?.code
    if (pages.length === 0) {
      const view = await wbiGet<{ code?: number; data?: { cid?: number; pages?: Page[] } }>(
        '/x/web-interface/wbi/view',
        { bvid: cand.bvid },
      )
      viewCode = view.data?.code
      pages = view.data?.data?.pages || (view.data?.data?.cid ? [{ cid: view.data.data.cid }] : [])
    }
    const page =
      pages.length > 1
        ? pages.find((p) => hasEpisodeMarker(String(p.part || ''), episode)) || pages[0]
        : pages[0]
    const cid = String(page?.cid || '')
    if (!cid) {
      biliLog('fan.view.fail', { bvid: cand.bvid, code: viewCode })
      continue
    }
    const pu = await wbiGet<{ code?: number; message?: string; data?: { quality?: number; dash?: DashInfo; is_preview?: number } }>(
      '/x/player/wbi/playurl',
      { bvid: cand.bvid, cid, qn: 80, fnver: 0, fnval: 4048, fourk: 1 },
    )
    const picked = pu.data?.code === 0 ? pickDashTracks(pu.data.data?.dash) : null
    biliLog('fan.playurl', { bvid: cand.bvid, title: cand.title, dur: cand.dur, code: pu.data?.code, message: pu.data?.message, quality: pu.data?.data?.quality, ok: !!picked })
    if (!picked) continue
    return {
      ok: true,
      bvid: cand.bvid,
      cid,
      title: cand.title,
      source: { ...picked, quality: Number(pu.data?.data?.quality) || 0, referer: BILIBILI_CN_REFERER },
    }
  }
  return { ok: false, error: 'Fan upload streams unavailable' }
}

// ── CC / AI subtitles ────────────────────────────────────────────────────────

/** One CC track from `x/player/(wbi/)v2` → `data.subtitle.subtitles[]`. */
export type CnSubtitleTrack = {
  /** lan as given: zh-CN, zh-Hans, en-US, ai-zh, ai-en… */
  lan: string
  label: string
  url: string
  /** AI-generated (lan `ai-*` or `ai_type` set). */
  ai: boolean
}

type PlayerV2 = {
  code?: number
  message?: string
  data?: {
    need_login_subtitle?: boolean
    subtitle?: {
      subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string; ai_type?: number; ai_status?: number }> | null
    } | null
  }
}

function cnTracksFrom(data: PlayerV2 | null | undefined): CnSubtitleTrack[] {
  if (!data || data.code !== 0) return []
  const out: CnSubtitleTrack[] = []
  for (const t of data.data?.subtitle?.subtitles || []) {
    const url = String(t?.subtitle_url || '').trim().replace(/^\/\//, 'https://').replace(/^http:\/\//i, 'https://')
    const lan = String(t?.lan || '').trim()
    if (!url || !lan || !/^https:\/\//i.test(url)) continue
    out.push({ lan, label: String(t?.lan_doc || lan), url, ai: /^ai-/i.test(lan) || Number(t?.ai_type) > 0 })
  }
  return out
}

/**
 * CC tracks for a bilibili.com video (official PGC episode or fan upload). Tries the WBI-signed
 * `x/player/wbi/v2` first, then the unsigned `x/player/v2`. Anonymous sessions usually get
 * uploader CC tracks; AI tracks are often login-only (`need_login_subtitle`).
 */
export async function fetchCnSubtitleTracks(ref: {
  cid: string
  aid?: string
  bvid?: string
  epId?: string
}): Promise<CnSubtitleTrack[]> {
  const cid = String(ref.cid || '').trim()
  if (!cid || (!ref.aid && !ref.bvid)) return []
  const params: Record<string, string> = { cid }
  if (ref.aid) params.aid = String(ref.aid)
  else if (ref.bvid) params.bvid = String(ref.bvid)
  if (ref.epId) params.ep_id = String(ref.epId)
  const signed = await wbiGet<PlayerV2>('/x/player/wbi/v2', params)
  let tracks = cnTracksFrom(signed.data)
  let via = 'wbi'
  let needLogin = !!signed.data?.data?.need_login_subtitle
  if (tracks.length === 0) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    const plain = await biliFetchJson<PlayerV2>(`${BILIBILI_CN_API}/x/player/v2?${qs}`, {
      referer: BILIBILI_CN_REFERER,
      cookie: await getCookie(),
    })
    const more = cnTracksFrom(plain.data)
    if (more.length > 0) {
      tracks = more
      via = 'v2'
    }
    needLogin = needLogin || !!plain.data?.data?.need_login_subtitle
  }
  biliLog('cn.subs', {
    ...params,
    via,
    code: signed.data?.code,
    needLogin,
    tracks: tracks.map((t) => t.lan),
  })
  return tracks
}
