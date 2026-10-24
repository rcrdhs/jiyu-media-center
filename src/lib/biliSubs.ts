/**
 * Subtitles for Bilibili-sourced streams (bilibili.tv and bilibili.com).
 *
 * Picks the episode's own track before the generic Wyzie / OpenSubtitles chain:
 *   English (human, then AI) → Chinese (human zh-Hans / zh-CN, then zh-Hant, then AI zh).
 * A Chinese pick is flagged `needsTranslation` with source language `zh`, so the Player's
 * existing translator (jiyu-wyzie Worker `/translate` + TMDB glossary) turns it into English.
 * Any other language (Thai, Vietnamese…) is ignored and the Player's normal chain runs.
 *
 * The returned URL is the real https track (Bilibili JSON or ASS); the Player loads it with
 * nativeFetchText (desktop fetchHtml IPC / Android CapacitorHttp) and parseSubtitleCues reads
 * both formats. Calls run in the app itself; nothing goes through a server of ours.
 */
import { fetchBilibiliTvSubtitleTracks } from './bilibiliTv'
import { fetchCnSubtitleTracks } from './bilibiliCn'
import { biliLog } from './biliLog'
import { nativeFetchText } from './nativeHttp'
import { parseSubtitleCues } from './subtitles'

export type BiliSubtitleRef =
  | { kind: 'tv'; episodeId: string }
  | { kind: 'cn'; cid: string; aid?: string; bvid?: string; epId?: string }

export type BiliSubtitle = {
  subtitleUrl: string
  /** ISO 639-1 (`en` / `zh`). */
  language: string
  needsTranslation: boolean
  label: string
  ai: boolean
  source: 'bilibili.tv' | 'bilibili.com'
  cueCount: number
}

type Track = { lang: string; raw: string; label: string; url: string; ai: boolean; rank: number }

/** Bilibili lang keys → `en` / `zh` (others → ''), plus a pick rank (lower is better). */
export function rankBiliSubtitleLang(rawLang: string, ai = false): { lang: string; rank: number } {
  const raw = String(rawLang || '').trim().toLowerCase()
  const isAi = ai || raw.startsWith('ai-')
  const base = raw.replace(/^ai-/, '')
  if (base === 'en' || base.startsWith('en-')) return { lang: 'en', rank: isAi ? 1 : 0 }
  if (base === 'zh' || base.startsWith('zh')) {
    const trad = /hant|tw|hk|mo/.test(base)
    return { lang: 'zh', rank: isAi ? 4 : trad ? 3 : 2 }
  }
  return { lang: '', rank: 99 }
}

async function listTracks(ref: BiliSubtitleRef): Promise<Track[]> {
  if (ref.kind === 'tv') {
    const tracks = await fetchBilibiliTvSubtitleTracks(ref.episodeId)
    return tracks
      .map((t) => {
        const r = rankBiliSubtitleLang(t.langKey)
        // Plain JSON before styled ASS for the same language.
        return { lang: r.lang, raw: t.langKey, label: t.label, url: t.url, ai: false, rank: r.rank * 2 + (t.format === 'json' ? 0 : 1) }
      })
  }
  const tracks = await fetchCnSubtitleTracks(ref)
  return tracks.map((t) => {
    const r = rankBiliSubtitleLang(t.lan, t.ai)
    return { lang: r.lang, raw: t.lan, label: t.label, url: t.url, ai: t.ai, rank: r.rank * 2 }
  })
}

/**
 * Best usable track for a Bilibili episode, or null (→ the Player's Wyzie / OpenSubtitles
 * chain). Each candidate is fetched and parsed once so a dead / expired URL is skipped.
 */
export async function resolveBiliSubtitle(ref: BiliSubtitleRef): Promise<BiliSubtitle | null> {
  const source = ref.kind === 'tv' ? 'bilibili.tv' : 'bilibili.com'
  let all: Track[] = []
  try {
    all = await listTracks(ref)
  } catch (e) {
    biliLog('subs.list.fail', { source, error: e instanceof Error ? e.message : String(e) })
    return null
  }
  const usable = all.filter((t) => t.lang).sort((a, b) => a.rank - b.rank)
  biliLog('subs.tracks', {
    source,
    ref,
    all: all.map((t) => `${t.raw}${t.ai ? '(ai)' : ''}`),
    usable: usable.map((t) => t.raw),
  })
  for (const t of usable.slice(0, 4)) {
    let cueCount = 0
    try {
      const r = await nativeFetchText(t.url, { quiet: true, headers: biliSubtitleHeaders(t.url) })
      if (r.ok && r.content) cueCount = parseSubtitleCues(r.content).length
      biliLog('subs.track', { source, lang: t.raw, ok: r.ok, status: r.status, cues: cueCount })
    } catch (e) {
      biliLog('subs.track.fail', { source, lang: t.raw, error: e instanceof Error ? e.message : String(e) })
    }
    if (cueCount < 3) continue
    const out: BiliSubtitle = {
      subtitleUrl: t.url,
      language: t.lang,
      needsTranslation: t.lang !== 'en',
      label: `${t.ai ? 'AI ' : ''}${t.lang === 'en' ? 'English' : 'Chinese'} (Bilibili)`,
      ai: t.ai,
      source,
      cueCount,
    }
    biliLog('subs.pick', { source, lang: t.raw, needsTranslation: out.needsTranslation, cues: cueCount })
    return out
  }
  biliLog('subs.none', { source, tracks: all.length })
  return null
}

/** True for a Bilibili-hosted subtitle track URL (timed to the Bilibili video exactly). */
export function isBiliSubtitleUrl(url: string | undefined | null): boolean {
  return /^https:\/\/[^/]*(?:bstarstatic\.com|hdslb\.com|bilibili\.com|biliapi\.net)\//i.test(String(url || ''))
}

/**
 * Headers for fetching a Bilibili subtitle track. s.bstarstatic.com answers 403 when the
 * Referer is its own origin (or rivestream.ru) and 200 with the bilibili.tv page referer or none
 * (probed 2026-10-23); hdslb.com tracks get the bilibili.com referer.
 */
export function biliSubtitleHeaders(url: string): Record<string, string> {
  const tv = /bstarstatic\.com|bilibili\.tv/i.test(String(url || ''))
  return {
    Accept: 'application/json,text/plain,*/*',
    Referer: tv ? 'https://www.bilibili.tv/' : 'https://www.bilibili.com/',
  }
}
