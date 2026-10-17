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
- `GET /health` — status + which keys are configured

## Notes

- Worker injects the real keys; clients never see them.
- Soft client filter (`User-Agent` or `X-Jiyu-Client` containing `Jiyu` / Electron) reduces casual scraping — needed because Android often strips custom User-Agent.
- If the worker URL is abused, redeploy under a new name or add Cloudflare rate limits.
- Rotate keys if they were ever in a client build; put only the new keys on the Worker.
