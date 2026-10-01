# Jiyu Wyzie proxy (Cloudflare Worker)

Holds `WYZIE_API_KEY` on Cloudflare so Android / Tizen / web never ship the key.

## One-time deploy

```bash
cd workers/jiyu-wyzie
npx wrangler login          # or: npx wrangler deploy --temporary  (claim within 60 min)
npx wrangler deploy
npx wrangler secret put WYZIE_API_KEY
# paste the Wyzie key when prompted
```

Copy the printed URL, e.g. `https://jiyu-wyzie.<account>.workers.dev`

## Point Jiyu at it

In repo-root `.env` (gitignored):

```
WYZIE_PROXY_URL=https://jiyu-wyzie.<you>.workers.dev
```

Desktop also keeps `WYZIE_API_KEY` for Electron IPC (preferred when present).
Android / Tizen / Vite builds use `WYZIE_PROXY_URL` only (safe to bake — no Wyzie secret).

## Notes

- Worker injects the real key; clients never see it.
- Soft `User-Agent` filter (`Jiyu` / Electron) reduces casual scraping of the URL.
- If the worker URL is abused, redeploy under a new name or add Cloudflare rate limits.
- Rotate the Wyzie key if it was ever in a client build; put only the new key on the Worker.
