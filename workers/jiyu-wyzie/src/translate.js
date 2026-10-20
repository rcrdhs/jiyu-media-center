/**
 * POST /translate - subtitle line translation for Jiyu (all platforms).
 *
 * Provider chain (each used only when its secret / binding exists):
 *   1. Gemini   (secret GEMINI_API_KEY, var GEMINI_MODEL)
 *   2. DeepL    (secret DEEPL_API_KEY; ":fx" suffix = API Free endpoint)
 *   3. Workers AI m2m100 (binding AI)
 * A provider is skipped on missing key, HTTP error, 429/456/quota, timeout, bad JSON or
 * line-count mismatch, and the chunk falls through to the next one.
 *
 * Cache: KV binding TRANSLATE_CACHE, key "tr:" + sha256(src|tgt|lines), provider-independent,
 * ~90 day TTL. Budget: KV "budget:<provider>:<YYYY-MM>" source-character counter per provider.
 * Rate limit: optional TRANSLATE_RATE_LIMITER binding, else a per-isolate in-memory window.
 *
 * Request:  { src?: "ja" | "auto", tgt: "en", chunks: [{ id: "c0", lines: ["..."] }] }
 * Response: { ok, tgt, src, chunks: [{ id, ok, lines?, provider?, cached?, error? }],
 *             providers: { gemini: n, ... }, cached: n, billedChars: n }
 */

export const TRANSLATE_LIMITS = {
  maxChunks: 10,
  maxLinesPerChunk: 50,
  maxCharsPerChunk: 6000,
  maxLineChars: 600,
  maxBodyBytes: 256 * 1024,
  // Optional translation aids (never translated themselves, not part of the line contract).
  maxGlossaryTerms: 80,
  maxGlossaryTermChars: 60,
  maxGlossaryChars: 2400,
  maxContextLines: 5,
  maxTitleChars: 160,
  maxEpisodeTitleChars: 200,
  maxSynopsisChars: 1000,
}

export const CACHE_TTL_SECONDS = 90 * 24 * 60 * 60
/** Last-resort providers (lower quality) are cached briefly so a better provider can replace them. */
export const FALLBACK_CACHE_TTL_SECONDS = 24 * 60 * 60
export const FALLBACK_PROVIDERS = new Set(['workers-ai'])
const DEFAULT_GEMINI_THINKING_LEVEL = 'low'

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com/v1beta'
const M2M100_MODEL = '@cf/meta/m2m100-1.2b'

/** Default monthly source-character budgets (override with *_MONTHLY_CHARS vars). */
const DEFAULT_BUDGETS = {
  gemini: 3_000_000,
  deepl: 490_000,
  'workers-ai': 1_500_000,
}

const DEFAULT_UPGRADE_TIMEOUT_MS = 15_000
const DEFAULT_TIMEOUTS_MS = {
  gemini: 30_000,
  deepl: 15_000,
  'workers-ai': 8_000,
}

/** Per-isolate fallback when no rate-limit binding is configured. */
const memoryRate = new Map()

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ skipProvider?: boolean, status?: number, kind?: string }} [opts]
   *   skipProvider: stop using this provider for the rest of this request (quota, auth).
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ProviderError'
    this.skipProvider = Boolean(opts.skipProvider)
    this.status = opts.status || 0
    this.kind = opts.kind || 'error'
  }
}

/** Short, secret-free failure text for responses and logs. */
export function scrubMessage(text) {
  return String(text || '')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key]')
    .replace(/([?&](?:key|api_key|auth_key)=)[^&\s"']+/gi, '$1[key]')
    .replace(/(DeepL-Auth-Key\s+)\S+/gi, '$1[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function json(body, status = 200) {
  return Response.json(body, { status })
}

function normLang(raw, { allowAuto = false } = {}) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return allowAuto ? 'auto' : ''
  if (s === 'auto') return allowAuto ? 'auto' : ''
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2,4}))?$/.exec(s)
  if (!m) return ''
  return m[2] ? `${m[1]}-${m[2]}` : m[1]
}

const LANG_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', 'pt-br': 'Brazilian Portuguese', fr: 'French',
  de: 'German', it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)', ar: 'Arabic', hi: 'Hindi', ru: 'Russian', tr: 'Turkish',
  vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', pl: 'Polish', nl: 'Dutch', uk: 'Ukrainian',
  sv: 'Swedish', ro: 'Romanian', el: 'Greek', he: 'Hebrew', fa: 'Persian', ms: 'Malay',
  tl: 'Filipino', cs: 'Czech', hu: 'Hungarian', da: 'Danish', fi: 'Finnish', no: 'Norwegian',
}

function langName(code) {
  if (!code || code === 'auto') return 'the detected source language'
  return LANG_NAMES[code] || LANG_NAMES[code.split('-')[0]] || code
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Provider-independent cache key (same formula as the app's IndexedDB cache). A glossary adds
 * its short hash, so better (name-aware) translations are not masked by older entries while the
 * same show + glossary still shares one entry for everyone. Context lines / synopsis are not
 * part of the key (they follow from the deterministic chunking).
 */
export async function cacheKeyFor(src, tgt, lines, glossaryHash = '') {
  const g = glossaryHash ? `|g:${glossaryHash}` : ''
  return `tr:${await sha256Hex(`${src}|${tgt}|${JSON.stringify(lines)}${g}`)}`
}

function cleanText(raw, max) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * Glossary normalization - the app runs the identical function before hashing, so both sides
 * agree on the cache key: trim/collapse, 2..60 chars, case-insensitive dedupe (first wins),
 * at most 80 terms / 2400 chars in the given order.
 */
export function normalizeGlossary(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  let chars = 0
  for (const raw of list) {
    const term = cleanText(raw, 1000)
    if (term.length < 2 || term.length > TRANSLATE_LIMITS.maxGlossaryTermChars) continue
    const k = term.toLowerCase()
    if (seen.has(k)) continue
    if (out.length >= TRANSLATE_LIMITS.maxGlossaryTerms || chars + term.length > TRANSLATE_LIMITS.maxGlossaryChars) break
    seen.add(k)
    out.push(term)
    chars += term.length
  }
  return out
}

/** 16 hex chars of sha256(JSON(glossary)); '' when there is no glossary. */
export async function glossaryHashOf(glossary) {
  return glossary && glossary.length ? (await sha256Hex(JSON.stringify(glossary))).slice(0, 16) : ''
}

function monthKey(now) {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function chunkChars(lines) {
  return lines.reduce((n, l) => n + l.length, 0)
}

function numVar(env, name, fallback) {
  const n = Number(env?.[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Validate + normalize the request body. Returns { error, status } or { src, tgt, chunks }. */
export function validateTranslateBody(body) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'Body must be JSON' }
  const tgt = normLang(body.tgt)
  if (!tgt) return { status: 400, error: 'Missing or invalid tgt language' }
  const src = normLang(body.src, { allowAuto: true }) || 'auto'
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return { status: 400, error: 'chunks must be a non-empty array' }
  }
  if (body.chunks.length > TRANSLATE_LIMITS.maxChunks) {
    return { status: 413, error: `Too many chunks (max ${TRANSLATE_LIMITS.maxChunks})` }
  }
  const chunks = []
  const seen = new Set()
  for (let i = 0; i < body.chunks.length; i++) {
    const c = body.chunks[i] || {}
    const id = String(c.id ?? i).slice(0, 64)
    if (seen.has(id)) return { status: 400, error: `Duplicate chunk id ${id}` }
    seen.add(id)
    if (!Array.isArray(c.lines) || c.lines.length === 0) {
      return { status: 400, error: `Chunk ${id}: lines must be a non-empty array` }
    }
    if (c.lines.length > TRANSLATE_LIMITS.maxLinesPerChunk) {
      return { status: 413, error: `Chunk ${id}: too many lines (max ${TRANSLATE_LIMITS.maxLinesPerChunk})` }
    }
    const lines = c.lines.map((l) => String(l ?? ''))
    if (lines.some((l) => l.length > TRANSLATE_LIMITS.maxLineChars)) {
      return { status: 413, error: `Chunk ${id}: line too long (max ${TRANSLATE_LIMITS.maxLineChars})` }
    }
    if (chunkChars(lines) > TRANSLATE_LIMITS.maxCharsPerChunk) {
      return { status: 413, error: `Chunk ${id}: too many characters (max ${TRANSLATE_LIMITS.maxCharsPerChunk})` }
    }
    let before
    if (c.before != null) {
      if (!Array.isArray(c.before)) return { status: 400, error: `Chunk ${id}: before must be an array` }
      before = c.before
        .slice(-TRANSLATE_LIMITS.maxContextLines)
        .map((l) => cleanText(l, TRANSLATE_LIMITS.maxLineChars))
        .filter(Boolean)
    }
    chunks.push(before && before.length ? { id, lines, before } : { id, lines })
  }
  const glossary = normalizeGlossary(body.glossary)
  let context
  if (body.context && typeof body.context === 'object') {
    const title = cleanText(body.context.title, TRANSLATE_LIMITS.maxTitleChars)
    const episodeTitle = cleanText(body.context.episodeTitle, TRANSLATE_LIMITS.maxEpisodeTitleChars)
    const synopsis = cleanText(body.context.synopsis, TRANSLATE_LIMITS.maxSynopsisChars)
    if (title || episodeTitle || synopsis) {
      context = {}
      if (title) context.title = title
      if (episodeTitle) context.episodeTitle = episodeTitle
      if (synopsis) context.synopsis = synopsis
    }
  }
  // Optional hint: try this provider first (only reorders configured providers; never forces one
  // that isn't set up, and the rest of the chain still backs it up).
  let provider
  if (body.provider != null && body.provider !== '') {
    provider = String(body.provider).trim().toLowerCase()
    if (!PROVIDERS.some((p) => p.id === provider)) return { status: 400, error: 'Unknown provider' }
  }
  const out = { src, tgt, chunks }
  if (provider) out.provider = provider
  if (glossary.length) out.glossary = glossary
  if (context) out.context = context
  if (body.fast === true) out.fast = true
  return out
}

function withTimeout(ms, fetchImpl, url, init) {
  const ac = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new ProviderError(`timeout after ${ms} ms`, { kind: 'timeout' }))
    }, ms)
  })
  const request = Promise.resolve()
    .then(() => fetchImpl(url, { ...init, signal: ac.signal }))
    .catch((err) => {
      if (ac.signal.aborted) throw new ProviderError(`timeout after ${ms} ms`, { kind: 'timeout' })
      throw new ProviderError(err instanceof Error ? err.message : 'network error', { kind: 'network' })
    })
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer))
}

function promiseTimeout(ms, promise) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError(`timeout after ${ms} ms`, { kind: 'timeout' })), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function httpFailure(provider, status, detail) {
  const quota = status === 429 || status === 456 || /quota|exhausted|rate.?limit/i.test(detail || '')
  const auth = status === 401 || status === 403
  return new ProviderError(`${provider} HTTP ${status}${detail ? `: ${detail.slice(0, 160)}` : ''}`, {
    status,
    skipProvider: quota || auth || status === 400 || status === 404,
    kind: quota ? 'quota' : auth ? 'auth' : 'http',
  })
}

function checkCount(provider, out, n) {
  if (!Array.isArray(out) || out.length !== n || out.some((l) => typeof l !== 'string')) {
    throw new ProviderError(
      `${provider} line-count mismatch (got ${Array.isArray(out) ? out.length : typeof out}, want ${n})`,
      { kind: 'mismatch' },
    )
  }
  return out
}

export function geminiPrompt(src, tgt, n) {
  return [
    `You translate on-screen subtitles (mostly anime, also TV and film) from ${langName(src)} into ${langName(tgt)}.`,
    `You receive a JSON object with "lines": an array of ${n} subtitle cues in playback order.`,
    `Reply with JSON {"lines": [...]} containing EXACTLY ${n} strings: translation i must correspond to input line i.`,
    'Never merge, split, reorder, drop or add lines, even when a sentence continues across cues; translate each cue so it reads naturally on its own while staying consistent with its neighbours.',
    'Keep a line break inside a cue as "\\n" where the original has one.',
    'Style: concise, natural, easy to read quickly; no translator notes, brackets of explanation, quotes or romaji in parentheses.',
    'Keep character names, honorifics (-san, -kun, -chan, -sama, -senpai, -sensei, -dono) and the established romanization of names, places and attack/technique names.',
    'Keep sound descriptions short (e.g. (footsteps)). If a cue is already in the target language or is only a name, symbol or music note, return it unchanged.',
    'The input may also carry context that you must NOT translate or return: "show", "episode" and "synopsis" describe what is being watched (use them only to resolve ambiguity, gender, tone and terminology), and "previousLines" are the source cues just before "lines" (use them only for continuity).',
    'If "names" is present, it lists the official spellings of character, place and term names in the target language: whenever a cue refers to one of them (in any script or romanization), write it exactly as listed.',
  ].join('\n')
}

/** User payload for Gemini: aids first, then the lines to translate. */
export function geminiUserPayload(lines, { context, glossary, before } = {}) {
  const payload = {}
  if (context?.title) payload.show = context.title
  if (context?.episodeTitle) payload.episode = context.episodeTitle
  if (context?.synopsis) payload.synopsis = context.synopsis
  if (glossary?.length) payload.names = glossary
  if (before?.length) payload.previousLines = before
  payload.lines = lines
  return payload
}

/** DeepL `context` (not translated, not billed): show/episode/synopsis, names, previous lines. */
export function deeplContext({ context, glossary, before } = {}) {
  const parts = []
  if (context?.title) parts.push(`Show: ${context.title}.`)
  if (context?.episodeTitle) parts.push(`Episode: ${context.episodeTitle}.`)
  if (context?.synopsis) parts.push(context.synopsis)
  if (glossary?.length) parts.push(`Character and place names: ${glossary.join(', ')}.`)
  if (before?.length) parts.push(before.join('\n'))
  return parts.join('\n').slice(0, 4000)
}

/**
 * Thinking cap for Gemini 3.x (generateContent: generationConfig.thinkingConfig.thinkingLevel).
 * gemini-3.8-flash supports low / medium / high (default medium). GEMINI_THINKING_LEVEL=off omits it.
 */
function geminiThinking(env) {
  const level = String(env.GEMINI_THINKING_LEVEL ?? DEFAULT_GEMINI_THINKING_LEVEL).trim().toLowerCase()
  if (!level || level === 'off' || level === 'default' || level === 'none') return {}
  return { thinkingConfig: { thinkingLevel: level } }
}

/** Gemini generateContent with structured JSON output. */
export async function translateWithGemini(lines, { src, tgt, env, fetchImpl, glossary, context, before }) {
  const key = String(env.GEMINI_API_KEY || '').trim()
  if (!key) throw new ProviderError('GEMINI_API_KEY not set', { skipProvider: true, kind: 'missing' })
  const model = String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim()
  const n = lines.length
  const body = {
    systemInstruction: { parts: [{ text: geminiPrompt(src, tgt, n) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(geminiUserPayload(lines, { context, glossary, before })) }] }],
    generationConfig: {
      ...geminiThinking(env),
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          lines: { type: 'array', items: { type: 'string' }, minItems: n, maxItems: n },
        },
        required: ['lines'],
      },
    },
  }
  const res = await withTimeout(
    numVar(env, 'GEMINI_TIMEOUT_MS', DEFAULT_TIMEOUTS_MS.gemini),
    fetchImpl,
    `${GEMINI_ORIGIN}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    },
  )
  const text = await res.text()
  if (!res.ok) {
    let detail = ''
    try {
      detail = JSON.parse(text)?.error?.message || ''
    } catch {
      detail = text.slice(0, 160)
    }
    throw httpFailure('gemini', res.status, detail)
  }
  let out
  try {
    const parsed = JSON.parse(text)
    const cand = parsed?.candidates?.[0]
    const raw = (cand?.content?.parts || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
    if (!raw) {
      throw new ProviderError(`gemini empty response (${cand?.finishReason || parsed?.promptFeedback?.blockReason || 'no candidate'})`, { kind: 'empty' })
    }
    out = JSON.parse(raw)?.lines
  } catch (err) {
    if (err instanceof ProviderError) throw err
    throw new ProviderError('gemini returned invalid JSON', { kind: 'bad-json' })
  }
  return checkCount('gemini', out, n)
}

function deeplTarget(tgt) {
  const t = tgt.toLowerCase()
  if (t === 'en' || t === 'en-us') return 'EN-US'
  if (t === 'en-gb') return 'EN-GB'
  if (t === 'pt' || t === 'pt-br') return 'PT-BR'
  if (t === 'pt-pt') return 'PT-PT'
  if (t === 'zh' || t === 'zh-hans' || t === 'zh-cn') return 'ZH-HANS'
  if (t === 'zh-hant' || t === 'zh-tw') return 'ZH-HANT'
  if (t === 'no' || t === 'nb') return 'NB'
  return t.split('-')[0].toUpperCase()
}

function deeplSource(src) {
  if (!src || src === 'auto') return ''
  const s = src.split('-')[0].toLowerCase()
  return s === 'no' ? 'NB' : s.toUpperCase()
}

export function deeplEndpoint(key) {
  return /:fx$/i.test(key) ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate'
}

/** Secret-free attempt detail: which DeepL API tier ("free" for :fx keys, else "pro"). */
function providerDetail(id, env) {
  if (id !== 'deepl') return {}
  return { endpoint: /:fx$/i.test(String(env.DEEPL_API_KEY || '').trim()) ? 'free' : 'pro' }
}

export async function translateWithDeepL(lines, { src, tgt, env, fetchImpl, glossary, context, before }) {
  const key = String(env.DEEPL_API_KEY || '').trim()
  if (!key) throw new ProviderError('DEEPL_API_KEY not set', { skipProvider: true, kind: 'missing' })
  const payload = {
    text: lines,
    target_lang: deeplTarget(tgt),
    preserve_formatting: true,
    split_sentences: 'nonewlines',
  }
  const source = deeplSource(src)
  if (source) payload.source_lang = source
  const ctx = deeplContext({ context, glossary, before })
  if (ctx) payload.context = ctx
  const res = await withTimeout(
    numVar(env, 'DEEPL_TIMEOUT_MS', DEFAULT_TIMEOUTS_MS.deepl),
    fetchImpl,
    deeplEndpoint(key),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify(payload),
    },
  )
  const text = await res.text()
  if (!res.ok) {
    let detail = ''
    try {
      detail = JSON.parse(text)?.message || ''
    } catch {
      detail = text.slice(0, 160)
    }
    throw httpFailure('deepl', res.status, detail)
  }
  let out
  try {
    out = (JSON.parse(text)?.translations || []).map((t) => t?.text)
  } catch {
    throw new ProviderError('deepl returned invalid JSON', { kind: 'bad-json' })
  }
  return checkCount('deepl', out, lines.length)
}

/**
 * Workers AI m2m100: one call per non-empty line (the model has no line-array contract).
 * Needs a known source language - skipped for src "auto".
 */
export async function translateWithWorkersAi(lines, { src, tgt, env, state }) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new ProviderError('AI binding not configured', { skipProvider: true, kind: 'missing' })
  }
  if (!src || src === 'auto') {
    throw new ProviderError('workers-ai needs a known source language', { kind: 'no-source' })
  }
  const maxCalls = numVar(env, 'AI_MAX_CALLS_PER_REQUEST', 45)
  const need = lines.filter((l) => l.trim()).length
  if ((state.aiCalls || 0) + need > maxCalls) {
    throw new ProviderError('workers-ai per-request call budget used up', { kind: 'limit' })
  }
  state.aiCalls = (state.aiCalls || 0) + need
  const timeout = numVar(env, 'AI_TIMEOUT_MS', DEFAULT_TIMEOUTS_MS['workers-ai'])
  const source = src.split('-')[0]
  const target = tgt.split('-')[0]
  const out = new Array(lines.length)
  let next = 0
  const worker = async () => {
    while (next < lines.length) {
      const i = next++
      const line = lines[i]
      if (!line.trim()) {
        out[i] = line
        continue
      }
      // Translate each visual row separately so in-cue line breaks survive.
      const rows = line.split('\n')
      const done = []
      for (const row of rows) {
        if (!row.trim()) {
          done.push(row)
          continue
        }
        let r
        try {
          r = await promiseTimeout(timeout, env.AI.run(M2M100_MODEL, { text: row, source_lang: source, target_lang: target }))
        } catch (err) {
          if (err instanceof ProviderError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          throw new ProviderError(`workers-ai: ${msg.slice(0, 160)}`, {
            skipProvider: /limit|quota|neuron|4006|3036|capacity/i.test(msg),
            kind: /limit|quota|neuron|4006|3036/i.test(msg) ? 'quota' : 'error',
          })
        }
        const t = r?.translated_text ?? r?.result?.translated_text
        if (typeof t !== 'string') throw new ProviderError('workers-ai returned no text', { kind: 'bad-json' })
        done.push(t)
      }
      out[i] = done.join('\n')
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, lines.length) }, worker))
  return checkCount('workers-ai', out, lines.length)
}

export const PROVIDERS = [
  { id: 'gemini', available: (env) => Boolean(String(env.GEMINI_API_KEY || '').trim()), run: translateWithGemini },
  { id: 'deepl', available: (env) => Boolean(String(env.DEEPL_API_KEY || '').trim()), run: translateWithDeepL },
  { id: 'workers-ai', available: (env) => Boolean(env.AI && typeof env.AI.run === 'function'), run: translateWithWorkersAi },
]

export function availableProviders(env) {
  return PROVIDERS.filter((p) => p.available(env || {})).map((p) => p.id)
}

async function rateLimited(request, env, now) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown'
  const key = `translate:${ip}`
  if (env.TRANSLATE_RATE_LIMITER && typeof env.TRANSLATE_RATE_LIMITER.limit === 'function') {
    try {
      const { success } = await env.TRANSLATE_RATE_LIMITER.limit({ key })
      return !success
    } catch {
      /* binding hiccup: fall through to the in-memory window */
    }
  }
  const limit = numVar(env, 'TRANSLATE_RATE_PER_MIN', 40)
  const windowStart = now - 60_000
  const hits = (memoryRate.get(key) || []).filter((t) => t > windowStart)
  if (hits.length >= limit) {
    memoryRate.set(key, hits)
    return true
  }
  hits.push(now)
  memoryRate.set(key, hits)
  if (memoryRate.size > 5000) memoryRate.clear()
  return false
}

/** Test hook: forget the in-memory rate window. */
export function __resetRateLimit() {
  memoryRate.clear()
}

async function kvGetJson(kv, key) {
  if (!kv) return null
  try {
    return await kv.get(key, 'json')
  } catch {
    return null
  }
}

/**
 * Core translate logic (exported for unit tests).
 * @param {{src: string, tgt: string, chunks: {id: string, lines: string[]}[]}} input
 * @param {object} env
 * @param {{ fetchImpl?: typeof fetch, now?: number, waitUntil?: (p: Promise<unknown>) => void, providers?: typeof PROVIDERS }} [deps]
 */
export async function translateChunks(input, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a))
  const now = deps.now ?? Date.now()
  const providers = deps.providers || PROVIDERS
  const kv = env.TRANSLATE_CACHE || null
  const pending = []
  const defer = (p) => {
    const safe = Promise.resolve(p).catch(() => undefined)
    if (deps.waitUntil) deps.waitUntil(safe)
    else pending.push(safe)
  }
  const { src, tgt } = input
  const month = monthKey(now)

  const results = new Map()
  const misses = []
  // Provider priority = order in the chain (0 = best). Unknown / legacy entries rank last.
  const configured = providers.filter((p) => p.available(env))
  // fast: answer with DeepL now (sub-second) and let Gemini upgrade the cache in the background.
  const fastUpgrade =
    input.fast === true &&
    configured.some((p) => p.id === 'deepl') &&
    configured.some((p) => p.id === 'gemini')
  const hintId = fastUpgrade ? 'deepl' : input.provider
  const hinted = hintId ? configured.find((p) => p.id === hintId) : undefined
  const usable = hinted ? [hinted, ...configured.filter((p) => p !== hinted)] : configured
  const glossary = Array.isArray(input.glossary) ? input.glossary : []
  const glossaryHash = await glossaryHashOf(glossary)
  const aids = { glossary, context: input.context }
  const tierOf = (id) => {
    const i = providers.findIndex((p) => p.id === id)
    return i < 0 ? providers.length : i
  }
  const bestTier = usable.length ? Math.min(...usable.map((p) => tierOf(p.id))) : providers.length
  await Promise.all(
    input.chunks.map(async (chunk) => {
      const key = await cacheKeyFor(src, tgt, chunk.lines, glossaryHash)
      const hit = await kvGetJson(kv, key)
      if (hit && Array.isArray(hit.lines) && hit.lines.length === chunk.lines.length) {
        const hitTier = tierOf(hit.provider)
        const cachedResult = { id: chunk.id, ok: true, lines: hit.lines, provider: hit.provider || 'cache', cached: true }
        // Only last-resort (fallback / unknown) entries are upgraded; a DeepL hit is good enough
        // and must not cost a Gemini call (and its latency) on every read.
        const upgradable = FALLBACK_PROVIDERS.has(hit.provider) || hitTier >= providers.length
        if (upgradable && hitTier > bestTier) {
          // Cached from a fallback provider while a better one is configured: try to upgrade,
          // keep the cached lines if the better providers fail.
          misses.push({ ...chunk, key, maxTier: hitTier, fallbackResult: cachedResult })
        } else {
          results.set(chunk.id, cachedResult)
        }
      } else {
        misses.push({ ...chunk, key })
      }
    }),
  )

  // Load monthly budgets once per request for the providers that could run.
  const budget = {}
  const spent = {}
  for (const p of usable) {
    const used = misses.length ? Number(await kvGetJson(kv, `budget:${p.id}:${month}`)) || 0 : 0
    budget[p.id] = { used, limit: numVar(env, `${p.id.replace('-', '_').toUpperCase()}_MONTHLY_CHARS`, DEFAULT_BUDGETS[p.id] || 1_000_000) }
    spent[p.id] = 0
  }

  const state = { skipped: new Map(), aiCalls: 0 }
  const counts = {}
  const fallbackTtl = numVar(env, 'FALLBACK_CACHE_TTL_SECONDS', FALLBACK_CACHE_TTL_SECONDS)
  // Upgrading a cached fallback entry is opportunistic: we already have lines to return, so
  // don't make the viewer wait the full provider timeout for it.
  const upgradeTimeout = numVar(env, 'UPGRADE_TIMEOUT_MS', DEFAULT_UPGRADE_TIMEOUT_MS)
  const upgradeEnv = { ...env, GEMINI_TIMEOUT_MS: upgradeTimeout, DEEPL_TIMEOUT_MS: upgradeTimeout }

  const translateOne = async (chunk) => {
    const chars = chunkChars(chunk.lines)
    const attempts = []
    const candidates = usable.filter((p) => chunk.maxTier == null || tierOf(p.id) < chunk.maxTier)
    for (const p of candidates) {
      if (state.skipped.has(p.id)) {
        attempts.push({ provider: p.id, ok: false, kind: 'skipped', message: scrubMessage(state.skipped.get(p.id)) })
        continue
      }
      const b = budget[p.id]
      if (b.used + spent[p.id] + chars > b.limit) {
        attempts.push({ provider: p.id, ok: false, kind: 'budget', message: 'monthly budget reached' })
        state.skipped.set(p.id, 'monthly budget reached')
        continue
      }
      const t0 = Date.now()
      try {
        const runOpts = { src, tgt, env: chunk.fallbackResult ? upgradeEnv : env, fetchImpl, state, ...aids, before: chunk.before }
        const lines = await p.run(chunk.lines, runOpts)
        spent[p.id] += chars
        counts[p.id] = (counts[p.id] || 0) + 1
        attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0, ...providerDetail(p.id, env) })
        const gBudget = budget.gemini
        const geminiAffordable =
          !state.skipped.has('gemini') && (!gBudget || gBudget.used + spent.gemini + chars <= gBudget.limit)
        if (fastUpgrade && p.id === 'deepl' && !chunk.fallbackResult && geminiAffordable) {
          // Not cached: the background Gemini result becomes the shared entry instead.
          const gemini = configured.find((x) => x.id === 'gemini')
          defer(
            (async () => {
              const g0 = Date.now()
              try {
                const better = await gemini.run(chunk.lines, { ...runOpts, env })
                if (kv) await kv.put(chunk.key, JSON.stringify({ lines: better, provider: 'gemini', at: now }), { expirationTtl: CACHE_TTL_SECONDS })
                if (kv) {
                  const bkey = `budget:gemini:${month}`
                  const used = Number(await kvGetJson(kv, bkey)) || 0
                  await kv.put(bkey, String(used + chars), { expirationTtl: 40 * 24 * 60 * 60 })
                }
              } catch (err) {
                const msg = scrubMessage(err instanceof Error ? err.message : String(err))
                // Nothing is cached: the client's refresh (sent while the fast text is already on
                // screen) runs the normal Gemini-first chain, so a slow Gemini still gets a 2nd try.
                console.warn(`[translate] background gemini upgrade failed ms=${Date.now() - g0} ${msg}`)
              }
            })(),
          )
          return { id: chunk.id, ok: true, lines, provider: p.id, cached: false, upgradePending: true, attempts }
        }
        if (kv) {
          const ttl = FALLBACK_PROVIDERS.has(p.id) ? fallbackTtl : CACHE_TTL_SECONDS
          defer(kv.put(chunk.key, JSON.stringify({ lines, provider: p.id, at: now }), { expirationTtl: ttl }))
        }
        return { id: chunk.id, ok: true, lines, provider: p.id, cached: false, upgraded: Boolean(chunk.fallbackResult) || undefined, attempts }
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err))
        const message = scrubMessage(e.message)
        attempts.push({ provider: p.id, ok: false, kind: e.kind, status: e.status || undefined, message, ms: Date.now() - t0, ...providerDetail(p.id, env) })
        console.warn(`[translate] ${p.id} failed kind=${e.kind} status=${e.status || '-'} ms=${Date.now() - t0} ${message}`)
        if (e.skipProvider) state.skipped.set(p.id, `${e.kind}: ${message}`)
      }
    }
    if (chunk.fallbackResult) return { ...chunk.fallbackResult, attempts }
    return {
      id: chunk.id,
      ok: false,
      error: usable.length
        ? `All providers failed (${attempts.map((a) => `${a.provider}: ${a.kind}${a.status ? ` ${a.status}` : ''}`).join('; ')})`
        : 'No translation providers configured',
      attempts,
    }
  }

  // Small concurrency so free-tier RPM limits are not hammered.
  let cursor = 0
  const lanes = Math.min(Number(env.TRANSLATE_CONCURRENCY) || 3, misses.length)
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor < misses.length) {
        const chunk = misses[cursor++]
        results.set(chunk.id, await translateOne(chunk))
      }
    }),
  )

  if (kv) {
    for (const id of Object.keys(spent)) {
      if (spent[id] > 0) {
        defer(kv.put(`budget:${id}:${month}`, String(budget[id].used + spent[id]), { expirationTtl: 40 * 24 * 60 * 60 }))
      }
    }
  }
  if (pending.length) await Promise.all(pending)

  const chunks = input.chunks.map((c) => results.get(c.id))
  const billedChars = Object.values(spent).reduce((a, b) => a + b, 0)
  return {
    ok: chunks.every((c) => c && c.ok),
    src,
    tgt,
    chunks,
    providers: counts,
    cached: chunks.filter((c) => c && c.cached).length,
    billedChars,
  }
}

/** HTTP entry for POST /translate (client gate already applied by index.js). */
export async function handleTranslate(request, env, ctx, deps = {}) {
  const now = deps.now ?? Date.now()
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > TRANSLATE_LIMITS.maxBodyBytes) {
    return json({ ok: false, error: 'Request body too large' }, 413)
  }
  if (await rateLimited(request, env, now)) {
    return json({ ok: false, error: 'Rate limited - slow down' }, 429)
  }
  let raw
  try {
    raw = await request.text()
  } catch {
    return json({ ok: false, error: 'Could not read body' }, 400)
  }
  if (raw.length > TRANSLATE_LIMITS.maxBodyBytes) {
    return json({ ok: false, error: 'Request body too large' }, 413)
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ ok: false, error: 'Body must be JSON' }, 400)
  }
  const v = validateTranslateBody(body)
  if (v.error) return json({ ok: false, error: v.error }, v.status)
  if (!availableProviders(env).length && !env.TRANSLATE_CACHE) {
    return json({ ok: false, error: 'No translation providers configured on Worker' }, 503)
  }
  const result = await translateChunks(v, env, {
    ...deps,
    now,
    waitUntil: ctx && typeof ctx.waitUntil === 'function' ? (p) => ctx.waitUntil(p) : deps.waitUntil,
  })
  const anyOk = result.chunks.some((c) => c && c.ok)
  return json(anyOk ? result : { ...result, error: 'Translation unavailable' }, anyOk ? 200 : 503)
}
