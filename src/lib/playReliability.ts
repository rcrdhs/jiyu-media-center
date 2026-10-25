/**
 * Per-title last-good play pipe — prefer what worked last time on this device.
 * Complements streamLearning host scores (pipe choice vs CDN hostname health).
 */

const STORAGE_KEY = 'jiyu.play.reliability.v1'
const MAX_ENTRIES = 200
/** Prefer a remembered pipe for a week; older entries still inform ranking weakly. */
const FRESH_MS = 7 * 24 * 60 * 60 * 1000

export type PlayPipe = 'movy' | 'atlantic' | 'streamo' | 'nyaa' | 'm2box' | 'torrent'

export type LastGoodPlay = {
  pipe: PlayPipe
  /** Movy city / Atlantic provider / torrent site tag */
  provider?: string
  host?: string
  /** Movy audio key that played ("en", "hi"...) when the city labels languages. */
  language?: string
  at: number
}

type Store = Record<string, LastGoodPlay>

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Store
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(map: Store) {
  try {
    const entries = Object.entries(map)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].at - a[1].at)
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries.slice(0, MAX_ENTRIES))),
      )
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota */
  }
}

/** Stable key for a title (and episode when TV). */
export function playReliabilityKey(opts: {
  itemId?: string
  tmdbId?: string | number
  mediaType?: 'movie' | 'tv'
  season?: number
  episode?: number
}): string {
  const tmdb = String(opts.tmdbId || '').trim()
  if (tmdb) {
    const media = opts.mediaType === 'movie' ? 'movie' : 'tv'
    if (media === 'tv') {
      const s = Math.max(1, opts.season || 1)
      const e = Math.max(1, opts.episode || 1)
      return `tmdb:${tmdb}:tv:S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
    }
    return `tmdb:${tmdb}:movie`
  }
  const id = String(opts.itemId || '').trim()
  return id ? `item:${id}` : ''
}

export function rememberLastGoodPlay(
  key: string,
  pipe: PlayPipe,
  detail?: { provider?: string; host?: string; language?: string },
) {
  if (!key) return
  const map = load()
  map[key] = {
    pipe,
    provider: detail?.provider?.trim() || undefined,
    host: detail?.host?.trim() || undefined,
    language: detail?.language?.trim() || undefined,
    at: Date.now(),
  }
  save(map)
}

/**
 * Remember a resolveMovyPlay pick, unless it is a dub in a language other than the
 * original / English: that city is forgotten so it can never be pinned again.
 */
export function rememberResolvedHlsPlay(
  key: string,
  result: {
    backend?: 'movy' | 'atlantic' | 'streamo'
    provider?: string
    url?: string
    language?: string
    languageOk?: boolean
  },
) {
  if (!key) return
  if (result.languageOk === false) {
    forgetLastGoodPlay(key)
    return
  }
  let host: string | undefined
  try {
    host = result.url ? new URL(result.url).hostname : undefined
  } catch {
    host = undefined
  }
  rememberLastGoodPlay(key, result.backend ?? 'movy', {
    provider: result.provider,
    host,
    language: result.language,
  })
}

export function getLastGoodPlay(key: string): LastGoodPlay | null {
  if (!key) return null
  const row = load()[key]
  if (!row || !row.pipe) return null
  return row
}

/** Drop a remembered pipe after a dead CDN / failed stall switch. */
export function forgetLastGoodPlay(key: string) {
  if (!key) return
  const map = load()
  if (!map[key]) return
  delete map[key]
  save(map)
}

export function isLastGoodFresh(row: LastGoodPlay | null, maxAgeMs = FRESH_MS): boolean {
  if (!row) return false
  return Date.now() - row.at < maxAgeMs
}

/** HLS backends to try first for TMDB TV/movies. */
export function preferredHlsBackendOrder(
  last: LastGoodPlay | null,
): Array<'movy' | 'atlantic'> {
  if (last?.pipe === 'atlantic' && isLastGoodFresh(last)) {
    return ['atlantic', 'movy']
  }
  return ['movy', 'atlantic']
}

/** resolveMovyPlay `preferBackend` from the remembered pipe. */
export function preferredResolveBackend(
  last: LastGoodPlay | null,
): 'movy' | 'atlantic' | 'streamo' | undefined {
  const pipe = last?.pipe
  return pipe === 'movy' || pipe === 'atlantic' || pipe === 'streamo' ? pipe : undefined
}

/** Infer pipe from a live playback URL / referrer. */
export function inferPlayPipe(opts: {
  url?: string
  referrer?: string
  backend?: string
}): PlayPipe | null {
  if (opts.backend === 'atlantic' || opts.backend === 'movy' || opts.backend === 'streamo') {
    return opts.backend
  }
  const url = String(opts.url || '')
  const ref = String(opts.referrer || '')
  if (/totallyacdn|cdn\.hls\.lol|stream\.hls\.lol|transcode\.cfd|atlantic\.st/i.test(url) ||
      /atlantic/i.test(ref)) {
    return 'atlantic'
  }
  if (/paleoak|zenoak|wecollege\.net|movy\.sx|\bmoon\.|\bsun\./i.test(url) ||
      /movy\.sx/i.test(ref)) {
    return 'movy'
  }
  if (/shegu\.net/i.test(url) || /streamo\.pro/i.test(ref)) return 'streamo'
  if (/hakunaymatata|aoneroom/i.test(url)) return 'm2box'
  if (/^magnet:/i.test(url) || /127\.0\.0\.1|localhost/i.test(url)) return 'torrent'
  return null
}
