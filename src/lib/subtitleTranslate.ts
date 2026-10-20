/**
 * In-app subtitle translator (all platforms identical).
 *
 * The player parses a subtitle track into cues as usual; when that track is not in the
 * preferred subtitle language, a SubtitleTranslationSession translates the cue TEXT in
 * deterministic chunks through the jiyu-wyzie Worker (POST /translate). Cue timings never
 * change, originals are kept so the user can flip back, and every translated chunk is
 * cached in IndexedDB under the same provider-independent key the Worker uses in KV.
 *
 * No API keys here: providers (Gemini -> DeepL -> Workers AI) live on the Worker.
 * Desktop (dev + installed) posts with the renderer's fetch (Worker sends CORS *);
 * Android uses CapacitorHttp. Both send X-Jiyu-Client for the Worker gate.
 */

import { CapacitorHttp } from '@capacitor/core'
import type { SubtitleCue } from './subtitles'
import { getWyzieProxyUrl } from './wyzie'
import { isNativeHttpPlatform } from './nativeHttp'
import { normalizeLanguageCode } from './language'
import { subsLog } from './subsLog'

/** Client chunk caps (Worker allows 50 lines / 6000 chars; stay under for headroom). */
export const TRANSLATE_CHUNK_MAX_LINES = 40
export const TRANSLATE_CHUNK_MAX_CHARS = 4000
const WORKER_MAX_LINE_CHARS = 600
const CHUNKS_PER_REQUEST = 2
const MAX_REQUESTS_IN_FLIGHT = 2
const REQUEST_TIMEOUT_MS = 75_000
const CHUNK_RETRY_MS = 60_000
const RATE_LIMIT_RETRY_MS = 20_000
const MAX_CONSECUTIVE_FAILURES = 3
/** Translate a still-growing last chunk once the playhead is this close to it. */
const TAIL_LOOKAHEAD_SEC = 150
const PUMP_INTERVAL_MS = 5_000
/** Source cues sent before each chunk as context only (Worker caps at 5). */
const CONTEXT_LINES_BEFORE = 4
/** Wait this long for show names / synopsis before the first request goes out without them. */
const AIDS_WAIT_MS = 3_000
/** Fast (DeepL) first answers are re-fetched after the Worker's background Gemini upgrade. */
const UPGRADE_REFRESH_MS = 35_000

/** Context-only translation aids (show names glossary, show / episode / synopsis). */
export type TranslationAids = {
  glossary?: string[]
  context?: { title?: string; episodeTitle?: string; synopsis?: string }
}

export type TranslationStatus = 'idle' | 'translating' | 'partial' | 'ready' | 'unavailable'

export type TranslationSnapshot = {
  status: TranslationStatus
  src: string
  tgt: string
  totalChunks: number
  doneChunks: number
  translatedCues: number
  providers: string[]
  error?: string
}

type TranslateChunkResult = {
  id: string
  ok: boolean
  lines?: string[]
  provider?: string
  cached?: boolean
  /** Fast DeepL answer; Gemini is upgrading the Worker cache in the background. */
  upgradePending?: boolean
  error?: string
}

type TranslateResponse = {
  ok?: boolean
  error?: string
  chunks?: TranslateChunkResult[]
  providers?: Record<string, number>
  cached?: number
  billedChars?: number
}

/* ------------------------------------------------------------------ text helpers */

const JP_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/
/** Japanese CC speaker label at the start of a row: (Frieren) in full- or half-width parens. */
const JP_SPEAKER_TAG_RE = /^[\uff08(][^\uff08\uff09()\n]{1,16}[\uff09)]\s*(?=\S)/
/** Furigana reading hint after kanji, e.g. kanji(kana). */
const JP_READING_HINT_RE =
  /([\u3400-\u9fff\u3005\u3006\u30f6]+)[\uff08(][\u3040-\u309f\u30a0-\u30ff\u30fc]+[\uff09)]/g
const JP_TAG_ONLY_RE = /^[\uff08(][^\uff08\uff09()\n]{1,16}[\uff09)]$/
const DIALOGUE_DASH_RE = /^[-\u2010\u2012\u2013\u2014\uff0d]/

/**
 * Clean a cue's text before it is sent for translation. Japanese closed captions carry
 * speaker labels and reading hints, and break rows mid-sentence; strip / join those so the
 * translator sees real sentences. Other languages only get whitespace tidied.
 */
export function normalizeCueTextForTranslation(text: string): string {
  let t = String(text || '')
    .replace(/\r/g, '')
    .trim()
  if (!t) return ''
  if (!JP_CHAR_RE.test(t)) {
    return t
      .split('\n')
      .map((row) => row.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, WORKER_MAX_LINE_CHARS)
  }
  t = t.replace(JP_READING_HINT_RE, '$1')
  const rows = t
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
  let out = ''
  let pendingSpeaker = false
  for (const row of rows) {
    // A row that is only "(Name)" labels the next row (dropped unless it is the whole cue).
    if (rows.length > 1 && JP_TAG_ONLY_RE.test(row)) {
      pendingSpeaker = true
      continue
    }
    const hadSpeaker = pendingSpeaker || JP_SPEAKER_TAG_RE.test(row)
    pendingSpeaker = false
    const clean = row.replace(JP_SPEAKER_TAG_RE, '')
    if (!out) out = clean
    else if (hadSpeaker || DIALOGUE_DASH_RE.test(clean)) out += `\n${clean}`
    else out += clean // CC row break inside one sentence
  }
  if (!out) out = rows.join('\n')
  return out.slice(0, WORKER_MAX_LINE_CHARS)
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'you', 'to', 'and', 'is', 'it', 'that', 'what', 'i', 'of', 'this', 'we', 'are', "don't", 'your', 'me', 'my', 'have', 'not', 'be'],
  es: ['que', 'de', 'no', 'el', 'la', 'y', 'es', 'lo', 'un', 'por', 'qu\u00e9', 'se', 'los', 'las', 'con', 'una', 'para', 'est\u00e1', 'pero', 'yo'],
  pt: ['que', 'n\u00e3o', 'de', 'o', 'a', 'e', '\u00e9', 'um', 'uma', 'voc\u00ea', 'eu', 'para', 'com', 'se', 'isso', 'do', 'da', 'est\u00e1', 'mas', 'meu'],
  fr: ['le', 'la', 'les', 'de', 'et', 'je', 'tu', 'vous', 'est', 'pas', 'que', 'un', 'une', 'ce', 'qui', 'il', 'ne', 'en', "c'est", 'mais'],
  de: ['der', 'die', 'und', 'ich', 'du', 'nicht', 'das', 'ist', 'es', 'sie', 'ein', 'zu', 'wir', 'mit', 'was', 'den', 'mir', 'auf', 'ja', 'aber'],
  it: ['che', 'non', 'di', 'il', 'la', 'e', '\u00e8', 'un', 'una', 'per', 'mi', 'ti', 'ho', 'sono', 'lo', 'ma', 'cosa', 'questo', 'del', 'io'],
}

/**
 * Best-effort language of a cue list from its text (script first, then stopwords for
 * Latin-script languages). Returns '' when unsure - callers then treat it as unknown.
 */
export function detectCueLanguage(cues: Pick<SubtitleCue, 'text'>[]): string {
  const sample = cues
    .slice(0, 240)
    .map((c) => c.text)
    .join('\n')
  if (!sample.trim()) return ''
  const count = (re: RegExp) => (sample.match(re) || []).length
  const kana = count(/[\u3040-\u30ff]/g)
  const hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/g)
  const han = count(/[\u3400-\u9fff]/g)
  const cyr = count(/[\u0400-\u04ff]/g)
  const arabic = count(/[\u0600-\u06ff]/g)
  const thai = count(/[\u0e00-\u0e7f]/g)
  const hebrew = count(/[\u0590-\u05ff]/g)
  const greek = count(/[\u0370-\u03ff]/g)
  const deva = count(/[\u0900-\u097f]/g)
  const latin = count(/[A-Za-z\u00c0-\u024f]/g)
  const total = kana + hangul + han + cyr + arabic + thai + hebrew + greek + deva + latin
  if (total < 20) return ''
  const share = (n: number) => n / total
  if (share(kana) > 0.05) return 'ja'
  if (share(hangul) > 0.2) return 'ko'
  if (share(han) > 0.3) return 'zh'
  if (share(cyr) > 0.4) return 'ru'
  if (share(arabic) > 0.4) return 'ar'
  if (share(thai) > 0.4) return 'th'
  if (share(hebrew) > 0.4) return 'he'
  if (share(greek) > 0.4) return 'el'
  if (share(deva) > 0.4) return 'hi'
  if (share(latin) < 0.6) return ''
  const words = sample.toLowerCase().match(/[a-z\u00c0-\u024f']+/g) || []
  if (words.length < 15) return ''
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
    const set = new Set(list)
    let n = 0
    for (const w of words) if (set.has(w)) n++
    return { lang, n }
  })
  scores.sort((a, b) => b.n - a.n)
  const [best, second] = scores
  if (!best || best.n / words.length < 0.04) return ''
  if (second && second.n > 0 && best.n < second.n * 1.25) return ''
  return best.lang
}

/* ------------------------------------------------------------------ hashing / cache */

async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function fallbackHash(text: string): string {
  // Two FNV-1a passes (different offsets) - local-only key when SubtleCrypto is missing.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}${text.length.toString(16)}`
}

/**
 * Same formula as the Worker's KV key: "tr:" + sha256(src|tgt|JSON(lines)[|g:<glossary hash>]).
 */
export async function translationCacheKey(
  src: string,
  tgt: string,
  lines: string[],
  glossaryHash = '',
): Promise<string> {
  const material = `${src}|${tgt}|${JSON.stringify(lines)}${glossaryHash ? `|g:${glossaryHash}` : ''}`
  const hex = await sha256Hex(material)
  return hex ? `tr:${hex}` : `trf:${fallbackHash(material)}`
}

/** Client glossary caps (inside the Worker's 80 terms / 2400 chars, so it normalizes identically). */
const GLOSSARY_MAX_TERMS = 60
const GLOSSARY_MAX_CHARS = 1500
const GLOSSARY_TERM_MAX = 60

/**
 * Same rules as the Worker's normalizeGlossary (trim/collapse, 2..60 chars, case-insensitive
 * dedupe, order kept) with smaller caps - the Worker then leaves the list unchanged, so both
 * sides hash the same glossary.
 */
export function normalizeTranslationGlossary(list: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const raw of list) {
    const term = String(raw ?? '')
      // Same control-character set as the Worker's cleanText (keeps both hashes identical).
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000)
    if (term.length < 2 || term.length > GLOSSARY_TERM_MAX) continue
    const k = term.toLowerCase()
    if (seen.has(k)) continue
    if (out.length >= GLOSSARY_MAX_TERMS || chars + term.length > GLOSSARY_MAX_CHARS) break
    seen.add(k)
    out.push(term)
    chars += term.length
  }
  return out
}

/** 16 hex chars of sha256(JSON(glossary)) - matches the Worker's glossaryHashOf. */
export async function translationGlossaryHash(glossary: string[]): Promise<string> {
  if (!glossary.length) return ''
  const json = JSON.stringify(glossary)
  const hex = await sha256Hex(json)
  return (hex || fallbackHash(json)).slice(0, 16)
}

const DB_NAME = 'jiyu-subtitle-translate'
const DB_VERSION = 1
const STORE = 'chunks'
const MAX_CACHED_CHUNKS = 4000
const PRUNE_BATCH = 500
const memoryCache = new Map<string, { lines: string[]; provider: string }>()
const MEMORY_CACHE_MAX = 1500
let dbPromise: Promise<IDBDatabase | null> | null = null
let putsSincePrune = 0

type CachedChunk = { key: string; lines: string[]; provider: string; at: number }

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' })
          store.createIndex('at', 'at')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function rememberInMemory(key: string, value: { lines: string[]; provider: string }) {
  memoryCache.delete(key)
  memoryCache.set(key, value)
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value
    if (oldest !== undefined) memoryCache.delete(oldest)
  }
}

async function cacheGet(key: string): Promise<{ lines: string[]; provider: string } | null> {
  const mem = memoryCache.get(key)
  if (mem) return mem
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => {
        const row = req.result as CachedChunk | undefined
        if (row && Array.isArray(row.lines) && !MEMORY_ONLY_PROVIDERS.has(row.provider)) {
          const value = { lines: row.lines, provider: row.provider || 'cache' }
          rememberInMemory(key, value)
          resolve(value)
        } else resolve(null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function pruneCache(db: IDBDatabase) {
  try {
    const count = await new Promise<number>((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count()
      req.onsuccess = () => resolve(Number(req.result) || 0)
      req.onerror = () => resolve(0)
    })
    if (count <= MAX_CACHED_CHUNKS) return
    const tx = db.transaction(STORE, 'readwrite')
    let removed = 0
    const cursorReq = tx.objectStore(STORE).index('at').openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || removed >= PRUNE_BATCH) return
      cursor.delete()
      removed++
      cursor.continue()
    }
  } catch {
    /* cache pruning is best-effort */
  }
}

/**
 * Last-resort provider results (Workers AI m2m100) stay in memory only: the Worker caches them
 * for a day and upgrades them to Gemini/DeepL when it can, so a later session should ask again.
 */
const MEMORY_ONLY_PROVIDERS = new Set(['workers-ai'])

async function cachePut(key: string, lines: string[], provider: string) {
  rememberInMemory(key, { lines, provider })
  if (MEMORY_ONLY_PROVIDERS.has(provider)) return
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ key, lines, provider, at: Date.now() } satisfies CachedChunk)
    putsSincePrune++
    if (putsSincePrune >= 50) {
      putsSincePrune = 0
      void pruneCache(db)
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ network */

function clientTag(): string {
  return `JiyuMedia/${typeof __JIYU_VERSION__ !== 'undefined' ? __JIYU_VERSION__ : 'dev'}`
}

async function postTranslate(body: {
  src: string
  tgt: string
  chunks: { id: string; lines: string[]; before?: string[] }[]
  glossary?: string[]
  context?: TranslationAids['context']
  fast?: boolean
}): Promise<{ status: number; data: TranslateResponse | null; error?: string }> {
  const base = getWyzieProxyUrl()
  if (!base) return { status: 0, data: null, error: 'Subtitle Worker URL missing' }
  const url = `${base}/translate`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Jiyu-Client': clientTag(),
  }
  const isDesktop = typeof window !== 'undefined' && Boolean(window.signalDesktop)

  if (!isDesktop && isNativeHttpPlatform()) {
    try {
      const res = await CapacitorHttp.post({
        url,
        headers: { ...headers, 'User-Agent': `${clientTag()} (translate)` },
        data: body,
        connectTimeout: 30_000,
        readTimeout: REQUEST_TIMEOUT_MS,
      })
      let data = res.data as unknown
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          data = null
        }
      }
      return { status: res.status, data: (data as TranslateResponse) || null }
    } catch (err) {
      return { status: 0, data: null, error: err instanceof Error ? err.message : 'Translate request failed' }
    }
  }

  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal })
    let data: TranslateResponse | null = null
    try {
      data = (await res.json()) as TranslateResponse
    } catch {
      data = null
    }
    return { status: res.status, data }
  } catch (err) {
    return {
      status: 0,
      data: null,
      error: ac.signal.aborted ? 'Translate request timed out' : err instanceof Error ? err.message : 'Translate request failed',
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ session */

type PlannedChunk = {
  sig: string
  cues: SubtitleCue[]
  lines: string[]
  startTime: number
  endTime: number
  /** False only for the last chunk of a still-growing track. */
  closed: boolean
}

function cueKey(cue: SubtitleCue): string {
  return `${cue.start}|${cue.end}|${cue.text}`
}

/** Deterministic chunking by cue order (same cues -> same chunks -> cache hits). */
export function planTranslationChunks(cues: SubtitleCue[], complete: boolean): PlannedChunk[] {
  const out: PlannedChunk[] = []
  let cur: SubtitleCue[] = []
  let lines: string[] = []
  let chars = 0
  const flush = (closed: boolean) => {
    if (!cur.length) return
    out.push({
      sig: JSON.stringify(lines),
      cues: cur,
      lines,
      startTime: cur[0]!.start,
      endTime: cur.reduce((m, c) => Math.max(m, c.end), 0),
      closed,
    })
    cur = []
    lines = []
    chars = 0
  }
  for (const cue of cues) {
    const line = normalizeCueTextForTranslation(cue.text)
    if (cur.length && (cur.length >= TRANSLATE_CHUNK_MAX_LINES || chars + line.length > TRANSLATE_CHUNK_MAX_CHARS)) {
      flush(true)
    }
    cur.push(cue)
    lines.push(line)
    chars += line.length
  }
  flush(complete)
  return out
}

export type TranslationSessionOptions = {
  key: string
  src: string
  tgt: string
  getPlayhead: () => number
  isComplete: () => boolean
  onChange: (snapshot: TranslationSnapshot) => void
  /** Show names glossary + show/episode context (optional; waited for at most AIDS_WAIT_MS). */
  loadAids?: () => Promise<TranslationAids | null>
}

export class SubtitleTranslationSession {
  readonly key: string
  readonly src: string
  readonly tgt: string
  private readonly getPlayhead: () => number
  private readonly isComplete: () => boolean
  private readonly onChange: (snapshot: TranslationSnapshot) => void
  private chunks: PlannedChunk[] = []
  /** sig -> translated lines */
  private done = new Map<string, string[]>()
  /** cue key -> translated text */
  private cueText = new Map<string, string>()
  private inFlight = new Set<string>()
  private retryAt = new Map<string, number>()
  private requests = 0
  private failures = 0
  private unavailable = false
  private lastError = ''
  private providers = new Set<string>()
  private timer: number | null = null
  private disposed = false
  private version = 0
  private memoVersion = -1
  private memoInput: SubtitleCue[] | null = null
  private memoOutput: SubtitleCue[] = []
  private glossary: string[] = []
  private glossaryHash = ''
  private context: TranslationAids['context']
  private readonly aidsReady: Promise<void>
  /** First request goes DeepL-first (fast) - only once per session. */
  private fastUsed = false
  /** sig -> when to re-fetch a fast answer (Gemini upgrade should be cached by then). */
  private upgradeAt = new Map<string, number>()

  constructor(opts: TranslationSessionOptions) {
    this.key = opts.key
    this.src = normalizeLanguageCode(opts.src) || 'auto'
    this.tgt = normalizeLanguageCode(opts.tgt) || 'en'
    this.getPlayhead = opts.getPlayhead
    this.isComplete = opts.isComplete
    this.onChange = opts.onChange
    this.aidsReady = this.prepareAids(opts.loadAids)
    subsLog('translate.start', { src: this.src, tgt: this.tgt })
  }

  /** Fixed for the whole session so chunk cache keys stay stable. */
  private async prepareAids(load: TranslationSessionOptions['loadAids']) {
    if (!load) return
    const started = Date.now()
    let timer: number | undefined
    const aids = await Promise.race([
      load().catch(() => null),
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), AIDS_WAIT_MS)
      }),
    ])
    if (timer != null) window.clearTimeout(timer)
    this.glossary = normalizeTranslationGlossary(aids?.glossary)
    this.glossaryHash = await translationGlossaryHash(this.glossary)
    const ctx = aids?.context
    if (ctx && (ctx.title || ctx.episodeTitle || ctx.synopsis)) this.context = ctx
    subsLog('translate.aids', {
      glossary: this.glossary.length,
      sample: this.glossary.slice(0, 8).join(', ') || undefined,
      title: ctx?.title,
      episodeTitle: ctx?.episodeTitle,
      synopsis: ctx?.synopsis ? ctx.synopsis.length : 0,
      timedOut: aids == null || undefined,
      ms: Date.now() - started,
    })
  }

  /** Feed the latest parsed cues (growing extracts call this repeatedly). */
  update(cues: SubtitleCue[]) {
    if (this.disposed) return
    this.chunks = planTranslationChunks(cues, this.isComplete())
    this.pump()
  }

  /** Cues with translated text where available; untranslated cues keep their original. */
  apply(cues: SubtitleCue[]): SubtitleCue[] {
    if (this.memoInput === cues && this.memoVersion === this.version) return this.memoOutput
    const out = this.cueText.size
      ? cues.map((cue) => {
          const t = this.cueText.get(cueKey(cue))
          return t ? { ...cue, text: t } : cue
        })
      : cues
    this.memoInput = cues
    this.memoVersion = this.version
    this.memoOutput = out
    return out
  }

  snapshot(): TranslationSnapshot {
    const total = this.chunks.length
    const doneChunks = this.chunks.filter((c) => this.done.has(c.sig)).length
    let status: TranslationStatus
    if (this.unavailable) status = 'unavailable'
    else if (total > 0 && doneChunks === total && this.chunks.every((c) => c.closed)) status = 'ready'
    else if (this.requests > 0) status = 'translating'
    else if (doneChunks > 0) status = 'partial'
    else status = 'idle'
    return {
      status,
      src: this.src,
      tgt: this.tgt,
      totalChunks: total,
      doneChunks,
      translatedCues: this.cueText.size,
      providers: [...this.providers],
      error: this.lastError || undefined,
    }
  }

  /** Manual retry after "Translation unavailable". */
  retry() {
    if (this.disposed) return
    this.unavailable = false
    this.failures = 0
    this.lastError = ''
    this.retryAt.clear()
    this.emit()
    this.pump()
  }

  dispose() {
    this.disposed = true
    if (this.timer != null) window.clearTimeout(this.timer)
    this.timer = null
  }

  private emit() {
    if (this.disposed) return
    this.version++
    try {
      this.onChange(this.snapshot())
    } catch {
      /* ignore */
    }
  }

  private schedule() {
    if (this.disposed || this.unavailable || this.timer != null) return
    const pending = this.chunks.some((c) => !this.done.has(c.sig)) || this.upgradeAt.size > 0
    if (!pending) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.pump()
    }, PUMP_INTERVAL_MS)
  }

  private pump() {
    if (this.disposed || this.unavailable) return
    const now = Date.now()
    const playhead = Math.max(0, this.getPlayhead() || 0)
    const complete = this.isComplete()
    const ready = this.chunks.filter(
      (c) =>
        !this.done.has(c.sig) &&
        !this.inFlight.has(c.sig) &&
        (this.retryAt.get(c.sig) ?? 0) <= now &&
        (c.closed || complete || c.startTime - playhead < TAIL_LOOKAHEAD_SEC),
    )
    // What is on screen now / next first, then anything already behind the playhead.
    const ahead = ready.filter((c) => c.endTime >= playhead - 5).sort((a, b) => a.startTime - b.startTime)
    const behind = ready.filter((c) => c.endTime < playhead - 5).sort((a, b) => b.startTime - a.startTime)
    const queue = [...ahead, ...behind]
    while (this.requests < MAX_REQUESTS_IN_FLIGHT && queue.length) {
      const batch = queue.splice(0, CHUNKS_PER_REQUEST)
      void this.runBatch(batch)
    }
    // Fast answers whose Gemini upgrade should be in the Worker cache by now.
    if (this.requests < MAX_REQUESTS_IN_FLIGHT && this.upgradeAt.size) {
      const due = this.chunks.filter(
        (c) => (this.upgradeAt.get(c.sig) ?? Infinity) <= now && !this.inFlight.has(c.sig),
      )
      if (due.length) {
        const batch = due.slice(0, CHUNKS_PER_REQUEST)
        batch.forEach((c) => this.upgradeAt.delete(c.sig))
        void this.runBatch(batch, { refresh: true })
      }
    }
    this.schedule()
  }

  /** Last few source lines of the chunk before this one (context only). */
  private linesBefore(chunk: PlannedChunk): string[] {
    const i = this.chunks.findIndex((c) => c.sig === chunk.sig)
    if (i <= 0) return []
    return this.chunks[i - 1]!.lines.slice(-CONTEXT_LINES_BEFORE).filter(Boolean)
  }

  private applyChunk(chunk: PlannedChunk, lines: string[], provider: string) {
    this.done.set(chunk.sig, lines)
    if (provider) this.providers.add(provider)
    chunk.cues.forEach((cue, i) => {
      const t = String(lines[i] ?? '').trim()
      if (t) this.cueText.set(cueKey(cue), t)
    })
  }

  private async runBatch(batch: PlannedChunk[], opts: { refresh?: boolean } = {}) {
    this.requests++
    batch.forEach((c) => this.inFlight.add(c.sig))
    const started = Date.now()
    try {
      await this.aidsReady
      if (this.disposed) return
      // Local cache first (IndexedDB / memory) - repeat views cost nothing.
      const keyed = await Promise.all(
        batch.map(async (chunk) => ({
          chunk,
          key: await translationCacheKey(this.src, this.tgt, chunk.lines, this.glossaryHash),
        })),
      )
      const misses: typeof keyed = []
      let localHits = 0
      for (const entry of keyed) {
        const hit = opts.refresh ? null : await cacheGet(entry.key)
        if (hit && hit.lines.length === entry.chunk.lines.length) {
          this.applyChunk(entry.chunk, hit.lines, hit.provider)
          localHits++
        } else misses.push(entry)
      }
      if (localHits) this.emit()
      if (this.disposed || !misses.length) return

      const ids = new Map(misses.map((m, i) => [`c${i}`, m]))
      // Nothing on screen yet: answer fast (DeepL) and let Gemini upgrade it in the background.
      const fast = !opts.refresh && !this.fastUsed && this.done.size === 0
      if (fast) this.fastUsed = true
      const res = await postTranslate({
        src: this.src,
        tgt: this.tgt,
        chunks: misses.map((m, i) => {
          const before = this.linesBefore(m.chunk)
          return before.length ? { id: `c${i}`, lines: m.chunk.lines, before } : { id: `c${i}`, lines: m.chunk.lines }
        }),
        ...(this.glossary.length ? { glossary: this.glossary } : {}),
        ...(this.context ? { context: this.context } : {}),
        ...(fast ? { fast: true } : {}),
      })
      if (this.disposed) return
      const rows = Array.isArray(res.data?.chunks) ? res.data!.chunks! : []
      let okCount = 0
      let upgradePending = 0
      for (const row of rows) {
        const entry = row && ids.get(row.id)
        if (!entry) continue
        if (row.ok && Array.isArray(row.lines) && row.lines.length === entry.chunk.lines.length) {
          okCount++
          this.applyChunk(entry.chunk, row.lines, row.provider || '')
          if (row.upgradePending) {
            // Not cached locally: the refresh brings the Gemini version (or a cached DeepL one).
            upgradePending++
            this.upgradeAt.set(entry.chunk.sig, Date.now() + UPGRADE_REFRESH_MS)
          } else void cachePut(entry.key, row.lines, row.provider || '')
        } else {
          this.retryAt.set(entry.chunk.sig, Date.now() + CHUNK_RETRY_MS)
          this.lastError = row.ok ? 'Worker returned the wrong number of lines' : row.error || this.lastError
        }
      }
      // A failed upgrade refresh is not a session failure: the fast answer stays on screen.
      if (okCount === 0 && !opts.refresh) {
        const err =
          res.data?.error || (rows.length ? this.lastError : '') || res.error || `HTTP ${res.status}`
        this.lastError = err
        const wait = res.status === 429 ? RATE_LIMIT_RETRY_MS : CHUNK_RETRY_MS
        for (const m of misses) this.retryAt.set(m.chunk.sig, Date.now() + wait)
        this.failures++
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.unavailable = true
      } else if (okCount > 0) {
        this.failures = 0
      }
      subsLog('translate', {
        src: this.src,
        tgt: this.tgt,
        chunks: misses.length,
        ok: okCount,
        status: res.status,
        providers: res.data?.providers,
        workerCached: res.data?.cached,
        billedChars: res.data?.billedChars,
        localHits,
        fast: fast || undefined,
        refresh: opts.refresh || undefined,
        upgradePending: upgradePending || undefined,
        glossary: this.glossary.length || undefined,
        error: okCount === misses.length ? undefined : this.lastError,
        unavailable: this.unavailable || undefined,
        ms: Date.now() - started,
      })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Translate failed'
      for (const c of batch) if (!this.done.has(c.sig)) this.retryAt.set(c.sig, Date.now() + CHUNK_RETRY_MS)
      if (!opts.refresh) {
        this.failures++
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.unavailable = true
      }
      subsLog('translate', { src: this.src, tgt: this.tgt, ok: 0, error: this.lastError })
    } finally {
      batch.forEach((c) => this.inFlight.delete(c.sig))
      this.requests--
      this.emit()
      if (!this.disposed) this.pump()
    }
  }
}
