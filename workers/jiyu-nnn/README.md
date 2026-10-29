# jiyu-nnn — Nationwide YouTube live for Roku

`https://jiyu-nnn.free-river.workers.dev/live.m3u8`

Resolves the hardcoded NNN livestream page (`@nnn-RADIOLIVE/live`) to a
googlevideo HLS master (VISIONOS Innertube + visitorData), then **proxies**
playlists and segments so Roku can play **inside Jiyu** with:

- no PC `roku-hls` bridge
- no jump to the YouTube app

| Route | What |
| --- | --- |
| `GET /live.m3u8` (also `/`, `/nnn`) | Rewritten master playlist |
| `GET /p?u=<url>` | Allowlisted googlevideo / youtube proxy |
| `GET /health` | Status |

Short link (optional): `https://jiyu.free-river.workers.dev/nnn` redirects here
after `jiyu-get` is redeployed.

## Deploy

```powershell
cd D:\app\workers\jiyu-nnn
npx wrangler deploy
```

## Roku

Nationwide card uses this URL as plain HLS (`kind: hls`). Keep the worker
deployed; the PC bridge is not required for this card.

## Notes

- Resolve is cached ~45s in the isolate.
- YouTube may still block some Cloudflare egress IPs; if `/live.m3u8` returns
  JSON `{ok:false}`, check `/health` and retry.
- Workers Free request limits apply (live HLS is chatty). Edge `Cache-Control`
  on segments is short on purpose.
