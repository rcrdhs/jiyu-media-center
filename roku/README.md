# Jiyu on Roku (first slice)

BrightScript / SceneGraph channel for TCL and other Roku TVs. This is **not** the Android TV or Tizen build.

## What it does

- **Local live:** TVJ (HLS in-channel), Nationwide (`jiyu-nnn` Cloudflare Worker → stays in Jiyu, no PC / no YouTube app), CVM (info only)
- **Live football:** cards from `api.ppv.st`; play goes through `services/roku-hls` on your PC

## Test football on a TCL

```powershell
cd D:\app
npm run roku-hls          # leave running
npm run pack:roku         # stamps this PC's LAN IP into the channel
```

Sideload `release\jiyu-roku.zip` — steps in `docs/install-tvs.md`.
