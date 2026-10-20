# Jiyu subtitle proxy (Cloudflare Worker)

Holds subtitle API keys on Cloudflare so Android / Tizen / web never ship secrets.

## One-time deploy

```bash
cd workers/jiyu-wyzie
npx wrangler login          # or: npx wrangler deploy --temporary  (claim within 60 min)
npx wrangler deploy
npx wrangler secret put WYZIE_API_KEY
# paste the Wyzie key when prompted
npx wrangler secret put OPENSUBTITLES_API_KEY
# optional — free key from https://www.opensubtitles.com/en/consumers
```

Copy the printed URL, e.g. `https://jiyu-wyzie.<account>.workers.dev`

## Point Jiyu at it

In repo-root `.env` (gitignored):

```
WYZIE_PROXY_URL=https://jiyu-wyzie.<you>.workers.dev
```

Desktop also keeps `WYZIE_API_KEY` / `OPENSUBTITLES_API_KEY` for Electron IPC (preferred when present).
Android / Tizen / Vite builds use `WYZIE_PROXY_URL` only (safe to bake — no secrets).

## Endpoints

- `GET /search` — Wyzie (primary)
- `GET /opensubtitles?id=&season=&episode=` — OpenSubtitles (secondary)
- `POST /translate` - subtitle line translation (Gemini -> DeepL -> Workers AI)
- `GET /health` — status + which keys are configured

## Notes

- Worker injects the real keys; clients never see them.
- Soft client filter (`User-Agent` or `X-Jiyu-Client` containing `Jiyu` / Electron) reduces casual scraping — needed because Android often strips custom User-Agent.
- If the worker URL is abused, redeploy under a new name or add Cloudflare rate limits.
- Rotate keys if they were ever in a client build; put only the new keys on the Worker.

## Subtitle translation (`POST /translate`)

The apps send already-parsed subtitle lines in chunks; the Worker translates them with the
first provider that is configured and works, and caches the result. Clients never see a key.

Provider chain (each one is optional and only used when its secret / binding exists):

1. **Gemini** - secret `GEMINI_API_KEY`, model from the `GEMINI_MODEL` var (default `gemini-3.8-flash`).
2. **DeepL** - secret `DEEPL_API_KEY`. Keys ending in `:fx` use `api-free.deepl.com`, others `api.deepl.com`.
3. **Cloudflare Workers AI** `@cf/meta/m2m100-1.2b` - the `[ai]` binding (needs a known source language).

A provider is skipped for a chunk on: missing key, HTTP error, 429 / 456 / quota, timeout,
invalid JSON, or a line-count mismatch (it must return exactly one line per input line).
Quota/auth errors also skip that provider for the rest of the request.

### One-time setup

```bash
cd workers/jiyu-wyzie
# 1. KV namespace for the translation cache + monthly budget counters
npx wrangler kv namespace create TRANSLATE_CACHE
#    -> paste the printed id into wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID)

# 2. Provider keys (any subset; Workers AI needs no key)
npx wrangler secret put GEMINI_API_KEY    # Google AI Studio -> Get API key
npx wrangler secret put DEEPL_API_KEY     # optional, DeepL account -> API Keys

# 3. Deploy (Wrangler >= 4.36 for the [[ratelimits]] binding)
npx wrangler deploy

# 4. Check
curl -H "X-Jiyu-Client: JiyuMedia" https://jiyu-wyzie.<account>.workers.dev/health
#    -> "translateProviders": ["gemini","deepl","workers-ai"], "hasTranslateCache": true
```

### Request / response

```json
POST /translate
{ "src": "ja", "tgt": "en", "chunks": [{ "id": "c0", "lines": ["...", "..."] }] }

{ "ok": true, "src": "ja", "tgt": "en",
  "chunks": [{ "id": "c0", "ok": true, "lines": ["...", "..."], "provider": "gemini", "cached": false }],
  "providers": { "gemini": 1 }, "cached": 0, "billedChars": 812 }
```

- `src` may be `auto` (Workers AI is skipped then). `tgt` is required.
- Limits: 10 chunks per request, 50 lines and 6,000 characters per chunk, 600 per line,
  256 KiB body -> `413` beyond that. Rate limit -> `429`. No chunk translated -> `503`.
- Cache key: `tr:` + sha256(`src|tgt|JSON(lines)`), provider-independent, 90-day TTL.
- Cache tiers: entries store the provider. Workers AI (fallback) results live 1 day
  (`FALLBACK_CACHE_TTL_SECONDS`); Gemini/DeepL 90 days. A cached fallback (Workers AI) result — not a DeepL one — is re-tried
  with the better providers when they are configured and overwritten if they succeed;
  otherwise the cached lines are returned. That retry
  uses the short `UPGRADE_TIMEOUT_MS` (default 15 s) so a cache hit never waits the full timeout. The apps keep fallback results in memory only.
- Every chunk carries `attempts: [{ provider, ok, kind, status, message, ms }]` (secret-free,
  message <= 200 chars); failures are also `console.warn`ed, so `npx wrangler tail` shows them.
- Optional request field `provider` (`gemini` | `deepl` | `workers-ai`) tries that configured
  provider first; the rest of the chain still backs it up. Unknown names -> 400. DeepL attempts
  report `endpoint: "free" | "pro"`.
- Gemini thinking is capped with `GEMINI_THINKING_LEVEL` (default `low`; `off` = model default).
- Monthly budgets (soft, KV): `GEMINI_MONTHLY_CHARS`, `DEEPL_MONTHLY_CHARS`,
  `WORKERS_AI_MONTHLY_CHARS` vars. When a budget is reached the next provider is used.

### Tests

```bash
node --test workers/jiyu-wyzie/test/translate.test.mjs
```

Mocked providers only - the tests never call Gemini, DeepL or Workers AI.
