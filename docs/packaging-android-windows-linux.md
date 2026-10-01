# Packaging Jiyu for Android, Windows, and Linux

Jiyu (`jiyu-media-center` 0.3.5) is an **Electron + React + Vite** desktop app. The UI lives in `src/` and builds to `dist/`. The desktop process lives in `electron/main.cjs` and is exposed to the UI as `window.signalDesktop`.

That split decides which tool you use:

| Target | Tool | What you actually ship |
| --- | --- | --- |
| Android phone, tablet, TV, emulator | **Capacitor** (Android Studio) | The Vite web build inside a native WebView. Electron does not run on Android. |
| Windows PC | **electron-builder** (`npm run pack:win`) | NSIS installer and a portable `.exe` |
| Linux PC (Ubuntu, Debian, Zorin, and others) | **electron-builder** (`npm run pack:linux`) | AppImage and `.deb` |

Do this work on a copy of the repo, or on a git branch. Packaging does not replace `npm run dev:desktop`.

---

## 0. What will and will not carry over

### Works in all three packages

- Shelves, search, navigation, and the React player for direct HLS / MP4 URLs that the WebView or Chromium can play without custom headers.
- Settings stored in `localStorage` (they stay on that device only).

### Desktop only (Windows and Linux Electron builds)

These go through `electron/main.cjs` on desktop. Capacitor Android uses a native bridge where noted below.

- **Torrent playback:** desktop uses WebTorrent + remux (`ffmpeg-static`). Android uses the in-app `TorrentStreamer` Capacitor plugin (`libtorrent4j` + local HTTP Range streaming via `src/lib/torrentBridge.ts`). Desktop behavior is unchanged.
- In-app browser (`WebContentsView`) used for YouTube, PPV / embed players, and PiP
- Catalog sync that needs the desktop fetch / Cloudflare helper
- Native fullscreen, minimize-to-PiP, and multi-monitor window behavior
- Opening system file dialogs for playlists

On Android, torrent magnet / `.torrent` play works through the native plugin (minSdk 28). Catalog sync and site scrape use **explicit** `CapacitorHttp.get/post` in `src/lib/nativeHttp.ts` (the global CapacitorHttp XHR/fetch patch stays **off** — it breaks hls.js relative playlists such as TVJ). TMDB/Zenox shelves use the same `TMDB_API_KEY` from `.env` via the Vite build. In-app browse uses an overlay WebView (`InAppBrowser` plugin). Embed PiP / multi-view parity with Electron is still limited.

### Already configured in this repo

`package.json` already has:

- `npm run build` — typecheck and Vite production build into `dist/`
- `npm run pack:win` — NSIS + portable
- `npm run pack:linux` — AppImage + deb
- `npm run release:win` / `release:linux` — same packages, uploaded to GitHub Releases (needs `GH_TOKEN`)
- App id `app.jiyu.mediacenter`, product name `Jiyu`
- Vite `base: './'`, and the app uses `HashRouter`, so `file://` and Capacitor’s `https://localhost` both load routes
- Packaged desktop builds check GitHub Releases via **electron-updater** (see section 6)

---

## 1. Tools to install first

Install these on the **build machine** (the computer that produces the installers). You do not install them on every phone.

### All targets

1. **Git**
2. **Node.js 22 or newer** (this repo uses the Node 24 type definitions). https://nodejs.org
3. Confirm in a terminal:

```bash
node -v
npm -v
```

4. From the repo root (`D:\app` on this machine):

```bash
npm install
```

### Android only

Install all of these. Order matters only in that the JDK should exist before you open Android Studio the first time.

1. **Android Studio** (current stable). https://developer.android.com/studio  
   During setup, install:
   - Android SDK
   - Android SDK Platform (API 35, and API 34 as a fallback)
   - Android SDK Build-Tools
   - Android SDK Platform-Tools (`adb`)
   - Android Emulator (only if you will test without a phone)
2. **JDK 21** (Temurin or the JDK bundled with Android Studio). Capacitor’s Gradle build expects a current LTS JDK, not Java 8.
3. **Capacitor packages** (added in section 2; not in the repo yet):

```bash
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli
```

4. Optional, for command-line installs without Android Studio’s Run button:

- `adb` on your `PATH` (Android Studio → Settings → Languages & Frameworks → Android SDK → SDK Tools → Android SDK Platform-Tools).

### Windows installer only

Nothing extra if you build **on Windows**. `electron-builder` downloads the NSIS tooling.

Build Windows installers on Windows. Cross-compiling a Windows `.exe` from Linux is possible with Wine and is not worth it for this app.

### Linux installer only

Build Linux packages **on Linux** (a Zorin / Ubuntu machine, or WSL2 Ubuntu). Building AppImage/deb from native Windows usually fails because `electron-builder` wants Linux packaging tools (`dpkg`, `mksquashfs`, FUSE).

On the Linux build machine:

```bash
sudo apt update
sudo apt install -y build-essential fakeroot dpkg-dev
```

AppImage also needs FUSE to *run* on the target PC (`libfuse2` on Ubuntu 22.04 / Zorin). The build machine needs it too if you want to launch the AppImage there:

```bash
sudo apt install -y libfuse2
```

---

## 2. Android — Capacitor

Electron cannot be “converted” into an APK. Capacitor takes the same `dist/` folder the desktop app serves and wraps it in an Android WebView project under `android/`.

### 2.1 Create the Android project (once)

From the repo root:

```bash
npm run build
npx cap init "Jiyu" app.jiyu.mediacenter --web-dir dist
npx cap add android
```

`cap init` writes `capacitor.config.ts`. It must keep:

- `appId`: `app.jiyu.mediacenter` (same id as the desktop `appId`, so installs are recognizable)
- `appName`: `Jiyu`
- `webDir`: `dist`

If the file is JSON instead of TS, the same three fields apply.

Then:

```bash
npx cap sync android
```

`cap sync` copies `dist/` into the Android project and updates native plugins. Run it after every web build. Do not edit generated files under `android/app/src/main/assets/public/`; the next sync overwrites them.

### 2.2 Open the native project

```bash
npx cap open android
```

Android Studio will download Gradle and index the project the first time. Wait until the elephant progress bar finishes.

### 2.3 Repeat this loop after UI changes

```bash
npm run build
npx cap sync android
```

Then Run again from Android Studio. Sync alone does not recompile TypeScript; `npm run build` does.

### 2.4 Allow cleartext and media playback

Jiyu plays arbitrary `http://` streams. Android 9+ blocks cleartext HTTP unless you allow it.

In Android Studio, open `android/app/src/main/AndroidManifest.xml`. On the `<application>` tag add:

```xml
android:usesCleartextTraffic="true"
```

Also add these permissions inside `<manifest>` if they are not already present:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

`WAKE_LOCK` keeps the screen from sleeping during playback if you later wire a foreground service. The WebView will still play without it, but the screen may lock.

Hardware video decoding is already used by the system WebView. You do not install `ffmpeg` on the phone for this shell.

### 2.5 App icon

Desktop icons are not imported automatically.

1. Create a 1024×1024 PNG of the Jiyu logo (no rounded corners; Android masks them).
2. Android Studio → right-click `app` → **New → Image Asset**.
3. Source Asset = that PNG. Name = `ic_launcher`.
4. Finish. This writes `mipmap-*` densities for phones and tablets.

---

## 3. Android devices — how to install on each kind

The APK is the same file for phones and tablets. What changes is the ABI filter, how you sign it, and how the device is put into install mode.

### 3.1 Choose ABIs

Most phones and tablets since 2019 are **arm64-v8a**. Older 32-bit phones are **armeabi-v7a**. Emulator images are often **x86_64**.

In `android/app/build.gradle`, inside `defaultConfig`, a universal build looks like:

```gradle
ndk {
    abiFilters "armeabi-v7a", "arm64-v8a", "x86_64"
}
```

Leave all three in while you are testing. For a smaller phone-only APK, keep only `arm64-v8a`.

### 3.2 Phone (USB)

1. On the phone: Settings → About phone → tap **Build number** seven times to unlock Developer options.
2. Settings → Developer options → enable **USB debugging**.
3. Plug in USB. Accept the “Allow USB debugging?” prompt. If the PC does not see the phone, install the OEM driver (Samsung, Xiaomi, and OnePlus ship their own; Google Pixel uses the driver inside Android Studio).
4. Check the connection:

```bash
adb devices
```

You want `device`, not `unauthorized` or an empty list.

5. Android Studio → device dropdown → your phone → **Run** (green triangle).  
   Or, after you have built an APK (section 3.6):

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`-r` replaces an existing Jiyu install.

**Samsung:** if `adb devices` is empty, install Samsung USB Driver, and on the phone set USB mode to **File transfer**, not “Charging only”.

**Xiaomi / Redmi / POCO:** also enable **USB debugging (Security settings)** and **Install via USB**. Those phones reject `adb install` until you sign in with a Xiaomi account once.

**Nothing / Pixel / Motorola:** the stock Google driver is enough.

### 3.3 Phone (no USB — wireless debugging)

Android 11 and newer:

1. Developer options → **Wireless debugging** → on.
2. Tap **Pair device with pairing code**.
3. On the PC (Android SDK platform-tools):

```bash
adb pair PHONE_IP:PAIR_PORT
adb connect PHONE_IP:CONNECT_PORT
adb devices
```

Use the two different ports shown on the phone. Pairing port and connection port are not the same.

Then Run from Android Studio or `adb install -r` as above.

### 3.4 Tablet

Same APK and same USB / wireless steps as a phone. Extra checks:

- In Android Studio’s emulator or layout preview, use a **sw600dp** tablet skin (for example Pixel Tablet) before you call the UI done. Jiyu’s desktop layout assumes a wide window; on a tablet in landscape it is closest to the desktop. In portrait, shelves will feel narrow. That is a layout issue, not a packaging bug.
- If the tablet is **Android 12+** and the install is blocked, allow **Install unknown apps** for the app you use to open the APK (Files, Chrome, or Drive).

### 3.5 Android TV and Fire TV

Brand-by-brand steps, including Samsung Tizen, LG, Roku, and Fire TV, are in [install-tvs.md](install-tvs.md). Use `jiyu-debug.apk` from the debug output folder. The notes below are the short form.

**Android TV / Google TV (Sony, Nvidia Shield, Chromecast with Google TV):**

1. Settings → Device Preferences → Security & restrictions → **Unknown sources** on.
2. Developer options → **USB debugging** on. Shield and Chromecast expose adb over the network:

```bash
adb connect TV_IP:5555
adb install -r app-debug.apk
```

3. A TV launcher will not show the app unless the manifest says it is a leanback app. For a first sideload test you can still launch it from Settings → Apps → Jiyu → Open, if that button exists. To show up on the home row, add this activity intent filter later (Android Studio, not required for the first install):

```xml
<category android:name="android.intent.category.LEANBACK_LAUNCHER" />
```

TV remote is a D-pad. Capacitor’s WebView does not turn Jiyu’s mouse UI into a focusable TV UI. Expect to test playback, not the full shelf design, until focus styles exist.

**Amazon Fire TV Stick / Fire TV Cube:**

1. Settings → My Fire TV → Developer options → **ADB debugging** and **Install unknown apps**.
2. `adb connect FIRE_TV_IP:5555`
3. `adb install -r app-debug.apk`
4. Fire OS is Android-based but not Google Play. Do not use a Play Store listing for Fire TV. Sideload, or later package an Amazon Appstore build. The same arm64 APK is the one that installs.

### 3.6 Chromebook

Two different installs:

- **Android container (most Chromebooks):** copy the APK to the Files app and open it. Enable **Google Play** in ChromeOS settings first. This is the Capacitor APK, not the Linux build.
- **Linux (Crostini) container:** use the Linux AppImage or `.deb` from section 5, not the APK.

### 3.7 Emulator (no device yet)

1. Android Studio → **Device Manager** → Create device.
2. Phone: Pixel 8, system image **API 35**, ABI **arm64-v8a** if your CPU can virtualize ARM, otherwise **x86_64**.
3. Tablet: Pixel Tablet, same API.
4. TV: **Android TV** system image, not the phone image.
5. Start the emulator, then Run. `adb devices` shows `emulator-5554`.

An x86_64 emulator will not catch ARM-only native crashes. Jiyu’s Capacitor shell has no custom native libraries, so x86_64 is fine for UI tests.

### 3.8 Build an APK you can send to a device

Debug APK (fast, not for a store):

Android Studio → **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

Output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Copy that file to the phone (Drive, USB, or `adb install -r`) and open it. The first time, the phone asks you to allow that source app to install unknown apps. Allow it, then tap the APK again.

Release APK (what you keep):

1. Android Studio → **Build → Generate Signed Bundle / APK** → **APK** → next.
2. **Create new** keystore. Save `jiyu-release.keystore` outside the repo. Write down the store password, key alias, and key password. If you lose this file you cannot update the app in place; every user must uninstall.
3. Build variant: **release**.
4. Signature versions: check **V2 (Full APK Signature)**. Also check V1 if you still support very old Android 7 devices.

Output:

```text
android/app/build/outputs/apk/release/app-release.apk
```

A release bundle (`.aab`) is only for Google Play. Sideloading uses the APK.

### 3.9 Version bumps

Before each release APK, in `android/app/build.gradle`:

- Raise `versionCode` by 1 (integer, never reused).
- Set `versionName` to the same string as `package.json` `"version"` (currently `0.3.5`).

Android will refuse to install a build whose `versionCode` is lower than the one already on the device.

---

## 4. Windows

Build this on Windows, from the repo root.

### 4.1 Installer and portable exe

```bash
npm install
npm run pack:win
```

That script runs `npm run build`, then `electron-builder --win nsis portable`.

Files land in `release/`:

| File | Use |
| --- | --- |
| `Jiyu Setup 0.3.5.exe` (NSIS name may include the version) | Normal PC install. The wizard asks for a directory because `oneClick` is false. |
| `Jiyu 0.3.5.exe` portable | No install. Copy it to any Windows 10 / 11 x64 PC and run it. Settings stay next to the exe’s user-data folder under `%APPDATA%`. |

Both are **64-bit Windows** only. Jiyu is not built for 32-bit Windows.

### 4.2 Per device

**Your own PC**

1. Run the NSIS setup.
2. If SmartScreen says “Windows protected your PC”, choose **More info → Run anyway**. That appears until the exe is code-signed. This repo does not configure a certificate.
3. Launch **Jiyu** from the Start menu.

**Another Windows PC on the same network**

Copy either the Setup exe or the portable exe. You do not copy `node_modules`. The packaged app already contains Electron and the built UI.

**A USB stick / no admin rights**

Use the **portable** exe. NSIS setup wants a writable Program Files (or a user-chosen folder) and may ask for an administrator password. Portable does not.

**A PC that already has an older Jiyu**

Run the new Setup exe. NSIS upgrades in place when the app id matches (`app.jiyu.mediacenter`). Uninstall first only if the old copy was a portable exe sitting in another folder; portable builds do not register an uninstaller.

### 4.3 Code signing (optional, later)

Without a certificate, SmartScreen and some antivirus tools warn on every new exe. Signing needs a Windows Authenticode certificate and `CSC_LINK` / `CSC_KEY_PASSWORD` in the environment before `npm run pack:win`. Do not commit the certificate or the password.

### 4.4 If the Windows build fails

- Run the terminal as a normal user, not by deleting `node_modules` mid-build.
- Close any running `electron.exe` from `npm run dev:desktop` so files under `release/` are not locked.
- `ffmpeg-static` is unpacked on purpose (`asarUnpack` in `package.json`). If torrent remux fails only in the packaged app, confirm `release/win-unpacked/resources/app.asar.unpacked/node_modules/ffmpeg-static/` exists before you rebuild.

---

## 5. Linux

Build on Linux. The README calls out **Zorin OS**; the same `.deb` works on Ubuntu and Debian with the same architecture (x64).

### 5.1 Produce AppImage and deb

On the Linux machine, in the repo:

```bash
npm install
npm run pack:linux
```

That is `npm run build && electron-builder --linux AppImage deb`.

Output in `release/`:

| File | Use |
| --- | --- |
| `Jiyu-0.3.5.AppImage` | One file. Works across Ubuntu, Debian, Zorin, Fedora, and Arch without installing. |
| `jiyu-media-center_0.3.5_amd64.deb` | Installs a menu entry on Debian, Ubuntu, Zorin, Pop!_OS, Mint. |

The names follow `productName` / package name. Look in `release/` if the version prefix differs.

There is no `rpm` target in `package.json`. Fedora and openSUSE should use the AppImage unless you add an `rpm` target later.

### 5.2 Per device

**Zorin / Ubuntu / Debian / Mint (deb)**

```bash
sudo apt install ./jiyu-media-center_0.3.5_amd64.deb
```

Launch **Jiyu** from the app grid. Remove with:

```bash
sudo apt remove jiyu-media-center
```

**Any distro, including Fedora and Arch (AppImage)**

```bash
chmod +x Jiyu-0.3.5.AppImage
./Jiyu-0.3.5.AppImage
```

If it fails with `libfuse.so.2` missing:

```bash
sudo apt install libfuse2
```

On Fedora the package name is `fuse-libs`. Extracting the AppImage (`--appimage-extract` then run `squashfs-root/AppRun`) avoids FUSE when the admin will not install it.

**Steam Deck (desktop mode)**

Copy the AppImage to the Deck, `chmod +x`, run it from Dolphin. Game mode is not a supported target.

**Chromebook Linux container**

Enable Linux in ChromeOS settings, copy the `.deb` or AppImage into the Linux files folder, and use the same commands as Ubuntu.

**Raspberry Pi and other ARM boards**

Do not use the amd64 deb or the default AppImage. Those are x64. An ARM build requires running `npm run pack:linux` **on that ARM machine** (or a matching ARM builder) so Electron downloads the `linux-arm64` binary. This repo’s `linux.target` does not set `arch`, so electron-builder follows the machine you build on.

### 5.3 Wayland

Electron on current Ubuntu / Zorin may start under Wayland or Xwayland. If the window is blank, launch once with:

```bash
./Jiyu-0.3.5.AppImage --ozone-platform=x11
```

If that fixes it, the desktop session is the variable, not the package.

---

## 6. Desktop auto-updates (GitHub Releases)

Packaged Windows (NSIS) and Linux (AppImage) builds use **electron-updater** against **https://github.com/rcrdhs/jiyu-media-center/releases**.

### Ship an update

1. Bump `"version"` in `package.json` (and keep `src/lib/appVersion.ts` release notes in sync if you care about the in-app log).
2. On the build machine, set a GitHub classic PAT with `repo` scope:

```bash
# Windows PowerShell
$env:GH_TOKEN = "ghp_..."

# Linux
export GH_TOKEN=ghp_...
```

3. Publish:

```bash
npm run release:win
# on a Linux builder:
npm run release:linux
```

That builds installers and uploads them to a **draft** GitHub Release (see `build.publish` in `package.json`). Open the draft on GitHub, confirm `latest.yml` / `latest-linux.yml` and the installers are attached, then click **Publish release**.

`npm run pack:win` / `pack:linux` still build locally without uploading.

### What users see

- On launch (packaged only), Jiyu checks Releases after a short delay.
- Brand menu → **Check for updates** / **Download update** / **Restart to update**.
- Dev (`npm run dev:desktop`) does not check; the menu explains that.

### Notes

- End users do **not** need `GH_TOKEN`. Public release assets are enough.
- Prefer the **NSIS** installer for Windows updates. Portable exe updates are less reliable.
- Prefer **AppImage** for Linux auto-update. `.deb` users typically install the new package manually.
- Android is a separate channel (Play Store or sideloaded APK), not electron-updater.

---

## 7. Suggested order

1. `npm install` on the build PC.
2. `npm run pack:win` and install the NSIS exe on a second Windows account or PC. Confirm a shelf opens and a direct stream plays.
3. On a Linux box, `npm run pack:linux`. Install the deb on Zorin or Ubuntu. Run the AppImage on a distro that is not Debian-based.
4. Only then do the Capacitor Android path. Build a debug APK, install it on one arm64 phone over USB, and confirm the UI loads. Do not expect torrent or embed-browser playback until those features are reimplemented against Capacitor plugins.

---

## 8. Files you should not commit

- `android/` can be committed after `cap add` if you want the native project in git. The copied web assets under `android/app/src/main/assets/public/` should not be hand-edited.
- `release/` build output
- `*.keystore`, store passwords, and `CSC_LINK` certificates
- `node_modules/`
- `GH_TOKEN` / `.env` with secrets

Add keystores to `.gitignore` if they were created inside the repo.
