# Jiyu on Roku (first slice)

BrightScript / SceneGraph channel for TCL and other Roku TVs. This is **not** the Android TV or Tizen build.

## What it does

- **Local live:** TVJ (HLS in-channel), Nationwide (`jiyu-nnn` Cloudflare Worker → stays in Jiyu, no PC / no YouTube app), CVM (info only)
- **Live football:** [Futbol-x](https://www.futbol-x.xyz/) JSON → Flussonic signed HLS (no PC bridge)
- PPV embeds / `roku-hls` remain available for older paths but are not the football shelf default

## Test football on a TCL

```powershell
cd D:\app
npm run pack:roku
```

Sideload `release\jiyu-roku.zip` — steps in `docs/install-tvs.md`. OK a Futbol-x card; token refreshes ~every 13 minutes.
