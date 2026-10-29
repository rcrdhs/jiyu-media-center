# jiyu-relay (Samsung / Tizen only)

`https://jiyu-relay.free-river.workers.dev`

The Tizen build is a plain web app, so scraper hosts without CORS headers, CDNs
that need a Referer, and YouTube embeds (Error 153 from a widget origin) fail there.
Desktop (Electron IPC) and Android (CapacitorHttp) fetch natively and never use this.
Client side: `src/lib/tizenRelay.ts` (every helper is a no-op unless `isTizenTv()`).

| Route | What |
| --- | --- |
| `GET/POST /r?u=<url>` | CORS relay. **Allowlisted hosts only** (`DATA_HOSTS`): streamed.pk, ppv.st, subsplease.org, livextv(-backend), i.mjh.nz, epgshare01, fullmatchshows, soccerfull, and YouTube `/@x/live` + `youtubei/v1/{navigation/resolve_url,player}` (the only POSTs). 12 MB cap, cookies dropped, cached 45 s–15 min, ~240 req/min/IP. `X-Relay-Referer` / `X-Relay-UA` carry the headers a browser can't set. Movy `api.wecollege.net` is **not** relayed here (CF egress is rate-limited / seed-IP-bound) — Samsung uses the LAN `roku-hls` `/api/movy` bridge instead; HLS playlists still use `/hls` below. |
| `GET /hls?u=&ref=` | HLS playlist fetched with Referer/Origin `ref`. Only allowlisted referers (`HLS_REFERERS`: Movy, Atlantic, Bilibili, Rivestream, streamed embeds). With an Atlantic referer the entry playlist host must be a Helios/Aphrodite host (ATLANTIC_HLS_HOSTS). Response must be an m3u8; every URI is rewritten to a signed `/seg` URL. |
| `GET /seg?u=&ref=&s=` | HMAC-signed segment/key/sub-playlist, streamed through. Unsigned or tampered URLs are 403, so this is not a free-form video proxy. |
| `GET /hls?u=<iptv>[&ref=]` (IPTV mode) | Only for `IPTV_HOSTS` (jmp2.uk/Pluto, amagi). Not relayable, so left direct: raw-IP streams (Cloudflare blocks Worker fetches to bare IPs, error 1003) and tv5monde (its Akamai edge 403s Cloudflare egress). The client only uses it on Tizen after a direct CORS probe fails. `ref` must be empty, an IPTV host, or the same site as the stream. Media segments stay **direct** when their CDN already sends `ACAO: *` (Pluto, amagi); otherwise they go through signed `/seg?…&m=i`. Edge-cached: live playlists 3 s, VOD 300 s, segments 120 s (≤25 MB), so several TVs on one channel share fetches. |
| `GET /x?u=<embed>` | Server-side HLS extraction for embeds that refuse to frame from `file://` (`frame-ancestors`): vidara(a).cc/to `/v/` `/e/` codes and playmate. Returns `{ok,url,kind,referer}`; the app plays it natively (and through `/hls` when referer-locked). 60 req/min/IP. |
| `GET /yt?v=<id>[&mute=1][&controls=1]` | https YouTube IFrame-API page. Accepts the app's `{event:'command',func,args}` postMessages plus `toggle`, `seekBy`, `volumeBy`; posts `{jiyuYt:1,type:'state'…}` back. |
| `GET /health` | `ok` |

Video bytes only cross the Worker on `/seg`: referer-locked VOD sources, and the
few IPTV CDNs that send no usable CORS header. YouTube and iframe sports embeds stay
direct; IPTV stays direct whenever the TV can play it without the relay.

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
- IPTV cost: playlist-only mode (Pluto/amagi) ≈ 1 request per 2–6 s per viewer
  (600–1,800/hour); full `/seg` mode (CDNs without open CORS) adds one per segment
  (≈ 600–1,800 more/hour). One viewer watching 4 h/day of `/seg` IPTV ≈ 7–15k
  requests — within Free, but ~10 such viewers would exhaust 100k/day. Edge caching
  collapses viewers of the same channel onto one upstream fetch per TTL, though
  each viewer's request still counts.
- Cloudflare's terms restrict using the network to serve video disproportionately
  to HTML; `/seg` is kept to referer-locked sources and CORS-blocked IPTV CDNs
  (allowlist, Tizen only, only after a direct probe fails) for that reason. If it
  becomes a problem, delete the `/seg` route (or the IPTV branch of `/hls`) — data
  relay, `/x` and YouTube keep working, and IPTV falls back to direct playback.
- Rate limit is per isolate (best effort). Upstream sites may also block Cloudflare
  egress IPs.
- `/hls` flattens a nested master (a variant that is itself a master, e.g. the
  transcode.cfd proxy behind Atlantic/Helios) — hls.js would otherwise loop on it.
- Movy seed/sources must not use this Worker: Cloudflare egress is permanently
  rate-limited by api.wecollege.net, and seeds are bound to the minting IP.
  Samsung resolves Movy via `roku-hls` `GET /api/movy?u=…` on the LAN PC (same
  bridge as Roku football). Playlists/segments still use `/hls` + `/seg` with
  the movy.sx Referer.
