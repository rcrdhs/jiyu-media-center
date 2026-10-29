# Jiyu Roku HLS bridge

PC-side bridge for Roku: sports embeds need a browser (JW/P2P/MSE). Roku has none, so this process captures or proxies media and serves LAN HLS.

## Efficiency model

1. **Sniff first** — if the embed exposes a *real* `.m3u8` (not a decoy), proxy playlists/segments with the right Referer (no ffmpeg).
2. **MSE path** — page posts raw `appendBuffer` bytes to `POST /internal/ingest` on loopback (no base64).
3. **Remux** — one ffmpeg job at a time, **stdin/stdout pipes only** (no temp files on disk).
4. **Serve** — classic MPEG-TS HLS for the Roku `Video` node.

## Run

```powershell
cd D:\app
npm run roku-hls
```

Listens on `0.0.0.0:8791`. Keep it running while the TCL plays sports.

```powershell
npm run pack:roku   # stamps LAN IP into the channel zip
```

Sideload `release\jiyu-roku.zip` — see `docs/install-tvs.md`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/resolve` | `{ "iframe": "https://…" }` → `{ ok, proxiedUrl, mode }` |
| GET | `/api/mse` | MSE→TS playlist / segments (`p=master\|ts`) |
| GET | `/api/hls` | Real-HLS proxy mode |
| POST | `/internal/ingest` | Loopback-only raw fMP4 from the embed page |
| GET | `/health` | Liveness + queue stats |

Needs Chrome or Edge (`PUPPETEER_EXECUTABLE_PATH` if needed).
