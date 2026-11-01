# Jiyu Roku HLS bridge

Off-TV bridge for Roku sports: embeds need a browser (JW/P2P/MSE). Roku has none, so this process captures or proxies media and serves HLS. Prefer hosting on **Oracle Always Free Ampere** (not a living-room PC).

## Efficiency model

1. **Sniff first** — if the embed exposes a *real* `.m3u8` (not a decoy), proxy playlists/segments with the right Referer (no ffmpeg).
2. **MSE path** — page posts raw `appendBuffer` bytes to `POST /internal/ingest` on loopback (no base64).
3. **Remux** — up to 3 concurrent ffmpeg jobs (temp files on Windows/ARM; system `ffmpeg` preferred on Linux).
4. **Serve** — classic MPEG-TS HLS for the Roku `Video` node.

## Oracle Always Free (Ampere)

1. Create a VM: Ampere shape, Always Free-eligible, ≥12 GB RAM if available, Ubuntu 22.04+.
2. Ingress: TCP **8791** (or 443 via nginx) in the VCN security list + OS firewall.
3. Copy this folder + install deps, then:

```bash
# on the VM (after scp/rsync of services/roku-hls and deploy-oracle.sh)
export ROKU_HLS_TOKEN='…'   # same token stamped into the channel
bash deploy-oracle.sh
```

4. Pack the channel against the public IP:

```powershell
$env:ROKU_HLS_BASE="http://PUBLIC_IP:8791"
$env:ROKU_HLS_TOKEN="…"
npm run pack:roku
```

## Local run (dev)

```powershell
cd D:\app
npm run roku-hls
npm run pack:roku   # stamps LAN IP if ROKU_HLS_BASE unset
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
