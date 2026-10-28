# jiyu-relay (Samsung / Tizen only)

`https://jiyu-relay.free-river.workers.dev`

The Tizen build is a plain web app, so scraper hosts without CORS headers, CDNs
that need a Referer, and YouTube embeds (Error 153 from a widget origin) fail there.
Desktop (Electron IPC) and Android (CapacitorHttp) fetch natively and never use this.
Client side: `src/lib/tizenRelay.ts` (every helper is a no-op unless `isTizenTv()`).

| Route | What |
| --- | --- |
| `GET/POST /r?u=<url>` | CORS relay. **Allowlisted hosts only** (`DATA_HOSTS`): streamed.pk, ppv.st, subsplease.org, livextv(-backend), i.mjh.nz, epgshare01, fullmatchshows, soccerfull, and YouTube `/@x/live` + `youtubei/v1/{navigation/resolve_url,player}` (the only POSTs). 12 MB cap, cookies dropped, cached 45 s–15 min, ~240 req/min/IP. `X-Relay-Referer` / `X-Relay-UA` carry the headers a browser can't set. |
| `GET /hls?u=&ref=` | HLS playlist fetched with Referer/Origin `ref`. Only allowlisted referers (`HLS_REFERERS`: Movy, Atlantic, Bilibili, Rivestream, Streamo, streamed embeds). Response must be an m3u8; every URI is rewritten to a signed `/seg` URL. |
| `GET /seg?u=&ref=&s=` | HMAC-signed segment/key/sub-playlist, streamed through. Unsigned or tampered URLs are 403, so this is not a free-form video proxy. |
| `GET /yt?v=<id>[&mute=1][&controls=1]` | https YouTube IFrame-API page. Accepts the app's `{event:'command',func,args}` postMessages plus `toggle`, `seekBy`, `volumeBy`; posts `{jiyuYt:1,type:'state'…}` back. |
| `GET /health` | `ok` |

Video bytes only cross the Worker on `/seg`, i.e. referer-locked VOD sources.
IPTV, YouTube and iframe sports embeds stay direct.

## Deploy

```
cd workers/jiyu-relay
wrangler deploy
# once: HMAC key for /seg (never printed)
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | wrangler secret put RELAY_KEY
```

Separate Worker on purpose — deploying it never touches `jiyu` (short links) or `jiyu-sync`.

## Limits / risks

- Workers Free: 100k requests/day (all Workers on the account), 10 ms CPU/request
  (streamed bodies don't count while waiting on I/O). Segment relaying is the
  request hog: one HLS episode ≈ 300–700 requests. Exceeding the daily limit
  returns errors until UTC midnight (doesn't bill on Free).
- Cloudflare's terms restrict using the network to serve video disproportionately
  to HTML; `/seg` is kept to referer-locked sources for that reason. If it becomes
  a problem, delete the `/seg` route — data relay and YouTube keep working.
- Rate limit is per isolate (best effort). Upstream sites may also block Cloudflare
  egress IPs.
