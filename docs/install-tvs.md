# Installing Jiyu on TVs

## The short link

```text
https://jiyu.free-river.workers.dev/tv
```

It always sends the TV to the newest release. A small Cloudflare Worker (`workers/jiyu-get`, separate from `jiyu-sync`) handles it:

| Link | Gets |
| --- | --- |
| `/tv` | `Jiyu-TV.apk` from the latest GitHub release. That is the universal APK (arm64 + 32-bit armv7), so it installs on every Android TV, Google TV, and Fire TV, including 32-bit sticks. Until a release carries `Jiyu-TV.apk`, it falls back to the arm64 phone APK. |
| `/tv64`, `/apk`, `/android` | The arm64 APK that `latest-android.yml` points at (phones, Shield, newer Google TV). |
| `/win` | The Windows installer from `latest.yml`. |

The Worker has no bindings and stores nothing. It reads the public release feed. The asset name `Jiyu-TV.apk` never changes, so the link never needs editing. `scripts/stage-tv-apk.mjs` puts it in place at every publish (see `.cursor/rules/ship-all-platforms.mdc`).

**Downloader code (optional).** On https://go.aftvnews.com you can turn the link into a short number that people type into the Downloader app. You register that yourself, once. It needs no account, the code is public and permanent, and AFTVnews can disable a code after complaints. Because the link never changes, the code never needs updating.

## Updates on the TV

After the first install, **Check for updates** in the Jiyu menu updates the app in place. The feed (`latest-android.yml`) lists the arm64 APK and, from the next publish on, also `universalPath` / `universalSha256`. Jiyu builds made from the next publish on pick the universal APK by themselves when the device has no arm64 (`AppUpdatePlugin.java`). Builds up to 0.3.88 always fetch the arm64 APK, so a 32-bit stick on 0.3.88 has to reinstall once from the short link.

---

## Which brand can take the APK

Look at **Settings → About** (or **System → About**) on the set. The system name there matters more than the logo on the bezel.

| Brand | What that set usually runs | Install the Jiyu TV APK? |
| --- | --- | --- |
| Sony | Google TV | Yes |
| TCL | Google TV, or Roku TV on many US models | Yes only if About says Google TV or Android TV |
| Hisense | Google TV, or VIDAA | Yes only on the Google TV models |
| Toshiba | Fire TV on many US models; Google TV on others | Yes. Use the Fire TV steps when About says Fire TV |
| Philips | Google TV, or Titan OS on newer European sets | Yes only on Google TV |
| Sharp | Google TV or Roku, depending on the year and country | Yes only on Google TV |
| Panasonic | Google TV on current sets | Yes |
| Xiaomi / Redmi | Google TV | Yes |
| Nvidia Shield, Chromecast with Google TV, Walmart onn Google TV | Google TV | Yes |
| Amazon Fire TV Stick, Fire TV Cube, Toshiba Fire TV Edition, Insignia Fire TV | Fire OS | Yes |
| Samsung | Tizen (2016 and newer). Very old sets are Orsay | No. Use the Samsung `.wgt` below |
| LG | webOS | No |
| Vizio | SmartCast | No |
| Pioneer | No shared smart-TV system. Check About | Only if About says Android TV or Google TV |
| Roku TVs (TCL, Hisense, Sharp, RCA, and others when the home screen is Roku) | Roku OS | No |

If the home screen is Roku, Fire TV, Tizen, webOS, VIDAA, or SmartCast, do not follow the Google TV steps.

---

## Easiest: the Downloader app (Google TV, Android TV, Fire TV)

1. On the TV, install **Downloader** (by AFTVnews) from the Play Store or the Amazon Appstore.
2. Allow it to install apps:
   - Fire TV: **Settings → My Fire TV → Developer options → Install unknown apps → Downloader → On**. If Developer options is missing, open **Settings → My Fire TV → About** and press the center button on the device name 7 times.
   - Google TV: **Settings → Apps → Security & restrictions → Unknown sources → Downloader → On**.
3. Open Downloader, type `jiyu.free-river.workers.dev/tv` (or your AFTVnews code), and press **Go**.
4. Choose **Install** when the download finishes. You can delete the downloaded file afterwards.
5. Jiyu shows on the home row / apps row. The remote works everywhere: arrows move, OK selects, Back goes back, and Back on the home screen asks once more before it exits.

---

## Google TV and Android TV with adb (from this PC)

`adb` on this PC is:

```text
C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe
```

The TV and the PC have to be on the same Wi-Fi. Use the TV's current IP from its network settings. A guest network or a VPN on the PC will block the connection.

1. On the TV: **Settings → System → About**.
2. Highlight **Android TV OS build** (on older sets: **Build**) and press the center button **7 times** until developer options turn on.
3. Go back. Open **Settings → System → Developer options**.
4. Turn on **USB debugging** and **Network debugging** (sometimes **ADB debugging**).
5. Note the IP and port on that screen (often `5555`).
6. On the PC, in PowerShell:

```powershell
$adb = "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe"
& $adb connect TV_IP:5555
& $adb devices
& $adb install -r "F:\Jiyu\pack-out\VERSION\upload\Jiyu-TV.apk"
```

The TV may show **Allow USB debugging?** Check **Always allow** and accept. Jiyu then shows in the apps row (the manifest has the Leanback launcher and a TV banner).

## Fire TV with adb

1. **Settings → My Fire TV → About**, press the center button on the device name **7 times**.
2. **Settings → My Fire TV → Developer options**: turn on **ADB debugging** and **Apps from Unknown Sources**.
3. **Settings → My Fire TV → About → Network**: note the IP address.
4. Run the same three `adb` lines as above.

Most Fire TV Sticks run 32-bit Android. Use `Jiyu-TV.apk` (universal) on them, not the arm64 APK.

---

## Samsung (Tizen)

The Samsung package is the same Jiyu screens built as a Tizen web app (`.wgt`). TV mode turns on by itself, and the remote works with the same focus navigation as Android TV. The Return key follows the same Back ladder (popup → overlay → player → section → home → "Press Back again to exit"), and Play/Pause/Stop/FF/Rewind/Next/Previous on the remote control the player.

### Build it on the PC

```powershell
cd D:\app
npm run pack:tizen          # web build into D:\app\tizen (no signing)
npm run pack:tizen:wgt -- --profile YOUR_PROFILE   # also builds and signs D:\app\Jiyu.wgt
```

`build:tizen` is a separate Vite mode (`vite build --mode tizen` → `dist-tizen`). It makes one classic script for Chrome 69 (Samsung 2020 sets and newer), because Tizen refuses module scripts from the package. `scripts/pack-tizen.mjs` copies it into `tizen/`, adds `polyfills.js` and `tizen.js` (remote keys), stamps the version into `config.xml`, and with `--wgt` runs the Tizen Studio CLI (`F:\Jiyu\tizen-studio\tools\ide\bin\tizen.bat`, or set `TIZEN_STUDIO`). The phone, desktop, and Android builds are not affected.

A local test profile named `jiyu-local` exists on this PC (author certificate in `F:\Jiyu\temp-user\tizen-cert`, Tizen's default distributor). A `.wgt` signed with it installs on the **Tizen emulator only**. A real Samsung TV needs a Samsung certificate with that TV's DUID (below).

### Put the TV in developer mode

1. On the TV, open **Apps**.
2. With Apps highlighted, press **1 2 3 4 5** on the remote. A **Developer mode** dialog opens. (Some remotes: use the on-screen number pad.)
3. Turn **Developer mode** on and enter this PC's IPv4 address as the host (`ipconfig` on the PC, Wi-Fi adapter).
4. Restart the TV when it asks (hold the power button until the logo shows).
5. The TV and PC must be on the same network, no VPN.

### Samsung certificate (once per TV list)

1. In Tizen Studio: **Tools → Package Manager → Extension SDK** → install **TV Extensions** and **Samsung Certificate Extension** (if not installed yet).
2. **Tools → Device Manager**: **Remote Device Manager** → add the TV IP, port **26101**, and connect. (Or `& "F:\Jiyu\tizen-studio\tools\sdb.exe" connect TV_IP`.)
3. **Tools → Certificate Manager → + → Samsung → TV**. Create an author certificate (sign in with a Samsung account when it asks; this is the one step that needs an account). For the distributor certificate choose **Partner/Public**, and add the TV's DUID. If the TV is connected, the DUID is filled in by itself. Name the profile, for example `samsung-tv`.
4. A package signed without that TV's DUID will not install on it. For more TVs, edit the distributor certificate and add their DUIDs.

### Install

```powershell
cd D:\app
npm run pack:tizen:wgt -- --profile samsung-tv
$sdb = "F:\Jiyu\tizen-studio\tools\sdb.exe"
& $sdb connect TV_IP
& $sdb devices
& "F:\Jiyu\tizen-studio\tools\ide\bin\tizen.bat" install -n Jiyu.wgt -t DEVICE_NAME_FROM_sdb_devices -- D:\app
```

Or use Device Manager → right-click the TV → **Install app** → `D:\app\Jiyu.wgt`. Jiyu then shows in the TV's Apps. Updating = build and install again (same app id `jiyu000001.Jiyu`).

### What works on Samsung, and what does not yet

Works (checked in Chrome at 1920×1080 with a Tizen user agent, file:// and CORS on like the TV):

- Home, sections, shelves, posters and TMDB data, Saved, Library, settings, sync pairing.
- Remote focus navigation, Return key ladder, media keys.
- Direct HLS / MP4 streams and IPTV channels. When a stream's server blocks cross-origin script reads, Jiyu plays it with the TV's own `<video>` HLS player instead of hls.js.

Does not work on Samsung yet:

- Sources that scrape other sites (most Movies/Series/Anime/Sports finders: streamed.pk, SubsPlease, NetMirror-type catalogs, the default IPTV guide list, YouTube live lookups). The TV enforces CORS and those sites send no CORS headers. They need a small relay server. Not built or deployed yet.
- Streams that need a Referer or custom headers (the browser cannot set them).
- YouTube embeds. YouTube refuses embeds from a packaged app with no web origin (Error 153). They need an https-hosted embed page.
- Anything that needs Android or Electron: the Gecko web player/ad-blocked embeds, torrents and ffmpeg remux, Multi-view, PiP, in-app self-update (reinstall the `.wgt` instead).
- Real-TV testing: not done yet. 2018–2019 sets (Chrome 56–63) are probably too old for this build.

Sets from before Tizen (Orsay, mostly 2015 and earlier) cannot open Developer mode this way.

---

## LG webOS

LG has a separate **Developer Mode** app in the LG Content Store, and installs go through the webOS CLI (`ares-install`). That needs a webOS package. This repo does not have one yet. The Android APK will not install.

---

## Roku, Vizio, and VIDAA

Roku (including Roku-branded TCL, Hisense, and Sharp), Vizio SmartCast, and Hisense VIDAA do not sideload Android apps or Tizen packages. Jiyu has no package for them.
