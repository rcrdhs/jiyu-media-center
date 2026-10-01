# Installing Jiyu on TVs

The file you already built is an **Android** package:

```text
D:\app\android\app\build\outputs\apk\debug\jiyu-debug.apk
```

It is arm64 only. It installs on Android TV, Google TV, and Fire TV. It does not install on Samsung Tizen, LG webOS, Roku, Vizio SmartCast, or Hisense VIDAA. Those sets run a different system, and Tizen Studio cannot open an APK.

`adb` on this PC is:

```text
C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe
```

The TV and the PC have to be on the same Wi-Fi. Use the TV’s current IP from its network settings. A guest network or a VPN on the PC will block the connection.

---

## Which brand can take this file

Look at **Settings → About** (or **System → About**) on the set. The system name there matters more than the logo on the bezel.

| Brand | What that set usually runs | Install `jiyu-debug.apk`? |
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
| Samsung | Tizen (2016 and newer). Very old sets are Orsay | No |
| LG | webOS | No |
| Vizio | SmartCast | No |
| Pioneer | No shared smart-TV system. Check About | Only if About says Android TV or Google TV |
| Roku TVs (TCL, Hisense, Sharp, RCA, and others when the home screen is Roku) | Roku OS | No |

If the home screen is Roku, Fire TV, Tizen, webOS, VIDAA, or SmartCast, do not follow the Google TV steps.

---

## Google TV and Android TV

Sony, Shield, Chromecast with Google TV, and any set whose About screen says Google TV or Android TV.

1. On the TV: **Settings → System → About**.
2. Highlight **Android TV OS build** (on older sets: **Build**) and press the center button **7 times** until developer options turn on.
3. Go back. Open **Settings → System → Developer options**.
4. Turn on **USB debugging** and **Network debugging** (wording is sometimes **ADB debugging**).
5. Note the IP and port on that screen. The port is often `5555`. If the TV shows a different port, use that port.
6. On the PC, in PowerShell:

```powershell
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" connect TV_IP:5555
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r "D:\app\android\app\build\outputs\apk\debug\jiyu-debug.apk"
```

Replace `TV_IP` with the address from the TV. The TV may show **Allow USB debugging?** Check **Always allow** and accept.

7. Open Jiyu from **Settings → Apps → See all apps → Jiyu → Open**.

The apps row on the home screen will not list Jiyu yet. The current manifest has the phone launcher category only. Playback can still be tested from the Apps settings entry. A remote is a D-pad, and Jiyu’s screens are built for touch and a mouse, so expect to confirm that a title starts, not that every shelf is comfortable from across the room.

---

## Fire TV

Amazon Fire TV Stick and Cube, plus Toshiba and Insignia sets whose About screen says Fire TV.

1. **Settings → My Fire TV → About**.
2. Highlight the device name and press the center button **7 times** until developer options turn on.
3. **Settings → My Fire TV → Developer options**.
4. Turn on **ADB debugging** and **Apps from Unknown Sources**.
5. **Settings → My Fire TV → About → Network** and note the IP address.
6. On the PC:

```powershell
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" connect TV_IP:5555
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices
& "C:\Users\Superuser\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r "D:\app\android\app\build\outputs\apk\debug\jiyu-debug.apk"
```

7. Open it from **Settings → Applications → Manage Installed Applications → Jiyu → Launch application**.

Fire OS will not show a phone-style launcher icon on the home row either.

---

## Samsung (Tizen Studio)

The Samsung package is a separate web app in `D:\app\tizen`. It is the same screens as the phone, packed as a `.wgt`. It does not include GeckoView, the torrent engine, or ffmpeg. Those stay on the Android APK.

Build the web package on the PC:

```powershell
cd D:\app
npm run pack:tizen
```

That refreshes `tizen\index.html` and `tizen\assets` from the Vite build. Import `D:\app\tizen` in Tizen Studio (**File → Import → Tizen Project**). If the build complains that `tv-samsung-6.5` is missing, change the platform name in `tizen\.tproject` to the TV extension you installed (Package Manager shows the version).

Then connect the TV:

1. On the TV, open **Apps**.
2. With Apps highlighted, press **1 2 3 4 5** on the remote. There is no text box. A **Developer mode** dialog opens.
3. Turn **Developer mode** on.
4. Enter this PC’s IP address as the host. On the PC, `ipconfig` and use the IPv4 address of the Wi-Fi adapter.
5. Restart the TV when it asks.
6. After reboot, open Developer mode again (**1 2 3 4 5** on Apps). Leave that screen up. It shows the TV IP and the **DUID**.
7. In Tizen Studio, open **Tools → Device Manager**. Scan, or add the TV IP. The TV should show as connected. The default port is **26101**.
8. If Device Manager stays offline, from the Tizen Studio tools folder:

```powershell
& "F:\Jiyu\tizen-studio\tools\sdb.exe" connect TV_IP
& "F:\Jiyu\tizen-studio\tools\sdb.exe" devices
```

Tizen Studio on this PC is installed at `F:\Jiyu\tizen-studio`. `sdb.exe` is in `tools`.

Create a certificate before the first install. In Tizen Studio open **Tools → Certificate Manager → Samsung**, create a TV certificate, and add the DUID shown on the TV. A package signed without that DUID will not install on this set.

Build a signed widget: right-click the Jiyu project → **Build Signed Package**. Tizen Studio writes a `.wgt` under `tizen`. Install it with Device Manager (**Install app**), or:

```powershell
& "F:\Jiyu\tizen-studio\tools\sdb.exe" install PATH_TO_THE.wgt
```

`jiyu-debug.apk` still will not install on this TV. The first launch should show the Jiyu home screen. Multiview, torrent remux, and the Gecko browser are Android-only. The remote Back key leaves a title and returns to the previous screen; on the home screen it exits the app.

Sets from before Tizen (Orsay, mostly 2015 and earlier) will not open Developer mode this way, and Tizen Studio cannot talk to them.

---

## LG webOS

LG sells a separate **Developer Mode** app in the LG Content Store, then you install with the webOS CLI (`ares-install`), not with `adb` and not with Tizen Studio. That path needs a webOS package. This repo does not have one. The Android APK will not install.

---

## Roku, Vizio, and VIDAA

Roku (including Roku-branded TCL, Hisense, and Sharp), Vizio SmartCast, and Hisense VIDAA do not sideload Android apps. Developer modes on those platforms install their own package types. `jiyu-debug.apk` does not apply.

---

## What a successful TV test is

On a Google TV or Fire TV set, success is: `adb devices` lists the TV, `adb install -r` prints **Success**, and **Jiyu → Open** shows the same dark home screen as the phone. Shelves and a direct stream are the useful checks. Remote focus, the home-row icon, Samsung, and LG are separate work and are not in this APK.
