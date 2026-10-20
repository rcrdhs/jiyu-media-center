// Unit tests for POST /translate with mocked providers (no real API calls).
// Run: node --test workers/jiyu-wyzie/test/
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import {
  __resetRateLimit,
  cacheKeyFor,
  deeplContext,
  deeplEndpoint,
  glossaryHashOf,
  normalizeGlossary,
  handleTranslate,
  scrubMessage,
  translateChunks,
  validateTranslateBody,
} from '../src/translate.js'

function memoryKv(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    puts: [],
    async get(key, type) {
      const v = map.get(key)
      if (v == null) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key, value, opts) {
      this.puts.push({ key, value, opts })
      map.set(key, value)
    },
  }
}

function geminiOk(lines) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function deeplOk(lines) {
  return Response.json({ translations: lines.map((text) => ({ text })) })
}

/** fetch mock: handlers keyed by "gemini" / "deepl"; records every call. */
function mockFetch(handlers) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    const kind = u.includes('generativelanguage') ? 'gemini' : u.includes('deepl.com') ? 'deepl' : 'other'
    calls.push({ kind, url: u, body, headers: init.headers })
    const h = handlers[kind]
    if (!h) throw new Error(`unexpected fetch ${u}`)
    return h(body, u, calls.filter((c) => c.kind === kind).length)
  }
  fn.calls = calls
  return fn
}

const geminiEcho = (body) => {
  const lines = JSON.parse(body.contents[0].parts[0].text).lines
  return geminiOk(lines.map((l) => `G:${l}`))
}
const deeplEcho = (body) => deeplOk(body.text.map((l) => `D:${l}`))

const input = (chunks, src = 'ja', tgt = 'en') => ({ src, tgt, chunks })

beforeEach(() => __resetRateLimit())

test('validation: 400 for missing tgt, 413 for oversize chunks', () => {
  assert.equal(validateTranslateBody({ chunks: [{ id: 'a', lines: ['x'] }] }).status, 400)
  const many = Array.from({ length: 51 }, (_, i) => `l${i}`)
  assert.equal(validateTranslateBody({ tgt: 'en', chunks: [{ id: 'a', lines: many }] }).status, 413)
  const chunks = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, lines: ['x'] }))
  assert.equal(validateTranslateBody({ tgt: 'en', chunks }).status, 413)
  const big = ['x'.repeat(500)].concat(Array.from({ length: 12 }, () => 'y'.repeat(500)))
  assert.equal(validateTranslateBody({ tgt: 'en', chunks: [{ id: 'a', lines: big }] }).status, 413)
  const ok = validateTranslateBody({ tgt: 'EN', chunks: [{ id: 'a', lines: ['x'] }] })
  assert.equal(ok.tgt, 'en')
  assert.equal(ok.src, 'auto')
})

test('Gemini is used first when it works', async () => {
  const fetchImpl = mockFetch({ gemini: geminiEcho, deepl: deeplEcho })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'd:fx', TRANSLATE_CACHE: memoryKv() }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a', 'b'] }]), env, { fetchImpl })
  assert.equal(r.ok, true)
  assert.deepEqual(r.chunks[0].lines, ['G:a', 'G:b'])
  assert.equal(r.chunks[0].provider, 'gemini')
  assert.equal(fetchImpl.calls.filter((c) => c.kind === 'deepl').length, 0)
  // Gemini request carries the key as a header and asks for structured JSON.
  const g = fetchImpl.calls[0]
  assert.equal(g.headers['x-goog-api-key'], 'g')
  assert.match(g.url, /models\/gemini-3\.8-flash:generateContent$/)
  assert.equal(g.body.generationConfig.responseMimeType, 'application/json')
  assert.equal(g.body.generationConfig.responseJsonSchema.properties.lines.minItems, 2)
})

test('fallback order: Gemini 429 -> DeepL, and Gemini is skipped for the rest of the request', async () => {
  const fetchImpl = mockFetch({
    gemini: () => new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), { status: 429 }),
    deepl: deeplEcho,
  })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'd:fx', TRANSLATE_CONCURRENCY: '1' }
  const r = await translateChunks(
    input([
      { id: 'c0', lines: ['a'] },
      { id: 'c1', lines: ['b'] },
    ]),
    env,
    { fetchImpl },
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.chunks.map((c) => c.provider), ['deepl', 'deepl'])
  assert.deepEqual(r.chunks[1].lines, ['D:b'])
  assert.equal(fetchImpl.calls.filter((c) => c.kind === 'gemini').length, 1)
  assert.deepEqual(r.providers, { deepl: 2 })
})

test('line-count mismatch from Gemini falls through to DeepL', async () => {
  const fetchImpl = mockFetch({
    gemini: () => geminiOk(['merged a+b']),
    deepl: deeplEcho,
  })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'd' }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a', 'b'] }]), env, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'deepl')
  assert.deepEqual(r.chunks[0].lines, ['D:a', 'D:b'])
  // Pro key (no :fx) -> pro endpoint; ja source + EN-US target.
  const d = fetchImpl.calls.find((c) => c.kind === 'deepl')
  assert.equal(d.url, 'https://api.deepl.com/v2/translate')
  assert.equal(d.body.source_lang, 'JA')
  assert.equal(d.body.target_lang, 'EN-US')
  assert.equal(d.headers.Authorization, 'DeepL-Auth-Key d')
})

test('DeepL endpoint autodetect from :fx suffix', () => {
  assert.equal(deeplEndpoint('abc:fx'), 'https://api-free.deepl.com/v2/translate')
  assert.equal(deeplEndpoint('abc'), 'https://api.deepl.com/v2/translate')
})

test('Gemini + DeepL fail (timeout / 456) -> Workers AI m2m100', async () => {
  const fetchImpl = mockFetch({
    gemini: () => new Promise(() => {}), // never resolves -> timeout
    deepl: () => new Response(JSON.stringify({ message: 'Quota exceeded' }), { status: 456 }),
  })
  const aiCalls = []
  const env = {
    GEMINI_API_KEY: 'g',
    GEMINI_TIMEOUT_MS: '30',
    DEEPL_API_KEY: 'd:fx',
    AI: {
      async run(model, args) {
        aiCalls.push({ model, args })
        return { translated_text: `AI:${args.text}` }
      },
    },
  }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a', 'b\nc', ''] }]), env, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'workers-ai')
  assert.deepEqual(r.chunks[0].lines, ['AI:a', 'AI:b\nAI:c', ''])
  assert.equal(aiCalls[0].model, '@cf/meta/m2m100-1.2b')
  assert.equal(aiCalls[0].args.source_lang, 'ja')
  assert.equal(aiCalls[0].args.target_lang, 'en')
})

test('Workers AI is skipped for src=auto; nothing works -> chunk error', async () => {
  const env = { AI: { run: async () => ({ translated_text: 'x' }) } }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a'] }], 'auto'), env, { fetchImpl: mockFetch({}) })
  assert.equal(r.ok, false)
  assert.equal(r.chunks[0].ok, false)
  assert.match(r.chunks[0].error, /workers-ai: no-source/)
  assert.equal(r.chunks[0].attempts[0].provider, 'workers-ai')
  assert.match(r.chunks[0].attempts[0].message, /needs a known source language/)
})

test('cache hit: second request is served from KV, provider-independent key, no provider calls', async () => {
  const kv = memoryKv()
  const env = { GEMINI_API_KEY: 'g', TRANSLATE_CACHE: kv }
  const f1 = mockFetch({ gemini: geminiEcho })
  const r1 = await translateChunks(input([{ id: 'c0', lines: ['a', 'b'] }]), env, { fetchImpl: f1 })
  assert.equal(r1.chunks[0].cached, false)
  const key = await cacheKeyFor('ja', 'en', ['a', 'b'])
  assert.ok(kv.map.has(key), 'cache entry written under sha256(src|tgt|lines)')
  const put = kv.puts.find((p) => p.key === key)
  assert.equal(put.opts.expirationTtl, 90 * 24 * 60 * 60)
  assert.ok(kv.map.has(`budget:gemini:${new Date().toISOString().slice(0, 7)}`), 'budget counter written')

  // Different provider set (DeepL only) still reuses Gemini's cached result.
  const f2 = mockFetch({})
  const r2 = await translateChunks(input([{ id: 'x', lines: ['a', 'b'] }]), { DEEPL_API_KEY: 'd', TRANSLATE_CACHE: kv }, { fetchImpl: f2 })
  assert.equal(r2.chunks[0].cached, true)
  assert.equal(r2.chunks[0].provider, 'gemini')
  assert.deepEqual(r2.chunks[0].lines, ['G:a', 'G:b'])
  assert.equal(f2.calls.length, 0)
  assert.equal(r2.cached, 1)
})

test('monthly budget reached -> next provider', async () => {
  const month = new Date().toISOString().slice(0, 7)
  const kv = memoryKv({ [`budget:gemini:${month}`]: '2999999' })
  const fetchImpl = mockFetch({ gemini: geminiEcho, deepl: deeplEcho })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'd', TRANSLATE_CACHE: kv }
  const r = await translateChunks(input([{ id: 'c0', lines: ['hello'] }]), env, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'deepl')
  assert.equal(fetchImpl.calls.filter((c) => c.kind === 'gemini').length, 0)
  assert.equal(kv.map.get(`budget:deepl:${month}`), '5')
})

test('handleTranslate: 503 with no providers and no cache; 429 from rate-limit binding; 413 body', async () => {
  const mk = (body, headers = {}) =>
    new Request('https://w.test/translate', { method: 'POST', body: JSON.stringify(body), headers })
  const body = { src: 'ja', tgt: 'en', chunks: [{ id: 'c0', lines: ['a'] }] }
  let res = await handleTranslate(mk(body), {}, null)
  assert.equal(res.status, 503)
  res = await handleTranslate(mk(body), { GEMINI_API_KEY: 'g', TRANSLATE_RATE_LIMITER: { limit: async () => ({ success: false }) } }, null)
  assert.equal(res.status, 429)
  res = await handleTranslate(mk({ ...body, chunks: [{ id: 'c0', lines: Array(60).fill('x') }] }), { GEMINI_API_KEY: 'g' }, null)
  assert.equal(res.status, 413)
})

test('index.js: gate, CORS preflight allows POST, /translate routed end-to-end', async () => {
  const pre = await worker.fetch(new Request('https://w.test/translate', { method: 'OPTIONS' }), {}, {})
  assert.equal(pre.status, 204)
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/)
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Content-Type/)

  const body = JSON.stringify({ src: 'ja', tgt: 'en', chunks: [{ id: 'c0', lines: ['a'] }] })
  const blocked = await worker.fetch(new Request('https://w.test/translate', { method: 'POST', body, headers: { 'user-agent': 'curl' } }), {}, {})
  assert.equal(blocked.status, 403)

  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch({ deepl: deeplEcho })
  try {
    const waits = []
    const res = await worker.fetch(
      new Request('https://w.test/translate', { method: 'POST', body, headers: { 'X-Jiyu-Client': 'JiyuMedia/test', 'Content-Type': 'application/json' } }),
      { DEEPL_API_KEY: 'k:fx', TRANSLATE_CACHE: memoryKv() },
      { waitUntil: (p) => waits.push(p) },
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*')
    const j = await res.json()
    assert.equal(j.chunks[0].provider, 'deepl')
    assert.deepEqual(j.chunks[0].lines, ['D:a'])
    assert.ok(waits.length >= 1, 'cache/budget writes use ctx.waitUntil')
    await Promise.all(waits)

    const health = await worker.fetch(new Request('https://w.test/health'), { DEEPL_API_KEY: 'k', AI: { run() {} } }, {})
    const h = await health.json()
    assert.deepEqual(h.translateProviders, ['deepl', 'workers-ai'])
  } finally {
    globalThis.fetch = realFetch
  }
})

const aiEcho = () => ({ async run(_model, args) { return { translated_text: `AI:${args.text}` } } })

test('Gemini request caps thinking (low by default, off removes it)', async () => {
  const f = mockFetch({ gemini: geminiEcho })
  await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { GEMINI_API_KEY: 'g' }, { fetchImpl: f })
  assert.deepEqual(f.calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' })
  const f2 = mockFetch({ gemini: geminiEcho })
  await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { GEMINI_API_KEY: 'g', GEMINI_THINKING_LEVEL: 'off' }, { fetchImpl: f2 })
  assert.equal(f2.calls[0].body.generationConfig.thinkingConfig, undefined)
})

test('failure reasons are reported per attempt, secret-free', async () => {
  const fetchImpl = mockFetch({
    gemini: () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid. key=AIzaSyFAKEFAKEFAKEFAKE123 https://x/y?key=AIzaSECRET' } }), { status: 400 }),
  })
  const env = { GEMINI_API_KEY: 'AIzaSyFAKEFAKEFAKEFAKE123', AI: aiEcho() }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), env, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'workers-ai')
  const [g, ai] = r.chunks[0].attempts
  assert.equal(g.provider, 'gemini')
  assert.equal(g.ok, false)
  assert.equal(g.status, 400)
  assert.equal(g.kind, 'http')
  assert.doesNotMatch(JSON.stringify(r), /AIzaSy|AIzaSECRET/)
  assert.ok(g.message.length <= 200)
  assert.equal(ai.ok, true)
  assert.equal(scrubMessage('DeepL-Auth-Key abc:fx failed'), 'DeepL-Auth-Key [key] failed')
})

test('workers-ai results get the short fallback TTL; Gemini results the long one', async () => {
  const kv = memoryKv()
  await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { AI: aiEcho(), TRANSLATE_CACHE: kv }, { fetchImpl: mockFetch({}) })
  const put = kv.puts.find((p) => p.key.startsWith('tr:'))
  assert.equal(JSON.parse(put.value).provider, 'workers-ai')
  assert.equal(put.opts.expirationTtl, 24 * 60 * 60)
})

test('cached workers-ai entry is upgraded by Gemini and overwritten', async () => {
  const key = await cacheKeyFor('ja', 'en', ['a', 'b'])
  const kv = memoryKv({ [key]: JSON.stringify({ lines: ['AI:a', 'AI:b'], provider: 'workers-ai', at: 1 }) })
  const ai = { calls: 0, async run(_m, args) { this.calls++; return { translated_text: `AI2:${args.text}` } } }
  const fetchImpl = mockFetch({ gemini: geminiEcho })
  const r = await translateChunks(input([{ id: 'c0', lines: ['a', 'b'] }]), { GEMINI_API_KEY: 'g', AI: ai, TRANSLATE_CACHE: kv }, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'gemini')
  assert.equal(r.chunks[0].cached, false)
  assert.equal(r.chunks[0].upgraded, true)
  assert.deepEqual(r.chunks[0].lines, ['G:a', 'G:b'])
  assert.equal(ai.calls, 0)
  const stored = JSON.parse(kv.map.get(key))
  assert.equal(stored.provider, 'gemini')
  assert.equal(kv.puts.find((p) => p.key === key).opts.expirationTtl, 90 * 24 * 60 * 60)
})

test('cached workers-ai entry is served when Gemini fails (no repeat workers-ai call)', async () => {
  const key = await cacheKeyFor('ja', 'en', ['a'])
  const kv = memoryKv({ [key]: JSON.stringify({ lines: ['AI:a'], provider: 'workers-ai', at: 1 }) })
  const ai = { calls: 0, async run() { this.calls++; return { translated_text: 'x' } } }
  const fetchImpl = mockFetch({ gemini: () => new Response('{"error":{"message":"busy"}}', { status: 503 }) })
  const r = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { GEMINI_API_KEY: 'g', AI: ai, TRANSLATE_CACHE: kv }, { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.chunks[0].cached, true)
  assert.equal(r.chunks[0].provider, 'workers-ai')
  assert.deepEqual(r.chunks[0].lines, ['AI:a'])
  assert.equal(r.chunks[0].attempts[0].status, 503)
  assert.equal(ai.calls, 0)
  assert.equal(kv.puts.filter((p) => p.key === key).length, 0, 'cache entry untouched')
})

test('cached workers-ai entry is a plain hit when only workers-ai is configured', async () => {
  const key = await cacheKeyFor('ja', 'en', ['a'])
  const kv = memoryKv({ [key]: JSON.stringify({ lines: ['AI:a'], provider: 'workers-ai', at: 1 }) })
  const ai = { calls: 0, async run() { this.calls++; return { translated_text: 'x' } } }
  const r = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { AI: ai, TRANSLATE_CACHE: kv }, { fetchImpl: mockFetch({}) })
  assert.equal(r.chunks[0].cached, true)
  assert.equal(ai.calls, 0)
  assert.equal(r.chunks[0].attempts, undefined)
})

test('upgrade attempts on a cached fallback entry use the short UPGRADE_TIMEOUT_MS', async () => {
  const key = await cacheKeyFor('ja', 'en', ['a'])
  const kv = memoryKv({ [key]: JSON.stringify({ lines: ['AI:a'], provider: 'workers-ai', at: 1 }) })
  const fetchImpl = mockFetch({ gemini: () => new Promise(() => {}) })
  const env = { GEMINI_API_KEY: 'g', GEMINI_TIMEOUT_MS: '60000', UPGRADE_TIMEOUT_MS: '30', AI: aiEcho(), TRANSLATE_CACHE: kv }
  const t0 = Date.now()
  const r = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), env, { fetchImpl })
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(r.chunks[0].cached, true)
  assert.deepEqual(r.chunks[0].lines, ['AI:a'])
  assert.equal(r.chunks[0].attempts[0].kind, 'timeout')
})

test('provider hint: tries the hinted configured provider first; unknown -> 400; reports DeepL tier', async () => {
  const fetchImpl = mockFetch({ gemini: geminiEcho, deepl: deeplEcho })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'k:fx' }
  const r = await translateChunks({ ...input([{ id: 'c0', lines: ['a'] }]), provider: 'deepl' }, env, { fetchImpl })
  assert.equal(r.chunks[0].provider, 'deepl')
  assert.deepEqual(r.chunks[0].attempts.map((a) => [a.provider, a.endpoint]), [['deepl', 'free']])
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].url, /api-free\.deepl\.com/)
  assert.doesNotMatch(JSON.stringify(r), /k:fx/)
  // Hint for a provider that is not configured is ignored (normal order).
  const r2 = await translateChunks({ ...input([{ id: 'c1', lines: ['b'] }]), provider: 'deepl' }, { GEMINI_API_KEY: 'g' }, { fetchImpl })
  assert.equal(r2.chunks[0].provider, 'gemini')
  assert.equal(validateTranslateBody({ tgt: 'en', chunks: [{ lines: ['x'] }], provider: 'nope' }).status, 400)
  assert.equal(validateTranslateBody({ tgt: 'en', chunks: [{ lines: ['x'] }], provider: 'DeepL' }).provider, 'deepl')
})

test('cached DeepL entry is a plain hit even when Gemini is configured (no upgrade call)', async () => {
  const key = await cacheKeyFor('ja', 'en', ['a'])
  const kv = memoryKv({ [key]: JSON.stringify({ lines: ['D:a'], provider: 'deepl', at: 1 }) })
  const fetchImpl = mockFetch({ gemini: geminiEcho })
  const r2 = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'k', TRANSLATE_CACHE: kv }, { fetchImpl })
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(r2.chunks[0].cached, true)
  assert.equal(r2.chunks[0].provider, 'deepl')
  assert.equal(r2.chunks[0].attempts, undefined)
})

test('index.js /opensubtitles language=any: no language filter, ranked by prefer, returns language', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  const row = (fileId, language, dl, extra = {}) => ({ attributes: { language, download_count: dl, release: `rel-${language}`, files: [{ file_id: fileId }], ...extra } })
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), body: init.body })
    if (u.pathname.endsWith('/subtitles')) {
      return Response.json({ data: [row(1, 'zh-CN', 130), row(2, 'pt-BR', 174), row(3, 'de', 46), row(4, 'vi', 62), row(5, 'es', 999, { machine_translated: true })] })
    }
    if (u.pathname.endsWith('/download')) return Response.json({ link: `https://dl.test/${JSON.parse(init.body).file_id}.srt` })
    return new Response('nope', { status: 404 })
  }
  try {
    const env = { OPENSUBTITLES_API_KEY: 'os-key' }
    const req = (q) => new Request(`https://w.test/opensubtitles?${q}`, { headers: { 'X-Jiyu-Client': 'JiyuMedia/test' } })
    const res = await worker.fetch(req('id=237150&season=1&episode=3&language=any&prefer=ja,es,pt,fr,de,zh'), env, {})
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.equal(j.language, 'pt')
    assert.equal(j.subtitleUrl, 'https://dl.test/2.srt')
    assert.equal(j.release, 'rel-pt-BR')
    assert.equal(seen[0].params.languages, undefined, 'no language filter')
    assert.equal(seen[0].params.parent_tmdb_id, '237150')
    assert.doesNotMatch(JSON.stringify(j), /os-key/)
    // Normal (single-language) requests keep the language filter.
    seen.length = 0
    await worker.fetch(req('id=1&language=ja'), env, {})
    assert.equal(seen[0].params.languages, 'ja')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('validation: glossary / context / before are normalized and capped; fast flag kept', () => {
  const v = validateTranslateBody({
    tgt: 'en',
    fast: true,
    glossary: ['  Ars  Louvent ', 'ars louvent', 'x', 'Licia', 7, 'y'.repeat(61), ...Array.from({ length: 100 }, (_, i) => `Name${i}`)],
    context: { title: 'T'.repeat(300), episodeTitle: 'Answer', synopsis: 's'.repeat(5000), junk: 1 },
    chunks: [{ id: 'a', lines: ['x'], before: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] }],
  })
  assert.equal(v.fast, true)
  assert.deepEqual(v.glossary.slice(0, 3), ['Ars Louvent', 'Licia', 'Name0'])
  assert.equal(v.glossary.length, 80)
  assert.equal(v.context.title.length, 160)
  assert.equal(v.context.synopsis.length, 1000)
  assert.equal(v.context.junk, undefined)
  assert.deepEqual(v.chunks[0].before, ['p3', 'p4', 'p5', 'p6', 'p7'])
  assert.equal(validateTranslateBody({ tgt: 'en', chunks: [{ lines: ['x'], before: 'nope' }] }).status, 400)
  const plain = validateTranslateBody({ tgt: 'en', chunks: [{ lines: ['x'] }] })
  assert.equal(plain.glossary, undefined)
  assert.equal(plain.context, undefined)
  assert.equal(plain.fast, undefined)
  assert.deepEqual(normalizeGlossary(normalizeGlossary(v.glossary)), v.glossary, 'idempotent')
})

test('glossary changes the cache key (short hash); no glossary keeps the old key', async () => {
  const base = await cacheKeyFor('ja', 'en', ['a'])
  assert.equal(base, await cacheKeyFor('ja', 'en', ['a'], ''))
  const gh = await glossaryHashOf(['Ars'])
  assert.equal(gh.length, 16)
  assert.equal(await glossaryHashOf([]), '')
  assert.notEqual(await cacheKeyFor('ja', 'en', ['a'], gh), base)
})

test('Gemini gets names, show/episode/synopsis and previous lines as context only', async () => {
  const f = mockFetch({ gemini: geminiEcho })
  const r = await translateChunks(
    { ...input([{ id: 'c0', lines: ['a', 'b'], before: ['p1', 'p2'] }]), glossary: ['Ars Louvent'], context: { title: 'Show', episodeTitle: 'Answer', synopsis: 'Syn' } },
    { GEMINI_API_KEY: 'g' },
    { fetchImpl: f },
  )
  assert.deepEqual(r.chunks[0].lines, ['G:a', 'G:b'])
  const payload = JSON.parse(f.calls[0].body.contents[0].parts[0].text)
  assert.deepEqual(payload, { show: 'Show', episode: 'Answer', synopsis: 'Syn', names: ['Ars Louvent'], previousLines: ['p1', 'p2'], lines: ['a', 'b'] })
  assert.match(f.calls[0].body.systemInstruction.parts[0].text, /"names"/)
  assert.equal(f.calls[0].body.generationConfig.responseJsonSchema.properties.lines.minItems, 2)
})

test('DeepL gets an unbilled context string with names and previous lines', async () => {
  const f = mockFetch({ deepl: deeplEcho })
  const r = await translateChunks(
    { ...input([{ id: 'c0', lines: ['a'], before: ['prev line'] }], 'pt'), glossary: ['Ars Louvent', 'Licia'], context: { title: 'Show' } },
    { DEEPL_API_KEY: 'k:fx' },
    { fetchImpl: f },
  )
  assert.equal(r.chunks[0].provider, 'deepl')
  assert.equal(r.billedChars, 1, 'context is not billed')
  const ctx = f.calls[0].body.context
  assert.match(ctx, /Show: Show\./)
  assert.match(ctx, /Ars Louvent, Licia/)
  assert.match(ctx, /prev line/)
  assert.deepEqual(f.calls[0].body.text, ['a'])
  assert.equal(deeplContext({}), '')
})

test('fast: DeepL answers now, Gemini upgrades the shared cache in the background', async () => {
  const kv = memoryKv()
  const fetchImpl = mockFetch({ gemini: geminiEcho, deepl: deeplEcho })
  const env = { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'k:fx', TRANSLATE_CACHE: kv }
  const waits = []
  const r = await translateChunks({ ...input([{ id: 'c0', lines: ['a'] }]), fast: true }, env, { fetchImpl, waitUntil: (p) => waits.push(p) })
  assert.equal(r.chunks[0].provider, 'deepl')
  assert.equal(r.chunks[0].upgradePending, true)
  assert.deepEqual(r.chunks[0].lines, ['D:a'])
  await Promise.all(waits)
  const key = await cacheKeyFor('ja', 'en', ['a'])
  assert.equal(JSON.parse(kv.map.get(key)).provider, 'gemini')
  // The refresh (normal request) now gets Gemini from cache without calling anyone.
  const before = fetchImpl.calls.length
  const r2 = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), env, { fetchImpl })
  assert.equal(r2.chunks[0].provider, 'gemini')
  assert.equal(r2.chunks[0].cached, true)
  assert.equal(fetchImpl.calls.length, before)
})

test('fast: background Gemini failure caches nothing (the refresh retries Gemini-first); fast without Gemini is a normal request', async () => {
  const kv = memoryKv()
  const fetchImpl = mockFetch({ gemini: () => new Response('{"error":{"message":"busy"}}', { status: 503 }), deepl: deeplEcho })
  const waits = []
  await translateChunks({ ...input([{ id: 'c0', lines: ['a'] }]), fast: true }, { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'k', TRANSLATE_CACHE: kv }, { fetchImpl, waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
  const key = await cacheKeyFor('ja', 'en', ['a'])
  assert.equal(kv.puts.filter((p) => p.key === key).length, 0)
  const geminiCalls = fetchImpl.calls.filter((c) => c.kind === 'gemini').length
  const refresh = await translateChunks(input([{ id: 'c0', lines: ['a'] }]), { GEMINI_API_KEY: 'g', DEEPL_API_KEY: 'k', TRANSLATE_CACHE: kv }, { fetchImpl })
  assert.equal(fetchImpl.calls.filter((c) => c.kind === 'gemini').length, geminiCalls + 1, 'refresh tries Gemini again')
  assert.equal(refresh.chunks[0].provider, 'deepl')

  const kv2 = memoryKv()
  const r = await translateChunks({ ...input([{ id: 'c1', lines: ['b'] }]), fast: true }, { DEEPL_API_KEY: 'k', TRANSLATE_CACHE: kv2 }, { fetchImpl: mockFetch({ deepl: deeplEcho }) })
  assert.equal(r.chunks[0].upgradePending, undefined)
  const put2 = kv2.puts.find((p) => p.key.startsWith('tr:'))
  assert.equal(put2.opts.expirationTtl, 90 * 24 * 60 * 60)
})

test('opensubtitles any-language: original language beats every other language', async () => {
  const { scoreAnyLanguage } = await import('../src/index.js')
  const prefer = ['ja', 'es', 'pt']
  // Original far outranks the best-quality other language (downloads add at most +100).
  assert.ok(scoreAnyLanguage('ja', prefer, 'ja') - 80 - 300 > scoreAnyLanguage('es', prefer, 'ja') + 100)
  assert.equal(scoreAnyLanguage('es', prefer, ''), scoreAnyLanguage('es', prefer))
  assert.ok(scoreAnyLanguage('pt', ['es', 'pt'], 'ko') < scoreAnyLanguage('es', ['es', 'pt'], 'ko'))
})
