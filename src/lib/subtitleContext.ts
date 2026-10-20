/**
 * Translation aids for the in-app subtitle translator (context only - never translated):
 *  - a per-show NAMES glossary: TMDB character names (season aggregate credits, show credits as
 *    fallback), plus recurring proper nouns pulled from a neighbouring episode's real English
 *    track when one exists (cached per show+season, extracted in the background);
 *  - show title, episode title and synopsis (TMDB overview).
 * Every part is optional, bounded and fails soft: the translator works without any of it.
 * All requests are public TMDB / jiyu-wyzie Worker calls; no keys are added here.
 */

import { fetchTmdbJson } from './rivestream'
import { resolveWyzieSubtitle, isWyzieAvailable } from './wyzie'
import { nativeFetchText } from './nativeHttp'
import { isJunkSubtitleText, parseSubtitleCues } from './subtitles'
import { normalizeTranslationGlossary, type TranslationAids } from './subtitleTranslate'
import { subsLog } from './subsLog'

const MAX_TMDB_NAMES = 40
const MAX_TRACK_NOUNS = 25
const MIN_NOUN_COUNT = 3
const MAX_SYNOPSIS = 1000
/** Neighbour episodes probed for a real English track, and how many tracks are read. */
const NOUN_PROBE_EPISODES = 3
const NOUN_TRACKS = 2
const NOUN_TRACK_MAX_CHARS = 400_000
/** After TMDB answers, wait at most this long for (uncached) English-track nouns... */
const NOUN_WAIT_MS = 1_500
/** ...and never past this point overall (the translator waits up to 3 s for aids). */
const AIDS_BUDGET_MS = 2_600

const STORE_KEY = 'jiyu.translateAids.v1'
const STORE_MAX_ENTRIES = 40
const NAMES_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NOUNS_TTL_MS = 14 * 24 * 60 * 60 * 1000
const NOUNS_EMPTY_TTL_MS = 2 * 24 * 60 * 60 * 1000

type StoredAids = { names?: string[]; namesAt?: number; nouns?: string[]; nounsAt?: number; at: number }

function readStore(): Record<string, StoredAids> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredAids>) : {}
  } catch {
    return {}
  }
}

function writeStoreEntry(key: string, patch: Partial<StoredAids>) {
  try {
    const store = readStore()
    store[key] = { ...store[key], ...patch, at: Date.now() }
    const keys = Object.keys(store)
    if (keys.length > STORE_MAX_ENTRIES) {
      keys
        .sort((a, b) => (store[a]?.at || 0) - (store[b]?.at || 0))
        .slice(0, keys.length - STORE_MAX_ENTRIES)
        .forEach((k) => delete store[k])
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch {
    /* storage full / unavailable - aids are optional */
  }
}

/* ------------------------------------------------------------------ TMDB names */

const GENERIC_ROLE_RE =
  /^(?:narrator|additional voices?|background voices?|himself|herself|themselves|self|voice|various(?: characters)?|unknown|extra|ensemble|cameo|host|announcer|crowd)$/i
const GENERIC_WORDS = new Set(
  (
    'soldier student villager guard knight maid man woman boy girl child kid mother father king queen priest merchant demon monster teacher doctor nurse officer police servant noble bandit thief adventurer customer clerk waiter waitress reporter driver old young little ' +
    'narration narrator children owner cook seller chief people everyone villagers townspeople crowd boss leader shopkeeper'
  ).split(' '),
)

const NAME_PARTICLES = new Set(['de', 'da', 'di', 'du', 'del', 'von', 'van', 'der', 'la', 'le', 'el', 'al', 'bin', 'no'])

function cleanRoleName(raw: string): string[] {
  const noParens = String(raw || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  const out: string[] = []
  for (const part of noParens.split(/\s*(?:\/|;|\s\|\s)\s*/)) {
    const name = part.replace(/["\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim()
    if (name.length < 2 || name.length > 40) continue
    if (!/^\p{Lu}/u.test(name) || /\d/.test(name) || GENERIC_ROLE_RE.test(name)) continue
    // "Soldier A", "Old Man", "Student" - generic roles, not names.
    if (/\s\p{Lu}$/u.test(name)) continue
    // Names are Title Case ("Ars Louvent", "Licia von Plaid"); "A cook", "Egg seller" are not.
    const parts = name.split(' ')
    if (parts.some((w) => !/^\p{Lu}/u.test(w) && !NAME_PARTICLES.has(w))) continue
    if (/^(?:a|an|the)$/i.test(parts[0]!) && parts.length > 1) continue
    const words = name.toLowerCase().split(' ')
    if (words.every((w) => GENERIC_WORDS.has(w))) continue
    out.push(name)
  }
  return out
}

type CreditRole = { character?: string; episode_count?: number }
type CreditCast = {
  character?: string
  roles?: CreditRole[]
  total_episode_count?: number
  episode_count?: number
  order?: number
}

/** Character names from a TMDB (aggregate_)credits payload, most-appearing first. */
export function characterNamesFromCredits(data: unknown, max = MAX_TMDB_NAMES): string[] {
  const cast = (data as { cast?: CreditCast[] } | null)?.cast
  if (!Array.isArray(cast)) return []
  const rows = cast
    .map((p, i) => {
      const roles: CreditRole[] = Array.isArray(p?.roles) && p.roles.length
        ? p.roles
        : [{ character: p?.character, episode_count: p?.episode_count }]
      const weight =
        Number(p?.total_episode_count) ||
        roles.reduce((n, r) => n + (Number(r?.episode_count) || 0), 0) ||
        0
      return { roles, weight, order: Number.isFinite(Number(p?.order)) ? Number(p.order) : i }
    })
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const role of row.roles) {
      for (const name of cleanRoleName(String(role?.character || ''))) {
        const k = name.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        out.push(name)
        if (out.length >= max) return out
      }
    }
  }
  return out
}

async function loadTmdbNames(tmdbId: string, kind: 'tv' | 'movie', season?: number): Promise<string[]> {
  const id = encodeURIComponent(tmdbId)
  if (kind === 'movie') return characterNamesFromCredits(await fetchTmdbJson(`/movie/${id}/credits`, { language: 'en-US' }))
  if (season != null && season >= 0) {
    const names = characterNamesFromCredits(
      await fetchTmdbJson(`/tv/${id}/season/${Math.floor(season)}/aggregate_credits`, { language: 'en-US' }),
    )
    if (names.length) return names
  }
  return characterNamesFromCredits(await fetchTmdbJson(`/tv/${id}/aggregate_credits`, { language: 'en-US' }))
}

async function loadTmdbContext(
  tmdbId: string,
  kind: 'tv' | 'movie',
  season?: number,
  episode?: number,
): Promise<{ title?: string; episodeTitle?: string; synopsis?: string }> {
  const id = encodeURIComponent(tmdbId)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  if (kind === 'movie') {
    const m = (await fetchTmdbJson(`/movie/${id}`, { language: 'en-US' })) as { title?: string; overview?: string } | null
    return { title: str(m?.title), synopsis: str(m?.overview)?.slice(0, MAX_SYNOPSIS) }
  }
  const [show, ep] = await Promise.all([
    fetchTmdbJson(`/tv/${id}`, { language: 'en-US' }) as Promise<{ name?: string; overview?: string } | null>,
    season != null && episode != null
      ? (fetchTmdbJson(`/tv/${id}/season/${Math.floor(season)}/episode/${Math.floor(episode)}`, {
          language: 'en-US',
        }) as Promise<{ name?: string; overview?: string } | null>)
      : Promise.resolve(null),
  ])
  const epName = str(ep?.name)
  return {
    title: str(show?.name),
    // TMDB placeholder names ("Episode 3") add nothing.
    episodeTitle: epName && !/^episode\s+\d+$/i.test(epName) ? epName : undefined,
    synopsis: (str(ep?.overview) || str(show?.overview))?.slice(0, MAX_SYNOPSIS),
  }
}

/* ------------------------------------------------------------------ English-track nouns */

const NOUN_STOPWORDS = new Set(
  (
    'I Im Ive Ill Id OK Okay Oh Ah Eh Uh Um Hey Hi Yes No Yeah Nah Mr Mrs Ms Miss Sir Madam Lady Lord ' +
    'Master Mister God Gods Heaven Hell King Queen Prince Princess Duke Lady Captain General Sister Brother ' +
    'Mom Mother Dad Father Grandpa Grandma Mama Papa Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'January February March April May June July August September October November December English Japanese ' +
    'Episode Chapter Subtitles Subtitle Translated Translation Captions Netflix Crunchyroll Thank Thanks Please ' +
    'Sorry Wait Look Listen Come Let Lets Well Now Then What Why How Who Where When But And The This That ' +
    'City Town Village Kingdom Empire Castle Church Temple Academy School Guild Army Demon Demons Hero Heroes ' +
    'Holy Saint Dragon Magic North South East West Lake Mountain Forest River Sea'
  ).split(' '),
)

/**
 * Recurring proper nouns in real English subtitles: capitalized words that are NOT at a
 * sentence start, appear at least `minCount` times and are rarely seen lowercase.
 */
export function extractRecurringProperNouns(
  tracks: string[][],
  opts: { minCount?: number; max?: number } = {},
): string[] {
  const minCount = opts.minCount ?? MIN_NOUN_COUNT
  const max = opts.max ?? MAX_TRACK_NOUNS
  const caps = new Map<string, number>()
  const lower = new Map<string, number>()
  for (const lines of tracks) {
    for (const raw of lines) {
      const text = String(raw || '')
        .replace(/<[^>]*>|\{[^}]*\}/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' . ')
      for (const sentence of text.split(/[.!?\u2026\n\u266a]+|^\s*-|\s-\s/m)) {
        const words = sentence.match(/[\p{L}][\p{L}'\u2019-]*/gu) || []
        words.forEach((w0, i) => {
          const w = w0.replace(/['\u2019]s$/u, '').replace(/[-'\u2019]+$/u, '')
          if (w.length < 3) return
          const lw = w.toLowerCase()
          if (/^\p{Lu}\p{Ll}/u.test(w)) {
            if (i === 0) return
            caps.set(w, (caps.get(w) || 0) + 1)
          } else if (w === lw) {
            lower.set(lw, (lower.get(lw) || 0) + 1)
          }
        })
      }
    }
  }
  return [...caps.entries()]
    .filter(([w, n]) => {
      if (n < minCount || NOUN_STOPWORDS.has(w.replace(/['\u2019]/g, ''))) return false
      return (lower.get(w.toLowerCase()) || 0) * 2 < n
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w)
}

async function fetchTrackLines(url: string): Promise<string[] | null> {
  let text = ''
  try {
    const res = await nativeFetchText(url, { quiet: true })
    if (res.ok) text = res.content || ''
  } catch {
    /* fall through */
  }
  if (!text) {
    try {
      const res = await fetch(url)
      if (res.ok) text = await res.text()
    } catch {
      return null
    }
  }
  if (!text.includes('-->')) return null
  return parseSubtitleCues(text.slice(0, NOUN_TRACK_MAX_CHARS))
    .map((c) => c.text)
    .filter((t) => t && !isJunkSubtitleText(t))
}

const nounJobs = new Map<string, Promise<string[]>>()

/** Proper nouns from up to NOUN_TRACKS neighbouring episodes' English tracks (cached). */
function loadTrackNouns(storeKey: string, tmdbId: string, season: number, episode: number): Promise<string[]> {
  const existing = nounJobs.get(storeKey)
  if (existing) return existing
  const job = (async () => {
    const started = Date.now()
    const probes: number[] = []
    for (let d = 1; probes.length < NOUN_PROBE_EPISODES && d <= NOUN_PROBE_EPISODES + 1; d++) {
      if (episode - d >= 1) probes.push(episode - d)
      if (probes.length < NOUN_PROBE_EPISODES) probes.push(episode + d)
    }
    const tracks: string[][] = []
    const used: number[] = []
    for (const ep of probes) {
      if (tracks.length >= NOUN_TRACKS) break
      const hit = await resolveWyzieSubtitle({ tmdbId, season, episode: ep, language: 'en' }).catch(() => null)
      if (!hit?.ok) continue
      const lines = await fetchTrackLines(hit.subtitleUrl)
      if (lines && lines.length >= 20) {
        tracks.push(lines)
        used.push(ep)
      }
    }
    const nouns = tracks.length ? extractRecurringProperNouns(tracks) : []
    writeStoreEntry(storeKey, { nouns, nounsAt: Date.now() })
    subsLog('translate.nouns', {
      tmdbId,
      season,
      episodes: used.join(',') || undefined,
      probed: probes.join(','),
      nouns: nouns.length,
      sample: nouns.slice(0, 10).join(', ') || undefined,
      ms: Date.now() - started,
    })
    return nouns
  })().finally(() => nounJobs.delete(storeKey))
  nounJobs.set(storeKey, job)
  return job
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}

/**
 * Prefer the official English subtitle spelling over a TMDB romanization of the same name
 * ("Ritsu Muses" + track noun "Rietz" -> "Rietz Muses"): same first two letters, length
 * within 1, edit distance <= 3, and the track spelling is not already another name's token.
 */
export function reconcileNamesWithTrack(names: string[], nouns: string[]): string[] {
  if (!nouns.length) return names
  const tokens = new Set(names.flatMap((n) => n.toLowerCase().split(' ')))
  const candidates = nouns.filter((n) => n.length >= 4 && !tokens.has(n.toLowerCase()))
  return names.map((name) =>
    name
      .split(' ')
      .map((tok) => {
        if (tok.length < 4) return tok
        const t = tok.toLowerCase()
        const hit = candidates.find((n) => {
          const c = n.toLowerCase()
          return c.slice(0, 2) === t.slice(0, 2) && Math.abs(c.length - t.length) <= 1 && editDistance(c, t) <= 3
        })
        return hit || tok
      })
      .join(' '),
  )
}

/* ------------------------------------------------------------------ public */

const timeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms))])

/**
 * Glossary + context for one playback. TMDB character names are cached 7 days per show+season;
 * English-track nouns 14 days (2 days when none were found). Uncached nouns are extracted in
 * the background and only join this playback if they arrive quickly - later playbacks get them.
 */
export async function loadTranslationAids(options: {
  tmdbId?: string | number
  kind: 'tv' | 'movie'
  season?: number
  episode?: number
  showTitle?: string
}): Promise<TranslationAids | null> {
  const tmdbId = String(options.tmdbId || '').trim()
  if (!/^\d+$/.test(tmdbId)) {
    return options.showTitle ? { context: { title: options.showTitle } } : null
  }
  const { kind } = options
  const season = kind === 'tv' && Number.isFinite(options.season) ? Number(options.season) : undefined
  const episode = kind === 'tv' && Number.isFinite(options.episode) ? Number(options.episode) : undefined
  const storeKey = `${kind}:${tmdbId}:${season ?? ''}`
  const cached = readStore()[storeKey]
  const now = Date.now()
  const started = now

  const namesFresh = cached?.names && now - (cached.namesAt || 0) < NAMES_TTL_MS
  const namesP = namesFresh
    ? Promise.resolve(cached!.names!)
    : loadTmdbNames(tmdbId, kind, season).then((names) => {
        if (names.length) writeStoreEntry(storeKey, { names, namesAt: Date.now() })
        return names
      })
  const nounsTtl = cached?.nouns?.length ? NOUNS_TTL_MS : NOUNS_EMPTY_TTL_MS
  const nounsFresh = cached?.nouns && now - (cached.nounsAt || 0) < nounsTtl
  const nounsP: Promise<string[]> = nounsFresh
    ? Promise.resolve(cached!.nouns!)
    : kind === 'tv' && season != null && episode != null && isWyzieAvailable()
      ? loadTrackNouns(storeKey, tmdbId, season, episode).catch(() => [])
      : Promise.resolve([])

  const [names, context] = await Promise.all([
    namesP.catch(() => [] as string[]),
    loadTmdbContext(tmdbId, kind, season, episode).catch(() => null),
  ])
  const nounWait = Math.max(0, Math.min(NOUN_WAIT_MS, AIDS_BUDGET_MS - (Date.now() - started)))
  const nouns = nounsFresh ? await nounsP : await timeout(nounsP, nounWait, [] as string[])
  const glossary = normalizeTranslationGlossary([...reconcileNamesWithTrack(names, nouns), ...nouns])
  const ctx: NonNullable<TranslationAids['context']> = { ...context }
  if (!ctx.title && options.showTitle) ctx.title = options.showTitle
  return { glossary, context: ctx }
}
