# Jiyu — media center

自由 (jiyū) — a Kodi-style desktop app for browsing **Sports**, **Movies**, **Anime**, **TV Series**, and **News**, then playing the stream you click.

Built with **Electron + React + Vite**. Test on Windows; ship to **Zorin OS** (Linux) with the same codebase.

## Features

- Five category shelves with poster grid browsing
- Local channels (TVJ / CVM) on the home page
- Browse page to search catalog and add M3U / IPTV links
- Picture-in-picture when you leave a stream
- Xtream Codes IPTV providers (server + optional user/password → m3u_plus)
- HLS and MPEG-TS live playback
- Auto-maps `group-title` keywords into sections when possible
- Demo catalog with public test streams so you can verify the player immediately

Use only streams and playlists you have the right to watch. Jiyu does not ship pirate TV sources.

## Quick start (Windows testing)

```bash
npm install
npm run dev:desktop
```

## Build installers

```bash
npm run pack:win
npm run pack:linux
```

## Publish a desktop update (GitHub Releases)

1. Bump `"version"` in `package.json`.
2. Set `GH_TOKEN` (classic PAT with `repo` scope) in the environment.
3. Run `npm run release:win` and/or `npm run release:linux`.
4. Open the draft release on GitHub, confirm assets (`latest.yml` / `latest-linux.yml` + installers), then publish.

Packaged apps check Releases on launch (and via **Jiyu → Check for updates**). Dev mode does not.
