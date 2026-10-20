/**
 * Softsub chain for Movy/Atlantic/Rive/M2Box plays with no captions:
 * Wyzie → OpenSubtitles → (caller may still try Nyaa magnets).
 *
 * Also resolves TMDB original language so non-English titles always get a
 * softsub attempt in the user's preferred subtitle language (default: en).
 */

import {
  detectItemOriginalLanguage,
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
import { resolveOpenSubtitlesSubtitle, isOpenSubtitlesAvailable } from './openSubtitles'
import { resolveWyzieSubtitle, isWyzieAvailable } from './wyzie'
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
    return {
      tmdbId,
      originalLanguage: originalLanguage || undefined,
      preferredLanguage,
      needsSoftSubs: true,
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
