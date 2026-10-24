/**
 * Donghua (Chinese anime) play chain after Movy misses:
 *
 *   TMDB titles (zh + English, year, episode count)
 *   → bilibili.tv native HLS (strict match)
 *   → bilibili.com mainland PGC DASH → in-app HLS   (Chinese shows)
 *   → bilibili.com fan upload DASH → in-app HLS      (strict: exact episode, full length)
 *   → bilibili.tv free play page (embed)
 *   → iQIYI International play page (embed, iq.com)
 *   → bilibili.tv Premium play page (embed)
 *   → fail (caller continues to Nyaa)
 *
 * Matches are cached on the item as `bilibiliSeasonId = "v2|tv=…;cn=…;iq=…"`. Old
 * unprefixed values are ignored (they could hold a wrong match, e.g. Supreme Commander).
 */

import { resolveBilibiliPlay, BILIBILI_TV_PLAY_REFERER } from './bilibiliTv'
import {
  BILIBILI_CN_REFERER,
  fetchCnPgcDash,
  fetchCnSeasonEpisode,
  findCnFanUpload,
  searchCnSeason,
} from './bilibiliCn'
import { buildBiliDashHls } from './biliDashHls'
import { biliLog } from './biliLog'
import { resolveBiliSubtitle, type BiliSubtitle, type BiliSubtitleRef } from './biliSubs'
import { fetchDonghuaTitleInfo, hasCjk, isChineseText, toSimplified, type DonghuaTitleInfo } from './donghuaTitles'
import { fetchIqiyiEpisode, searchIqiyiAlbum } from './iqiyi'

export type DonghuaProvider = 'bilibili.tv' | 'bilibili.com' | 'bilibili.com fan upload' | 'iQIYI'

export type DonghuaPlayResult =
  | {
      ok: true
      mode: 'hls' | 'embed'
      url: string
      referer: string
      provider: DonghuaProvider
      title?: string
      premium?: boolean
      /** Value to store as item.bilibiliSeasonId. */
      cache: string
      /** Legacy bilibili.tv ids (embed continue-watching). */
      seasonId?: string
      episodeId?: string
      /**
       * Episode's own Bilibili subtitle (hls results only): English, else Chinese flagged for
       * translation. Absent → the Player's Wyzie / OpenSubtitles chain.
       */
      subtitle?: BiliSubtitle
    }
  | { ok: false; error: string; cache: string; tried: string[] }

export type DonghuaResolveOptions = {
  title: string
  altTitles?: string[]
  season?: number
  episode: number
  episodeCountHint?: number
  tmdbId?: string | number
  /** item.bilibiliSeasonId */
  cached?: string
  onStatus?: (text: string) => void
  /** Probes only (node has no import.meta.env). */
  tmdbApiKey?: string
  /** Skip bilibili.tv (probes / when caller already tried it). */
  skipTv?: boolean
  /** Skip the Bilibili subtitle lookup. */
  skipSubtitles?: boolean
}

const SUBTITLE_TIMEOUT_MS = 8_000

/** Subtitle lookup bounded so it never holds up playback for long; null on miss / timeout. */
function startSubtitleLookup(ref: BiliSubtitleRef, skip?: boolean): Promise<BiliSubtitle | null> {
  if (skip) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      biliLog('subs.timeout', { ref })
      resolve(null)
    }, SUBTITLE_TIMEOUT_MS)
    resolveBiliSubtitle(ref)
      .catch(() => null)
      .then((r) => {
        clearTimeout(timer)
        resolve(r)
      })
  })
}

type CacheIds = { tv?: string; cn?: string; iq?: string }

export function parseDonghuaCache(raw: string | undefined): CacheIds {
  const s = String(raw || '').trim()
  if (!s.startsWith('v2|')) return {}
  const out: CacheIds = {}
  for (const part of s.slice(3).split(';')) {
    const [k, v] = part.split('=')
    if ((k === 'tv' || k === 'cn' || k === 'iq') && v && /^[\w-]+$/.test(v)) out[k] = v
  }
  return out
}

export function formatDonghuaCache(ids: CacheIds): string {
  const parts = (['tv', 'cn', 'iq'] as const).filter((k) => ids[k]).map((k) => `${k}=${ids[k]}`)
  return parts.length ? `v2|${parts.join(';')}` : ''
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = String(raw || '').trim()
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

/** Chinese search keywords: full title, then the part before "：" (万古至尊：李云霄传 → 万古至尊). */
function zhKeywords(zh: string[]): string[] {
  const out: string[] = []
  for (const t of zh) {
    out.push(t)
    const head = t.split(/[:：\s]/)[0]?.trim()
    if (head && head.length >= 2 && head !== t) out.push(head)
  }
  return uniq(out)
}

export async function resolveDonghuaPlay(opts: DonghuaResolveOptions): Promise<DonghuaPlayResult> {
  const status = (t: string) => {
    try {
      opts.onStatus?.(t)
    } catch {
      /* ignore */
    }
  }
  const season = Math.max(1, Math.floor(opts.season || 1))
  const episode = Math.max(1, Math.floor(opts.episode || 1))
  const ids = parseDonghuaCache(opts.cached)
  const tried: string[] = []
  const t0 = Date.now()

  status('Looking up Chinese titles…')
  let info: DonghuaTitleInfo | null = null
  try {
    info = await fetchDonghuaTitleInfo(opts.tmdbId, { season, apiKey: opts.tmdbApiKey })
  } catch (err) {
    biliLog('tmdb.error', { error: err instanceof Error ? err.message : String(err) })
  }
  const given = uniq([opts.title, ...(opts.altTitles || [])])
  const zh = uniq([
    ...(info?.zhTitles || []),
    ...given.filter((t) => isChineseText(t)).map((t) => toSimplified(t.normalize('NFKC'))),
  ])
  const latin = uniq([...given.filter((t) => !hasCjk(t)), ...(info?.latinTitles || [])])
  const year = info?.year || undefined
  const episodeCount = info?.episodeCount || opts.episodeCountHint || undefined
  const chinese = info ? info.isChinese : zh.length > 0
  const query = { titles: [...zh, ...latin], year, episodeCount, season }
  biliLog('resolve.start', { title: opts.title, tmdbId: opts.tmdbId, season, episode, zh, latin: latin.slice(0, 4), year, episodeCount, chinese, cached: ids })

  const done = (r: DonghuaPlayResult): DonghuaPlayResult => {
    biliLog('resolve.done', r.ok
      ? {
          provider: r.provider, mode: r.mode, premium: r.premium, ms: Date.now() - t0, cache: r.cache,
          subtitle: r.subtitle ? `${r.subtitle.language}${r.subtitle.ai ? '(ai)' : ''}${r.subtitle.needsTranslation ? '→translate' : ''}` : 'none',
        }
      : { error: r.error, tried, ms: Date.now() - t0 })
    return r
  }

  // 1) bilibili.tv (intl) — native HLS when free; remember its embed for later.
  let tvEmbed: Extract<DonghuaPlayResult, { ok: true }> | null = null
  if (!opts.skipTv && latin.length + zh.length > 0) {
    status('Searching Bilibili…')
    tried.push('bilibili.tv')
    try {
      const tv = await resolveBilibiliPlay({
        title: latin[0] || zh[0],
        altTitles: [...latin.slice(1), ...zh],
        season,
        episode,
        episodeCountHint: episodeCount,
        seasonId: ids.tv,
        year,
      })
      if (tv.ok) {
        ids.tv = tv.seasonId
        const base = {
          ok: true as const,
          url: tv.url,
          referer: BILIBILI_TV_PLAY_REFERER,
          provider: 'bilibili.tv' as const,
          title: tv.title,
          premium: tv.premium,
          seasonId: tv.seasonId,
          episodeId: tv.episodeId,
        }
        if (tv.mode === 'hls') {
          const subtitle = tv.episodeId
            ? await startSubtitleLookup({ kind: 'tv', episodeId: tv.episodeId }, opts.skipSubtitles)
            : null
          return done({ ...base, mode: 'hls', cache: formatDonghuaCache(ids), subtitle: subtitle || undefined })
        }
        // DASH pair → in-app HLS (Jiyu's player) + the English track; any failure → embed.
        if (tv.mode === 'dash' && tv.dash) {
          status(`Loading Bilibili stream${tv.qualityLabel ? ` (${tv.qualityLabel})` : ''}…`)
          const subs = tv.episodeId
            ? startSubtitleLookup({ kind: 'tv', episodeId: tv.episodeId }, opts.skipSubtitles)
            : Promise.resolve(null)
          const hls = await buildBiliDashHls(tv.dash)
          if (hls.ok) {
            const subtitle = await subs
            biliLog('tv.hls.ok', { quality: tv.qualityLabel, height: tv.dash.video.height, codecs: tv.dash.video.codecs })
            return done({
              ...base,
              mode: 'hls',
              url: hls.masterUrl,
              cache: formatDonghuaCache(ids),
              subtitle: subtitle || undefined,
            })
          }
          biliLog('tv.hls.fail', { error: hls.error })
        }
        tvEmbed = { ...base, mode: 'embed', cache: '' }
      } else {
        biliLog('tv.miss', { error: tv.error })
      }
    } catch (err) {
      biliLog('tv.error', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 2) bilibili.com mainland official (PGC) DASH.
  let officialDurationSec = 0
  if (chinese && zh.length > 0) {
    status('Searching Bilibili China…')
    tried.push('bilibili.com')
    try {
      let seasonId = ids.cn || ''
      if (!seasonId) {
        const hit = await searchCnSeason({ ...query, keywords: zhKeywords(zh) })
        seasonId = hit?.seasonId || ''
      }
      if (seasonId) {
        ids.cn = seasonId
        const ep = await fetchCnSeasonEpisode(seasonId, episode)
        if (ep.ok) {
          officialDurationSec = ep.ep.durationSec
          status('Loading Bilibili China stream…')
          const subs = startSubtitleLookup(
            { kind: 'cn', cid: ep.ep.cid, aid: ep.ep.aid, bvid: ep.ep.bvid, epId: ep.ep.epId },
            opts.skipSubtitles,
          )
          const dash = await fetchCnPgcDash(ep.ep)
          if (dash.ok) {
            const hls = await buildBiliDashHls(dash.source)
            if (hls.ok) {
              const subtitle = await subs
              return done({
                ok: true,
                mode: 'hls',
                url: hls.masterUrl,
                referer: BILIBILI_CN_REFERER,
                provider: 'bilibili.com',
                title: ep.ep.title,
                cache: formatDonghuaCache(ids),
                subtitle: subtitle || undefined,
              })
            }
            biliLog('cn.hls.fail', { error: hls.error })
          } else {
            biliLog('cn.stream.miss', { error: dash.error })
          }
        } else {
          biliLog('cn.episode.miss', { error: ep.error })
        }
      }
    } catch (err) {
      biliLog('cn.error', { error: err instanceof Error ? err.message : String(err) })
    }

    // 3) Fan uploads (season 1 only — "第N集" is ambiguous across seasons).
    if (season === 1) {
      status('Looking for a fan upload on Bilibili…')
      tried.push('bilibili fan upload')
      try {
        const fan = await findCnFanUpload(zh, episode, officialDurationSec)
        if (fan.ok) {
          const subs = startSubtitleLookup({ kind: 'cn', cid: fan.cid, bvid: fan.bvid }, opts.skipSubtitles)
          const hls = await buildBiliDashHls(fan.source)
          if (hls.ok) {
            const subtitle = await subs
            return done({
              ok: true,
              mode: 'hls',
              url: hls.masterUrl,
              referer: BILIBILI_CN_REFERER,
              provider: 'bilibili.com fan upload',
              title: fan.title,
              cache: formatDonghuaCache(ids),
              subtitle: subtitle || undefined,
            })
          }
          biliLog('fan.hls.fail', { error: hls.error })
        } else {
          biliLog('fan.miss', { error: fan.error })
        }
      } catch (err) {
        biliLog('fan.error', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // 4) bilibili.tv free play page.
  if (tvEmbed && !tvEmbed.premium) return done({ ...tvEmbed, cache: formatDonghuaCache(ids) })

  // 5) iQIYI International play page.
  if (chinese && zh.length > 0) {
    status('Searching iQIYI…')
    tried.push('iQIYI')
    try {
      let album = ids.iq ? { aid: ids.iq, name: zh[0], year: year || 0, score: 0 } : null
      if (!album) album = await searchIqiyiAlbum({ ...query, keywords: zhKeywords(zh) })
      if (album) {
        ids.iq = album.aid
        const ep = await fetchIqiyiEpisode(album, episode)
        if (ep.ok) {
          return done({
            ok: true,
            mode: 'embed',
            url: ep.url,
            referer: 'https://www.iq.com/',
            provider: 'iQIYI',
            title: ep.title,
            premium: ep.vip,
            cache: formatDonghuaCache(ids),
          })
        }
        biliLog('iq.episode.miss', { error: ep.error })
      }
    } catch (err) {
      biliLog('iq.error', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 6) bilibili.tv Premium play page (no bypass — user's own account).
  if (tvEmbed) return done({ ...tvEmbed, cache: formatDonghuaCache(ids) })

  return done({
    ok: false,
    error: tried.length ? `Not found on ${tried.join(', ')}` : 'No title for Bilibili lookup',
    cache: formatDonghuaCache(ids),
    tried,
  })
}
