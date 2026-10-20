/**
 * Softsub chain for Movy/Atlantic/Rive/M2Box plays with no captions:
 * Wyzie → OpenSubtitles → (caller may still try Nyaa magnets).
 *
 * Also resolves TMDB original language so non-English titles always get a
 * softsub attempt in the user's preferred subtitle language (default: en).
 */

import {
  detectItemOriginalLanguage,
  getAutoTranslateSubsPref,
  getPreferredSubtitleLanguage,
  itemNeedsSoftSubtitles,
  normalizeLanguageCode,
} from './language'
import {
  fetchTmdbTvOriginalLanguage,
  lookupTmdbMovieMeta,
  lookupTmdbTvMeta,
  resolveAnimeTmdbTvId,
  rivestreamTmdbIdFromItem,
} from './rivestream'
import {
  resolveOpenSubtitlesAnyLanguage,
  resolveOpenSubtitlesSubtitle,
  isOpenSubtitlesAvailable,
} from './openSubtitles'
import { listWyzieHitsAnyLanguage, resolveWyzieSubtitle, isWyzieAvailable } from './wyzie'
import { subsLog } from './subsLog'

export type SoftSubResolveResult =
  | {
      ok: true
      subtitleUrl: string
      subtitleKind: 'file'
      source: 'wyzie' | 'opensubtitles'
    }
  | { ok: false; error: string }

export type EnsureSoftSubtitlesResult = {
  tmdbId: string
  originalLanguage?: string
  preferredLanguage: string
  needsSoftSubs: boolean
  subtitleUrl?: string
  subtitleKind?: 'file'
  source?: 'wyzie' | 'opensubtitles'
  /**
   * Preferred language missed, but a track in another language exists (original language
   * first, then any language the translator handles well). The player uses it as a last
   * resort (after Nyaa) and translates it in-app.
   */
  translationFallback?: {
    subtitleUrl: string
    subtitleKind: 'file'
    source: 'wyzie' | 'opensubtitles'
    /** Source language for the translator ('' = unknown -> Worker auto-detects). */
    language: string
    release?: string
  }
}

/**
 * Languages the translator chain (Gemini / DeepL / m2m100) handles well, in fallback order
 * after the title's original language.
 */
export const TRANSLATION_SOURCE_LANGUAGES = [
  'es', 'pt', 'fr', 'de', 'it', 'id', 'zh', 'ko', 'ru', 'nl', 'pl', 'tr', 'vi', 'ja', 'ar', 'th', 'uk', 'cs', 'sv',
] as const

/** Wyzie / OpenSubtitles track codes -> base language (pb/pt-BR -> pt, zt/zh-TW -> zh, ea -> es). */
export function normalizeSubtitleTrackLanguage(raw?: string | null): string {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  const legacy: Record<string, string> = {
    pb: 'pt', pob: 'pt', zt: 'zh', ze: 'zh', zhs: 'zh', zht: 'zh', ea: 'es', spl: 'es',
  }
  return legacy[s] || normalizeLanguageCode(s)
}

/** Ordered translation-source preference: original language, then TRANSLATION_SOURCE_LANGUAGES. */
export function translationSourcePreference(originalLanguage: string | undefined, preferredLanguage: string): string[] {
  const out: string[] = []
  for (const raw of [originalLanguage, ...TRANSLATION_SOURCE_LANGUAGES]) {
    const lang = normalizeLanguageCode(raw)
    if (!lang || lang === 'xx' || lang === preferredLanguage || out.includes(lang)) continue
    out.push(lang)
  }
  return out
}

export type TranslationTrackCandidate = {
  subtitleUrl: string
  language: string
  release?: string
  format?: string
  hearingImpaired?: boolean
  downloadCount?: number
}

/**
 * Score a track for the any-language fallback. Language dominates: the preferred language
 * wins outright, then the title's ORIGINAL language regardless of release quality (unless the
 * release is tagged as a different episode), then earlier in `prefer`; this episode's SxxEyy,
 * non-HI, text formats and downloads only break ties.
 */
export const ORIGINAL_LANGUAGE_SCORE = 1000

export function scoreTranslationCandidate(
  c: TranslationTrackCandidate,
  opts: {
    prefer: string[]
    preferredLanguage: string
    originalLanguage?: string
    season?: number
    episode?: number
  },
): number {
  const { season, episode } = opts
  let episodeMatch = 0
  if (season != null && episode != null && season >= 1 && episode >= 1) {
    const blob = String(c.release || '').toLowerCase()
    const tag = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    if (blob.includes(tag) || blob.includes(`s${season}e${episode}`)) episodeMatch = 1
    else if (/s\d{1,2}e\d{1,3}/i.test(blob)) episodeMatch = -1
  }
  let score: number
  const original = normalizeLanguageCode(opts.originalLanguage)
  if (c.language && c.language === opts.preferredLanguage) score = 300 + ORIGINAL_LANGUAGE_SCORE
  else if (c.language && original && original !== 'xx' && c.language === original && episodeMatch >= 0) {
    score = ORIGINAL_LANGUAGE_SCORE
  } else {
    const i = c.language ? opts.prefer.indexOf(c.language) : -1
    score = i >= 0 ? 100 - i * 6 : c.language ? 20 : 0
  }
  if (c.hearingImpaired) score -= 8
  const fmt = String(c.format || '').toLowerCase()
  if (fmt === 'srt' || fmt === 'vtt') score += 4
  else if (fmt === 'ass' || fmt === 'ssa') score += 2
  score += Math.min(10, Math.floor((Number(c.downloadCount) || 0) / 25))
  if (episodeMatch > 0) score += 15
  else if (episodeMatch < 0) score -= 60
  return score
}

/**
 * Any-language softsub for translation: Wyzie (all languages, ranked here), then OpenSubtitles
 * (language=any, ranked by the Worker with the same preference list). Worker path on every
 * platform so dev, installed and Android pick the same track.
 */
async function findAnyLanguageTrack(options: {
  tmdbId: string
  season?: number
  episode?: number
  preferredLanguage: string
  originalLanguage?: string
  skipWyzie?: boolean
}): Promise<
  | (TranslationTrackCandidate & { source: 'wyzie' | 'opensubtitles'; candidates?: string })
  | { error: string }
> {
  const prefer = translationSourcePreference(options.originalLanguage, options.preferredLanguage)
  const original = normalizeLanguageCode(options.originalLanguage)
  const opts = {
    prefer,
    preferredLanguage: options.preferredLanguage,
    originalLanguage: original,
    season: options.season,
    episode: options.episode,
  }
  let error = 'No subtitles in any language'
  let wyzieBest: (TranslationTrackCandidate & { source: 'wyzie'; candidates?: string }) | null = null
  if (!options.skipWyzie && isWyzieAvailable()) {
    const w = await listWyzieHitsAnyLanguage(options)
    if (w.ok) {
      const ranked = w.hits
        .map((h) => {
          const c: TranslationTrackCandidate = {
            subtitleUrl: h.subtitleUrl,
            language: normalizeSubtitleTrackLanguage(h.language),
            release: h.release || h.fileName || h.display,
            format: h.format,
            hearingImpaired: h.isHearingImpaired,
            downloadCount: h.downloadCount,
          }
          return { c, score: scoreTranslationCandidate(c, opts) }
        })
        .sort((a, b) => b.score - a.score)
      const best = ranked[0]
      if (best && best.score > 0) {
        wyzieBest = {
          ...best.c,
          source: 'wyzie',
          candidates: ranked
            .slice(0, 8)
            .map((r) => `${r.c.language || '?'}:${r.score}`)
            .join(','),
        }
        if (best.score >= ORIGINAL_LANGUAGE_SCORE) return wyzieBest
      }
    } else error = w.error
  }
  // Original language first: Wyzie had none, so ask OpenSubtitles for exactly that language
  // (a language-filtered search only spends a download when such a track exists).
  const wantOriginal = Boolean(original && original !== 'xx' && original !== options.preferredLanguage)
  if (wantOriginal && isOpenSubtitlesAvailable()) {
    const os = await resolveOpenSubtitlesSubtitle({
      tmdbId: options.tmdbId,
      season: options.season,
      episode: options.episode,
      language: original,
    })
    if (os.ok) return { subtitleUrl: os.subtitleUrl, language: original, source: 'opensubtitles' }
  }
  if (wyzieBest) return wyzieBest
  if (isOpenSubtitlesAvailable()) {
    const os = await resolveOpenSubtitlesAnyLanguage({ ...options, prefer, original })
    if (os.ok) {
      return {
        subtitleUrl: os.subtitleUrl,
        language: normalizeSubtitleTrackLanguage(os.language),
        release: os.release,
        source: 'opensubtitles',
      }
    }
    error = os.error
  }
  return { error }
}

export async function resolveSoftSubtitles(options: {
  tmdbId: string | number
  season?: number
  episode?: number
  language?: string
  /** Skip Wyzie after free-plan ad dump / bad pack. */
  skipWyzie?: boolean
}): Promise<SoftSubResolveResult> {
  const tmdbId = String(options.tmdbId || '').trim()
  if (!tmdbId) return { ok: false, error: 'No TMDB id for subtitles' }

  if (options.skipWyzie) {
    subsLog('softsubs.skip', { tmdbId, provider: 'wyzie', reason: 'skipWyzie (bad pack earlier)' })
  }
  if (!options.skipWyzie && isWyzieAvailable()) {
    const wyzie = await resolveWyzieSubtitle({
      tmdbId,
      season: options.season,
      episode: options.episode,
      language: options.language,
    })
    if (wyzie.ok) {
      return {
        ok: true,
        subtitleUrl: wyzie.subtitleUrl,
        subtitleKind: 'file',
        source: 'wyzie',
      }
    }
  }

  if (isOpenSubtitlesAvailable()) {
    const os = await resolveOpenSubtitlesSubtitle({
      tmdbId,
      season: options.season,
      episode: options.episode,
      language: options.language,
    })
    if (os.ok) {
      return {
        ok: true,
        subtitleUrl: os.subtitleUrl,
        subtitleKind: 'file',
        source: 'opensubtitles',
      }
    }
    subsLog('softsubs.miss', {
      tmdbId,
      season: options.season,
      episode: options.episode,
      reason: 'Wyzie and OpenSubtitles had nothing — caller may try Nyaa',
    })
    return { ok: false, error: os.error }
  }

  subsLog('softsubs.miss', { tmdbId, reason: 'no subtitle providers available' })
  return { ok: false, error: 'No subtitle providers available' }
}

/**
 * Resolve TMDB id + original language, then Wyzie/OpenSubtitles when the
 * title needs softsubs (non-English audio vs preferred sub language).
 */
export async function ensureEpisodeSoftSubtitles(options: {
  title: string
  item?: {
    rivestreamTmdbId?: string
    cinetaroTmdbId?: string
    netmirrorTmdbId?: string
    originalLanguage?: string
    language?: string
    title?: string
    description?: string
    tags?: string[]
    category?: string
    m2boxSubjectId?: string
    torrentSourceId?: string
  }
  tmdbId?: string | number
  season: number
  episode: number
  /** Override preferred softsub language (default from settings / en). */
  language?: string
  skipWyzie?: boolean
  /**
   * When true, always query providers even if the title looks English.
   * Default: only when itemNeedsSoftSubtitles (or language unknown on series/M2Box).
   */
  force?: boolean
  /**
   * When the preferred language misses, also look for an original-language track to
   * translate (default: follows the Auto-translate subtitles setting).
   */
  allowTranslationFallback?: boolean
}): Promise<EnsureSoftSubtitlesResult> {
  const preferredLanguage =
    normalizeLanguageCode(options.language) || getPreferredSubtitleLanguage()

  let tmdbId =
    String(options.tmdbId || '').trim() ||
    (options.item ? rivestreamTmdbIdFromItem(options.item) : '')
  let originalLanguage =
    normalizeLanguageCode(options.item?.originalLanguage) ||
    detectItemOriginalLanguage(
      (options.item as Parameters<typeof detectItemOriginalLanguage>[0]) || {
        title: options.title,
      },
    )

  if (!tmdbId) {
    if (options.item?.category === 'movies') {
      const meta = await lookupTmdbMovieMeta(options.title)
      if (meta?.tmdbId) {
        tmdbId = meta.tmdbId
        if (meta.originalLanguage) {
          originalLanguage = normalizeLanguageCode(meta.originalLanguage) || originalLanguage
        }
      }
    } else if (options.item?.category === 'anime') {
      tmdbId = (await resolveAnimeTmdbTvId(options.title, tmdbId)) || ''
    } else {
      const meta = await lookupTmdbTvMeta(options.title)
      if (meta?.tmdbId) {
        tmdbId = meta.tmdbId
        if (meta.originalLanguage) {
          originalLanguage = normalizeLanguageCode(meta.originalLanguage) || originalLanguage
        }
      }
    }
  } else if (options.item?.category === 'anime') {
    const animeId = await resolveAnimeTmdbTvId(options.title, tmdbId)
    if (animeId) tmdbId = animeId
  }
  if (tmdbId && (!originalLanguage || originalLanguage === 'xx')) {
    const lang = await fetchTmdbTvOriginalLanguage(tmdbId)
    if (lang) originalLanguage = normalizeLanguageCode(lang) || originalLanguage
  }

  const probeItem = {
    ...(options.item || {}),
    title: options.item?.title || options.title,
    originalLanguage: originalLanguage || options.item?.originalLanguage,
  }
  const needsSoftSubs =
    options.force === true ||
    itemNeedsSoftSubtitles(probeItem as Parameters<typeof itemNeedsSoftSubtitles>[0], preferredLanguage) ||
    // Unknown language on series/M2Box — still try once TMDB id is known.
    (!originalLanguage &&
      Boolean(tmdbId) &&
      (options.item?.category === 'series' ||
        options.item?.category === 'anime' ||
        Boolean(options.item?.m2boxSubjectId)))

  if (!tmdbId) {
    subsLog('softsubs.stop', {
      title: options.title,
      season: options.season,
      episode: options.episode,
      reason: 'no TMDB id — Wyzie/OpenSubtitles not tried',
    })
    return {
      tmdbId: '',
      originalLanguage: originalLanguage || undefined,
      preferredLanguage,
      needsSoftSubs,
    }
  }

  if (!needsSoftSubs) {
    subsLog('softsubs.stop', {
      title: options.title,
      tmdbId,
      originalLanguage,
      preferredLanguage,
      reason: 'title does not need softsubs (audio matches preferred language)',
    })
    return {
      tmdbId,
      originalLanguage: originalLanguage || undefined,
      preferredLanguage,
      needsSoftSubs: false,
    }
  }

  const soft = await resolveSoftSubtitles({
    tmdbId,
    season: options.season,
    episode: options.episode,
    language: preferredLanguage,
    skipWyzie: options.skipWyzie,
  })
  if (!soft.ok) {
    const allowFallback = options.allowTranslationFallback ?? getAutoTranslateSubsPref()
    const sourceLanguage = normalizeLanguageCode(originalLanguage)
    let translationFallback: EnsureSoftSubtitlesResult['translationFallback']
    if (allowFallback && sourceLanguage && sourceLanguage !== 'xx' && sourceLanguage !== preferredLanguage) {
      const original = await resolveSoftSubtitles({
        tmdbId,
        season: options.season,
        episode: options.episode,
        language: sourceLanguage,
        skipWyzie: options.skipWyzie,
      })
      subsLog('softsubs.translate-fallback', {
        tmdbId,
        season: options.season,
        episode: options.episode,
        language: sourceLanguage,
        preferredLanguage,
        ok: original.ok,
        source: original.ok ? original.source : undefined,
        error: original.ok ? undefined : original.error,
      })
      if (original.ok) {
        translationFallback = {
          subtitleUrl: original.subtitleUrl,
          subtitleKind: original.subtitleKind,
          source: original.source,
          language: sourceLanguage,
        }
      }
    }
    // Still nothing: take a track in ANY language (original first, then translator-friendly).
    if (allowFallback && !translationFallback) {
      const any = await findAnyLanguageTrack({
        tmdbId,
        season: options.season,
        episode: options.episode,
        preferredLanguage,
        originalLanguage: sourceLanguage || undefined,
        skipWyzie: options.skipWyzie,
      })
      const found = 'subtitleUrl' in any
      subsLog('softsubs.translate-fallback', {
        tmdbId,
        season: options.season,
        episode: options.episode,
        language: 'any',
        preferredLanguage,
        ok: found,
        source: found ? any.source : undefined,
        chosenLanguage: found ? any.language || 'unknown' : undefined,
        release: found ? any.release : undefined,
        candidates: found ? any.candidates : undefined,
        error: found ? undefined : any.error,
      })
      if (found) {
        if (any.language && any.language === preferredLanguage) {
          // The any-language list had a preferred-language track after all: use it as-is.
          return {
            tmdbId,
            originalLanguage: originalLanguage || undefined,
            preferredLanguage,
            needsSoftSubs: true,
            subtitleUrl: any.subtitleUrl,
            subtitleKind: 'file',
            source: any.source,
          }
        }
        translationFallback = {
          subtitleUrl: any.subtitleUrl,
          subtitleKind: 'file',
          source: any.source,
          language: any.language,
          release: any.release,
        }
      }
    }
    return {
      tmdbId,
      originalLanguage: originalLanguage || undefined,
      preferredLanguage,
      needsSoftSubs: true,
      translationFallback,
    }
  }
  return {
    tmdbId,
    originalLanguage: originalLanguage || undefined,
    preferredLanguage,
    needsSoftSubs: true,
    subtitleUrl: soft.subtitleUrl,
    subtitleKind: soft.subtitleKind,
    source: soft.source,
  }
}
