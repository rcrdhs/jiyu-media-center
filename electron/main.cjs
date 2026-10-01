const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, powerMonitor } =
  require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const http = require('http')
const { spawn } = require('child_process')
const { promisify } = require('util')

/** electron-updater — only active in packaged builds (see setupAutoUpdater). */
let autoUpdaterRef = null

/** Tunables pushed from the renderer device profile (defaults = balanced). */
let performanceKnobs = {
  torrentMaxConns: 64,
  torrentPrefetchPieces: 120,
  torrentCriticalPieces: 16,
  streamProbeConcurrency: 20,
  deviceClass: 'balanced',
}

const gunzipAsync = promisify(zlib.gunzip)

/** Load repo-root / app-adjacent .env into process.env (never commit .env). */
function loadDotEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] == null || process.env[key] === '') process.env[key] = val
    }
  } catch {
    /* ignore */
  }
}

function loadJiyuDotEnv() {
  // Dev: repo root. Packaged: next to the exe / resources, then userData.
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(process.resourcesPath || '', '.env'),
    path.join(path.dirname(process.execPath || ''), '.env'),
  ]
  try {
    if (app?.isPackaged) {
      candidates.push(path.join(path.dirname(process.execPath || ''), 'resources', '.env'))
    }
  } catch {
    /* ignore */
  }
  for (const file of candidates) {
    if (file) loadDotEnvFile(file)
  }
}

loadJiyuDotEnv()

/**
 * Desktop downloads, profile, and temp live on F:\Jiyu when that drive is
 * present, so torrent pieces and Chromium caches do not fill C:.
 * JIYU_DATA_ROOT overrides the location.
 */
function jiyuDataRoot() {
  const fromEnv = process.env.JIYU_DATA_ROOT
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim())
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync('F:\\')) return 'F:\\Jiyu'
    } catch {
      /* ignore */
    }
  }
  return null
}

function ensureJiyuDataPaths() {
  const root = jiyuDataRoot()
  if (!root) return null
  // Dev test builds must not share Chromium profile with the installed release —
  // concurrent locks corrupt QuotaManager and IndexedDB ("UnknownError: Internal error").
  let isDev = true
  try {
    isDev = !app.isPackaged
  } catch {
    isDev = true
  }
  const userData = path.join(root, isDev ? 'user-data-dev' : 'user-data')
  const releaseUserData = path.join(root, 'user-data')
  const temp = path.join(root, isDev ? 'temp-dev' : 'temp')
  const torrents = path.join(root, 'webtorrent')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(temp, { recursive: true })
  fs.mkdirSync(torrents, { recursive: true })
  // First-run seed: copy light config from the release profile (not caches/IDB).
  if (isDev && userData !== releaseUserData) {
    for (const name of ['playlist-sources.json', 'torrent-sources.json', '.env', 'torrent-partials.json']) {
      const dest = path.join(userData, name)
      const src = path.join(releaseUserData, name)
      try {
        if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest)
      } catch {
        /* ignore */
      }
    }
  }
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.setPath('temp', temp)
  process.env.TEMP = temp
  process.env.TMP = temp
  if (isDev) {
    console.log('[jiyu] desktop test profile:', userData)
  }
  return { root, userData, temp, torrents }
}

let jiyuDataPaths = null
try {
  jiyuDataPaths = ensureJiyuDataPaths()
} catch (err) {
  console.warn('[jiyu] could not use data root', err?.message || err)
}

function torrentDownloadRoot() {
  if (jiyuDataPaths?.torrents) return jiyuDataPaths.torrents
  return path.join(os.tmpdir(), 'webtorrent')
}

try {
  loadJiyuDotEnv()
  loadDotEnvFile(path.join(app.getPath('userData'), '.env'))
} catch {
  /* app not ready yet — userData path may still work after ready; re-load below */
}

const isDev = !app.isPackaged

// Soften Blink "automated" signals before Chromium boots. Keep GPU/WebGL on so
// Turnstile's proof-of-work can run (do not pass --disable-gpu).
try {
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-webgl')
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas')
  // Sports embeds (embed.st) need muted autoplay without a prior gesture.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

/**
 * WebTorrent destroys peers by closing RTCDataChannels; webrtc-polyfill then
 * emits OperationError("User-Initiated Abort…") on a timer. That is expected
 * teardown, not a fatal crash — suppress the Electron error dialog.
 *
 * EPIPE on console.log is also benign: stdout/stderr closed after a restart or
 * detached console. Logging failed; playback/subtitle work is unaffected.
 */
function isBenignWebRtcTeardownError(err) {
  const msg = String(err?.message || err || '')
  return (
    /User-Initiated Abort/i.test(msg) ||
    (/OperationError/i.test(String(err?.name || '')) && /Close called/i.test(msg))
  )
}
function isBenignMainProcessError(err) {
  if (isBenignWebRtcTeardownError(err)) return true
  const code = err?.code || ''
  const msg = String(err?.message || err || '')
  return code === 'EPIPE' || /EPIPE:\s*broken pipe/i.test(msg)
}
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream?.on?.('error', (err) => {
      if (err?.code === 'EPIPE') return
    })
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => {
  if (isBenignMainProcessError(err)) {
    if (!isBenignWebRtcTeardownError(err)) return // EPIPE: don't log (would EPIPE again)
    try {
      console.warn('[torrent] ignored WebRTC teardown:', err?.message || err)
    } catch {
      /* ignore */
    }
    return
  }
  try {
    console.error('[main] uncaughtException:', err)
  } catch {
    /* ignore */
  }
  try {
    if (app.isReady()) {
      dialog.showErrorBox('Jiyu error', String(err?.stack || err?.message || err))
    }
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (reason) => {
  if (isBenignMainProcessError(reason)) {
    if (!isBenignWebRtcTeardownError(reason)) return
    try {
      console.warn('[torrent] ignored WebRTC teardown rejection:', reason?.message || reason)
    } catch {
      /* ignore */
    }
    return
  }
  try {
    console.error('[main] unhandledRejection:', reason)
  } catch {
    /* ignore */
  }
})

/** Keep in lockstep with package.json (also injected into the UI as __JIYU_VERSION__). */
let APP_VERSION = '0.3.0'
try {
  APP_VERSION = require('../package.json').version || APP_VERSION
} catch {
  /* packaged layouts still expose app.getVersion() below */
}
// Must track Electron's embedded Chromium. Reduced UA (major.0.0.0) matches
// modern desktop Chrome; full version lives in Sec-CH-UA-Full-Version*.
const CHROME_FULL_VERSION = String(process.versions.chrome || '150.0.7871.114').trim()
const CHROME_MAJOR = CHROME_FULL_VERSION.split('.')[0] || '150'
const CHROME_VERSION = `${CHROME_MAJOR}.0.0.0`
const BROWSER_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
/** Match desktop Chrome — appending app tokens breaks many IPTV CDNs. */
const STREAM_UA = BROWSER_UA

/** Per-host UA / Referer overrides from M3U http-user-agent / EXTVLCOPT. */
const playbackHeaderOverrides = new Map()
/** Last Referer from setPlaybackHeaders — also applied to CDN hosts (HLS segments). */
let activePlaybackReferrer = ''

function isIptvMediaUrl(url) {
  const u = String(url || '')
  if (!u) return false
  if (/vimeocdn\.com|player\.vimeo\.com/i.test(u)) return true
  // Movy / Atlantic / Cinecat CDNs (Aphrodite uses /cdn-m3u8?payload= — no .m3u8).
  if (
    /totallyacdn\.|cdn\.hls\.lol|stream\.hls\.lol|transcode\.cfd|zenoak|paleoak|wecollege\.net/i.test(
      u,
    ) ||
    /\/cdn-m3u8(?:\?|$)/i.test(u)
  ) {
    return true
  }
  if (/\.(m3u8?|ts|m4s|mpd|aac|mp4|mp3)(\?|#|$)/i.test(u)) return true
  // Common IPTV panel / CDN path shapes without a file extension
  return /\/(?:live|play|hls|stream|playlist|manifest)\b/i.test(u)
}
const DEV_URL = 'http://localhost:5173'
const WEB_SESSION = 'persist:jiyu-web'

/**
 * Low- + high-entropy UA Client Hints for a modern desktop Google Chrome.
 * Kept in sync with BROWSER_UA / CHROME_FULL_VERSION so CF and CDNs see a
 * consistent Chromium desktop profile (not Electron / empty brands).
 */
function desktopChromeClientHintHeaders() {
  const major = CHROME_MAJOR
  const full = CHROME_FULL_VERSION
  // GREASE brand form used by recent Chrome desktop releases.
  const grease = '"Not_A Brand";v="24"'
  const greaseFull = '"Not_A Brand";v="10.0.2.3"'
  return {
    'Sec-CH-UA': `"Google Chrome";v="${major}", "Chromium";v="${major}", ${grease}`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-CH-UA-Platform-Version': '"15.0.0"',
    'Sec-CH-UA-Arch': '"x86"',
    'Sec-CH-UA-Bitness': '"64"',
    'Sec-CH-UA-Model': '""',
    'Sec-CH-UA-Full-Version': `"${full}"`,
    'Sec-CH-UA-Full-Version-List': `"Google Chrome";v="${full}", "Chromium";v="${full}", ${greaseFull}`,
    'Sec-CH-UA-Wow64': '?0',
  }
}

/** Merge Chrome Client Hints into a headers object (fetch / webRequest). */
function withDesktopChromeClientHints(headers = {}) {
  const next = { ...headers }
  // Drop any prior / mis-cased Client Hint keys so we don't send duplicates.
  for (const key of Object.keys(next)) {
    if (/^sec-ch-ua\b/i.test(key)) delete next[key]
  }
  Object.assign(next, desktopChromeClientHintHeaders())
  return next
}

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {WebContentsView | null} */
let webBrowserView = null
let webBrowserAttached = false
let webBrowserVisible = false
/** Last native browser tile bounds — used for synthetic embed clicks. */
let webBrowserLastBounds = null
/** Shared embed volume 0–1 for scroll-wheel control across frames. */
let webBrowserVolume = 1
/** Isolated dock for embed popups / interstitial ads (keeps main player clean). */
let adDockView = null
let adDockAttached = false
let adDockVisible = false
let adDockLastUrl = ''
let adDockLastShownAt = 0
/** @type {ReturnType<typeof setInterval> | null} */
let adDockMuteTimer = null
/** Extra WebContentsViews for multi-view web embeds (id → view). */
const multiWebViews = new Map()
const multiWebAttached = new Set()
/** Which multi tile should have hearable audio (id). */
let multiWebAudioPrimary = ''
/** Ignore focus/click audio switches while we programmatically nudge play. */
let multiWebIgnoreFocusUntil = 0

/** @type {boolean} */
let jiyuWantOsFullScreen = false
/** Prefer OS minimize → PiP when the renderer says a stream can demote. */
let jiyuMinimizeToPipEnabled = true
let jiyuMinimizeToPipArmed = false
/** Don't re-pin OS fullscreen while a minimize is being turned into PiP. */
let jiyuSuppressFullscreenReassert = false
/** True while the OS window is being dragged (including onto another monitor). */
let windowMoveActive = false
let windowMoveTimer = null

function beginWindowMove() {
  if (!windowMoveActive) {
    windowMoveActive = true
    try {
      if (webBrowserView && webBrowserVisible) webBrowserView.setVisible(false)
    } catch {
      /* ignore */
    }
  }
  if (windowMoveTimer) clearTimeout(windowMoveTimer)
  windowMoveTimer = setTimeout(endWindowMove, 180)
}

function endWindowMove() {
  if (windowMoveTimer) {
    clearTimeout(windowMoveTimer)
    windowMoveTimer = null
  }
  windowMoveActive = false
  try {
    if (webBrowserView && webBrowserVisible && webBrowserLastBounds) {
      webBrowserView.setBounds(webBrowserLastBounds)
      webBrowserView.setVisible(true)
    }
  } catch {
    /* ignore */
  }
}

function exitAppFullscreenSurfaces() {
  jiyuWantOsFullScreen = false
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false)
    }
  } catch {
    /* ignore */
  }
  // If the single browser was laid out full-bleed, pull it under the chrome strip.
  if (
    webBrowserView &&
    !webBrowserView.webContents.isDestroyed() &&
    webBrowserVisible &&
    webBrowserLastBounds &&
    webBrowserLastBounds.y < 8
  ) {
    const top = 48
    let width = 1280
    let height = 720
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const size = mainWindow.getContentSize()
        width = size[0]
        height = size[1]
      }
    } catch {
      /* ignore */
    }
    applyBounds(webBrowserView, {
      x: 0,
      y: top,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height - top)),
    })
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:force-exit-fullscreen')
  }
}

function installEscapeExitsFullscreen(contents) {
  if (!contents || contents.isDestroyed()) return
  contents.on('before-input-event', (_event, input) => {
    if (!input || input.type !== 'keyDown') return
    const key = String(input.key || '')
    if (key !== 'Escape' && key !== 'Esc') return
    // Only tear down when something is actually fullscreen — Esc in a guest
    // page must not force-exit and fight a pending Full enter.
    const osFs = Boolean(
      jiyuWantOsFullScreen ||
        (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()),
    )
    if (!osFs) return
    exitAppFullscreenSurfaces()
  })
}

/** Seed + guard embed volume so buffer/resume can't jump players back to 100%. */
const BROWSER_WHEEL_VOLUME_SCRIPT = `(() => {
  try {
    if (typeof window.__jiyuVolLevel !== 'number' || !Number.isFinite(window.__jiyuVolLevel)) {
      window.__jiyuVolLevel = 1;
    }
    const applyLevel = () => {
      try {
        const level =
          typeof window.__jiyuVolLevel === 'number' && Number.isFinite(window.__jiyuVolLevel)
            ? Math.max(0, Math.min(1, window.__jiyuVolLevel))
            : 1;
        document.querySelectorAll('video,audio').forEach((m) => {
          try {
            m.volume = level;
            m.muted = level <= 0.001;
          } catch (_) {}
        });
        try {
          if (typeof jwplayer === 'function') {
            const players =
              typeof jwplayer.getPlayers === 'function' ? jwplayer.getPlayers() || [] : [];
            for (const p of players) {
              try {
                p.setVolume?.(Math.round(level * 100));
                p.setMute?.(level <= 0.001);
              } catch (_) {}
            }
            try {
              jwplayer().setVolume?.(Math.round(level * 100));
              jwplayer().setMute?.(level <= 0.001);
            } catch (_) {}
          }
        } catch (_) {}
      } catch (_) {}
    };
    if (!window.__jiyuVolGuard) {
      window.__jiyuVolGuard = true;
      document.addEventListener('play', applyLevel, true);
      document.addEventListener('playing', applyLevel, true);
      // Embeds often remount <video> after a stall — re-assert after a tick.
      document.addEventListener(
        'waiting',
        () => {
          try {
            setTimeout(applyLevel, 50);
            setTimeout(applyLevel, 250);
          } catch (_) {}
        },
        true,
      );
    }
    return 'ok';
  } catch (_) {
    return 'error';
  }
})();`

/** Hover ±10s undo/redo seek buttons over embed players (BrowserView sits above React). */
const BROWSER_SEEK_OVERLAY_SCRIPT = `(() => {
  try {
    if (window.__jiyuSeekOverlayBound) return 'bound';
    window.__jiyuSeekOverlayBound = true;

    const STYLE_ID = 'jiyu-seek-overlay-style';
    const ROOT_ID = 'jiyu-seek-overlay';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
        #\${ROOT_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 clamp(1.1rem, 7vw, 4.25rem);
          pointer-events: none;
          opacity: 0;
          transition: opacity 160ms ease;
        }
        #\${ROOT_ID}.is-visible { opacity: 1; }
        #\${ROOT_ID} button {
          pointer-events: auto;
          position: relative;
          width: 3.4rem;
          height: 3.4rem;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.18);
          background: rgba(8,10,14,0.88);
          color: #f4f4f5;
          display: grid;
          place-items: center;
          cursor: pointer;
          box-shadow: 0 10px 28px rgba(0,0,0,0.45);
        }
        #\${ROOT_ID} button:hover {
          background: rgba(16,20,26,0.96);
          border-color: rgba(240,180,41,0.45);
          transform: scale(1.06);
        }
        #\${ROOT_ID} svg { width: 1.45rem; height: 1.45rem; display: block; }
        #\${ROOT_ID} .jiyu-seek-badge {
          position: absolute;
          bottom: 0.4rem;
          font: 700 0.58rem/1 system-ui, sans-serif;
          letter-spacing: 0.02em;
          opacity: 0.9;
        }
      \`;
      (document.head || document.documentElement).appendChild(style);
    }

    const pickVideo = () => {
      const media = Array.from(document.querySelectorAll('video')).filter((m) => {
        try {
          const r = m.getBoundingClientRect();
          return r.width > 64 && r.height > 64;
        } catch (_) {
          return false;
        }
      });
      if (!media.length) return null;
      return (
        media.find((m) => !m.paused && !m.ended) ||
        media.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        })[0]
      );
    };

    const seekBy = (delta) => {
      const v = pickVideo();
      if (!v) return false;
      if (!Number.isFinite(v.duration) || v.duration === Infinity) return false;
      v.currentTime = Math.min(v.duration, Math.max(0, (Number(v.currentTime) || 0) + delta));
      try { v.play().catch(() => {}); } catch (_) {}
      return true;
    };

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.innerHTML = \`
        <button type="button" aria-label="Rewind 10 seconds" title="-10s" data-delta="-10">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9.5 7.5H5.5V3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5.7 7.6A8 8 0 1 1 5 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <span class="jiyu-seek-badge">10</span>
        </button>
        <button type="button" aria-label="Forward 10 seconds" title="+10s" data-delta="10">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.5 7.5H18.5V3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M18.3 7.6A8 8 0 1 0 19 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <span class="jiyu-seek-badge">10</span>
        </button>
      \`;
      (document.body || document.documentElement).appendChild(root);
      root.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-delta]') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        seekBy(Number(btn.getAttribute('data-delta')) || 0);
        show();
      }, true);
    }

    let hideTimer = 0;
    const show = () => {
      const v = pickVideo();
      if (!v || !Number.isFinite(v.duration) || v.duration === Infinity) {
        root.classList.remove('is-visible');
        return;
      }
      root.classList.add('is-visible');
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => root.classList.remove('is-visible'), 2200);
    };

    window.addEventListener('mousemove', show, { passive: true });
    window.addEventListener('pointerdown', show, { passive: true });
    return 'bound';
  } catch (_) {
    return 'error';
  }
})();`

async function installBrowserFrameScript(contents, script) {
  if (!contents || contents.isDestroyed()) return
  const frames = collectContentFrames(contents, { maxFrames: 10 })
  for (const frame of frames) {
    try {
      await raceFrameExec(frame.executeJavaScript(script, true), 1500)
    } catch {
      /* timeout / cross-process / detached frame */
    }
  }
}

async function installBrowserWheelVolume(contents) {
  if (!contents || contents.isDestroyed()) return
  const script = BROWSER_WHEEL_VOLUME_SCRIPT.replace(
    'window.__jiyuVolLevel = 1;',
    `window.__jiyuVolLevel = ${Number.isFinite(webBrowserVolume) ? webBrowserVolume : 1};`,
  )
  await installBrowserFrameScript(contents, script)
  await installBrowserFrameScript(contents, BROWSER_SEEK_OVERLAY_SCRIPT)
}

function scheduleBrowserWheelVolume(contents) {
  if (!contents || contents.isDestroyed()) return
  const run = () => {
    void installBrowserWheelVolume(contents)
  }
  run()
  setTimeout(run, 400)
  setTimeout(run, 1500)
  setTimeout(run, 4000)
}

/** Last audible level so Mute → Unmute restores instead of jumping to 100%. */
let webBrowserVolumeBeforeMute = 1

function buildApplyWebBrowserVolumeScript(level) {
  const snapped = Math.max(0, Math.min(1, Number(level) || 0))
  const pct = Math.round(snapped * 100)
  return `(() => {
    try {
      const level = ${snapped};
      window.__jiyuVolLevel = level;
      document.querySelectorAll('video,audio').forEach((m) => {
        try {
          m.volume = level;
          m.muted = level <= 0.001;
        } catch (_) {}
      });
      try {
        if (typeof jwplayer === 'function') {
          const players =
            typeof jwplayer.getPlayers === 'function' ? jwplayer.getPlayers() || [] : [];
          for (const p of players) {
            try {
              p.setVolume?.(Math.round(level * 100));
              p.setMute?.(level <= 0.001);
            } catch (_) {}
          }
          try {
            jwplayer().setVolume?.(Math.round(level * 100));
            jwplayer().setMute?.(level <= 0.001);
          } catch (_) {}
        }
      } catch (_) {}
      try {
        if (window.videojs) {
          for (const el of document.querySelectorAll('.video-js')) {
            try {
              const p = window.videojs.getPlayer?.(el);
              p?.volume?.(level);
              p?.muted?.(level <= 0.001);
            } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (_) {}
  })();`
}

/**
 * Set in-app embed volume (0–1) from chrome UI or IPC.
 * @param {number} level
 * @param {{ emit?: boolean }} [options]
 */
function applyWebBrowserVolume(level, options = {}) {
  const next = Math.max(0, Math.min(1, Number(level) || 0))
  const snapped = next >= 0.995 ? 1 : next <= 0.001 ? 0 : next
  if (snapped > 0.001) webBrowserVolumeBeforeMute = snapped
  webBrowserVolume = snapped
  const muted = snapped <= 0.001
  const script = buildApplyWebBrowserVolumeScript(snapped)
  const targets = []
  if (webBrowserView && !webBrowserView.webContents.isDestroyed()) {
    targets.push(webBrowserView.webContents)
  }
  for (const view of multiWebViews.values()) {
    if (view && !view.webContents.isDestroyed()) targets.push(view.webContents)
  }
  for (const contents of targets) {
    void installBrowserFrameScript(contents, script)
    try {
      // Only force-mute the single-player view; multi tiles use setMultiWebAudio.
      if (webBrowserView && contents === webBrowserView.webContents) {
        contents.setAudioMuted(muted)
      }
    } catch {
      /* ignore */
    }
  }
  const percent = Math.round(snapped * 100)
  if (options.emit !== false && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:volume', { percent })
  }
  return { ok: true, percent }
}

/** Common sports-embed ad / adult networks — blocked in the Jiyu web session. */
const BROWSER_AD_BLOCK_URLS = [
  '*://fstream365.com/banner/*',
  '*://*.fstream365.com/banner/*',
  '*://app.adaround.net/*',
  '*://*.adaround.net/*',
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.adservice.google.com/*',
  '*://*.popads.net/*',
  '*://*.propellerads.com/*',
  '*://*.exoclick.com/*',
  '*://*.trafficjunky.net/*',
  '*://*.juicyads.com/*',
  '*://*.tsyndicate.com/*',
  '*://*.adsterra.com/*',
  '*://*.adnxs.com/*',
  '*://*.moatads.com/*',
  '*://*.taboola.com/*',
  '*://*.outbrain.com/*',
  '*://*.adultfriendfinder.com/*',
  '*://*.stripchat.com/*',
  '*://*.chaturbate.com/*',
  '*://*.pornhub.com/*',
  '*://*.xvideos.com/*',
  '*://*.xnxx.com/*',
  '*://*.xhamster.com/*',
  '*://*.spankwire.com/*',
  '*://*.livejasmin.com/*',
  '*://maleinsider.org/*',
  '*://*.maleinsider.org/*',
  '*://soulk.com/*',
  '*://*.soulk.com/*',
  '*://soulk.net/*',
  '*://*.soulk.net/*',
  // Sports-embed “Weiterleitung” / YouTube bait (CSP frame-ancestors none → ERR_BLOCKED_BY_RESPONSE)
  '*://yt.drimzzzz.info/*',
  '*://*.drimzzzz.info/*',
  '*://drimzzzz.info/*',
  '*://wpnxiswpuyrfn.icu/*',
  '*://*.wpnxiswpuyrfn.icu/*',
  '*://therocketlanguages.com/*',
  '*://*.therocketlanguages.com/*',
  '*://opera.com/*',
  '*://*.opera.com/*',
  '*://promo.worldofwarships.com/*',
  '*://*.worldofwarships.com/*',
  // Pre-roll “download our browser” adware (OperaSetup, etc.)
  '*://net.geo.opera.com/*',
  '*://*.geo.opera.com/*',
  '*://download.opera.com/*',
  '*://*.download.opera.com/*',
]

/** Installer / forced-download bait from embed ads (PRIMEROLL → OperaSetup.exe). */
function isBlockedBrowserDownloadUrl(url) {
  const raw = String(url || '')
  if (!raw) return false
  if (/utm_source=PRIMEROLL|OperaSetup|opera\/stable\/windows/i.test(raw)) return true
  if (/net\.geo\.opera\.com|download\.opera\.com|get\.opera\.com/i.test(raw)) return true
  if (/\.(exe|msi|dmg|pkg|bat|cmd|ps1|apk)(\?|#|$)/i.test(raw)) return true
  return false
}

/** Known ad / promo / bait URLs that must never take the player tile. */
function isAdHijackUrl(url) {
  const raw = String(url || '')
  if (!raw) return false
  if (
    /PWNgames|utm_source=PWN|OperaSetup|opera_gx|get\/opera|promo\.worldofwarships|worldofwarships\.com\/glow|utm_source=PRIMEROLL|download.*(browser|player)|install.*(browser|player)/i.test(
      raw,
    )
  ) {
    return true
  }
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase()
    if (
      /(^|\.)(drimzzzz\.info|wpnxiswpuyrfn\.icu|therocketlanguages\.com|opera\.com|geo\.opera\.com|download\.opera\.com|get\.opera\.com|worldofwarships\.com|wargaming\.net|wgcdn\.co|adaround\.net|popads\.net|propellerads\.com|exoclick\.com|trafficjunky\.net|juicyads\.com|tsyndicate\.com|adsterra\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|taboola\.com|outbrain\.com|adultfriendfinder\.com|stripchat\.com|chaturbate\.com|pornhub\.com|xvideos\.com|xnxx\.com|xhamster\.com|livejasmin\.com|maleinsider\.org|soulk\.com|soulk\.net)$/i.test(
        host,
      )
    ) {
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function shouldBlockBrowserNavigation(url) {
  return (
    isBlockedBrowserDownloadUrl(url) ||
    isAdHijackUrl(url) ||
    isDeadPlaceholderEmbedUrl(url) ||
    isStreamRefererOnlyUrl(url)
  )
}

/**
 * Movy / Atlantic site origins are Referer headers for HLS CDNs only.
 * Never open them as in-app browser documents (Warp interstitial, marketing pages).
 */
function isStreamRefererOnlyUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 'atlantic.st' || host.endsWith('.atlantic.st')) return true
    if (host === 'movy.sx' || host.endsWith('.movy.sx')) return true
    return false
  } catch {
    return false
  }
}

/** Fake / unresolvable hosts Rive (and others) sometimes hand off to — white screen. */
function isDeadPlaceholderEmbedUrl(url) {
  try {
    const raw = String(url || '')
    if (/\/undefined(?:\/|\?|#|$)/i.test(raw)) return true
    if (/[?&](?:tmdb|id|tv|movie)=undefined\b/i.test(raw)) return true
    if (/^chrome-error:|chromewebdata/i.test(raw)) return true
    const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase()
    if (!host) return false
    if (/(^|\.)example\.(com|net|org)$/i.test(host)) return true
    if (/(^|\.)invalid$/i.test(host)) return true
    if (/(^|\.)nextgencloudfabric\.com$/i.test(host)) return true
    if (host === '0.0.0.0') return true
    return false
  } catch {
    return false
  }
}

/** Any in-app player / embed host we treat as a locked watch surface. */
function isPlayerEmbedHost(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const path = parsed.pathname || ''
    return (
      host === 'embed.st' ||
      host.endsWith('.embed.st') ||
      host === 'embedhd.st' ||
      host.endsWith('.embedhd.st') ||
      host === 'embedindia.st' ||
      host.endsWith('.embedindia.st') ||
      host === 'streamed.pk' ||
      host.endsWith('.streamed.pk') ||
      host === 'ppv.st' ||
      host.endsWith('.ppv.st') ||
      host === 'rivestream.ru' ||
      host.endsWith('.rivestream.ru') ||
      host === 'fstream365.com' ||
      host.endsWith('.fstream365.com') ||
      host === 'vsembed.ru' ||
      host.endsWith('.vsembed.ru') ||
      host === 'vidsrc.to' ||
      host.endsWith('.vidsrc.to') ||
      host === 'vidsrc.me' ||
      host.endsWith('.vidsrc.me') ||
      host === 'vidlink.pro' ||
      host.endsWith('.vidlink.pro') ||
      host === 'primesrc.me' ||
      host.endsWith('.primesrc.me') ||
      host === 'vaplayer.ru' ||
      host.endsWith('.vaplayer.ru') ||
      host === 'vidup.to' ||
      host.endsWith('.vidup.to') ||
      host === 'streamingnow.mov' ||
      host.endsWith('.streamingnow.mov') ||
      host === 'player.cinezo.live' ||
      host.endsWith('.cinezo.live') ||
      host === 'player.videasy.to' ||
      host.endsWith('.videasy.to') ||
      host === 'mapple.fun' ||
      host.endsWith('.mapple.fun') ||
      host === 'player.vidzee.wtf' ||
      host.endsWith('.vidzee.wtf') ||
      host === 'vidsrcme.ru' ||
      host.endsWith('.vidsrcme.ru') ||
      host === 'vidsrc.sh' ||
      host.endsWith('.vidsrc.sh') ||
      host === 'cinetaro.to' ||
      host.endsWith('.cinetaro.to') ||
      host === 'cinextream.cc' ||
      host.endsWith('.cinextream.cc') ||
      host === 'ww.ymovies.vip' ||
      host.endsWith('.ymovies.vip') ||
      host === 'soccerfull.net' ||
      host.endsWith('.soccerfull.net') ||
      host === 'livextv.hybrows.workers.dev' ||
      host.includes('livextv') ||
      // DoodStream-style VOD mirrors used by LiveXTV replays.
      /^\/[de]\/[a-z0-9]{6,}/i.test(path) ||
      host.includes('netmirror') ||
      host.includes('mcloud') ||
      (/(^|\.)ww\d*\.surf$/i.test(host) && /netmirror/i.test(path))
    )
  } catch {
    return false
  }
}

function browserHostKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function sameBrowserSite(a, b) {
  const ha = browserHostKey(a)
  const hb = browserHostKey(b)
  if (!ha || !hb) return false
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`)
}

/**
 * While the tile is on a player embed, only same-site / player-CDN / media
 * navigations are allowed — everything else is treated as a hijack.
 */
function isAllowedPlayerNav(fromUrl, toUrl) {
  const raw = String(toUrl || '')
  if (!raw || /^(about:blank|about:srcdoc|chrome:|chrome-error:|data:)/i.test(raw)) return true
  if (shouldBlockBrowserNavigation(raw)) return false
  if (isPlayerEmbedHost(raw)) return true
  if (fromUrl && sameBrowserSite(fromUrl, raw)) return true
  try {
    const u = new URL(raw)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    const path = u.pathname.toLowerCase()
    if (
      /(^|\.)(b-cdn\.net|cloudfront\.net|akamaized\.net|akamaihd\.net|fastly\.net|jsdelivr\.net|unpkg\.com|clappr\.io|jwpcdn\.com|jwplatform\.com|strmd\.|cdn\.streamed|ppvservices\.st|embed\.ppv\.st|videodelivery\.net|mux\.com)$/i.test(
        host,
      )
    ) {
      return true
    }
    if (/\.(m3u8|mp4|ts|m4s|webm|mkv)(\?|$)/i.test(path)) return true
  } catch {
    return false
  }
  return false
}

/** Lock the BrowserView onto the current player embed — block off-site ad hijacks. */
function installEmbedNavGuard(contents) {
  if (!contents || contents.isDestroyed() || contents.__jiyuEmbedNavGuard) return
  contents.__jiyuEmbedNavGuard = true
  let lastEmbedUrl = ''
  const remember = (url) => {
    if (isPlayerEmbedHost(url)) lastEmbedUrl = String(url || '')
    try {
      const fs = require('fs')
      const path = require('path')
      const file = path.join(app.getPath('userData'), 'browser-now.json')
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            url: String(url || ''),
            lastEmbedUrl: lastEmbedUrl || null,
          },
          null,
          2,
        ),
      )
    } catch {
      /* ignore */
    }
  }
  try {
    remember(contents.getURL())
  } catch {
    /* ignore */
  }
  contents.on('did-navigate', (_event, url) => {
    remember(url)
  })
  contents.on('did-navigate-in-page', (_event, url) => {
    remember(url)
  })
  contents.on('will-navigate', (event, url) => {
    if (isStreamRefererOnlyUrl(url)) {
      event.preventDefault()
      console.log('[browser] blocked stream-referer page', String(url || '').slice(0, 140))
      return
    }
    if (isDeadPlaceholderEmbedUrl(url)) {
      event.preventDefault()
      console.log('[browser] blocked dead embed host', String(url || '').slice(0, 140))
      let current = ''
      try {
        current = contents.getURL() || ''
      } catch {
        current = ''
      }
      if (
        /rivestream\.(ru|app)|vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me/i.test(
          current,
        )
      ) {
        forceRiveEmbedHop(contents, 'nav-dead-host')
      } else if (lastEmbedUrl && /rivestream\.(ru|app)/i.test(lastEmbedUrl)) {
        void contents.loadURL(lastEmbedUrl).then(() => {
          setTimeout(() => scheduleRiveEmbedAuto(contents), 400)
        }).catch(() => {})
      }
      return
    }
    if (shouldBlockBrowserNavigation(url)) {
      event.preventDefault()
      console.log('[browser] blocked ad nav', String(url || '').slice(0, 140))
      return
    }
    let current = ''
    try {
      current = contents.getURL() || ''
    } catch {
      current = ''
    }
    const locked = isPlayerEmbedHost(current) || isPlayerEmbedHost(lastEmbedUrl)
    if (!locked) return
    const from = isPlayerEmbedHost(current) ? current : lastEmbedUrl
    if (isAllowedPlayerNav(from, url)) return
    event.preventDefault()
    console.log('[browser] blocked embed hijack', String(url || '').slice(0, 140))
    if (/^https?:\/\//i.test(url)) showAdDock(url)
  })
  try {
    contents.on('will-frame-navigate', (details) => {
      const target = details?.url
      if (!shouldBlockBrowserNavigation(target)) return
      details.preventDefault?.()
      if (isDeadPlaceholderEmbedUrl(target)) {
        forceRiveEmbedHop(contents, 'frame-nav-dead-host')
      }
    })
  } catch {
    /* older Electron */
  }
  contents.on('did-finish-load', () => {
    let current = ''
    try {
      current = contents.getURL() || ''
    } catch {
      return
    }
    if (!lastEmbedUrl) return
    if (isPlayerEmbedHost(current) || isAllowedPlayerNav(lastEmbedUrl, current)) return
    console.log('[browser] restoring embed after hijack', current.slice(0, 120))
    void contents.loadURL(lastEmbedUrl).catch(() => {})
  })
}

function installWebSessionDownloadGuard(ses) {
  if (!ses || ses.__jiyuDownloadGuard) return
  ses.__jiyuDownloadGuard = true
  ses.on('will-download', (event, item) => {
    const url = (() => {
      try {
        return item.getURL()
      } catch {
        return ''
      }
    })()
    const name = (() => {
      try {
        return item.getFilename()
      } catch {
        return ''
      }
    })()
    // Never allow embeds to push installers / random files into a Save dialog.
    event.preventDefault()
    try {
      item.cancel()
    } catch {
      /* ignore */
    }
    console.log('[browser] blocked download', name || url.slice(0, 160))
  })
}

function isSportsEmbedHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    return (
      host === 'embed.st' ||
      host.endsWith('.embed.st') ||
      host === 'embedhd.st' ||
      host.endsWith('.embedhd.st') ||
      host === 'embedindia.st' ||
      host.endsWith('.embedindia.st') ||
      host === 'streamed.pk' ||
      host.endsWith('.streamed.pk') ||
      host === 'ppv.st' ||
      host.endsWith('.ppv.st')
    )
  } catch {
    return false
  }
}

/**
 * Live sports OR Replay VOD embeds — both need the main-process play kick
 * (muted→unmute + at most one center click). Replay hosts were previously
 * excluded, so soccerfull/Dood loaded a frame then sat paused.
 */
function needsSportsStyleAutoplay(url) {
  return isSportsEmbedHost(url) || isReplayAdSensitiveUrl(url)
}

/**
 * LiveXTV / soccerfull / DoodStream-style VOD hosts refuse playback when they
 * detect adblock (bait .adsbox CSS + blocked googlesyndication). Soften shield.
 */
function isReplayAdSensitiveUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 'soccerfull.net' || host.endsWith('.soccerfull.net')) return true
    if (host.includes('livextv')) return true
    if (host === 'footreplays.com' || host.endsWith('.footreplays.com')) return true
    // DoodStream mirrors: /d/{id} or /e/{id} short paths on rotating hosts.
    if (/^\/[de]\/[a-z0-9]{6,}/i.test(parsed.pathname || '')) return true
    return false
  } catch {
    return false
  }
}

function browserSessionAllowsReplayAds() {
  const urls = []
  try {
    if (webBrowserView && !webBrowserView.webContents.isDestroyed()) {
      urls.push(webBrowserView.webContents.getURL() || '')
    }
  } catch {
    /* ignore */
  }
  try {
    for (const view of multiWebViews.values()) {
      if (view && !view.webContents.isDestroyed()) {
        urls.push(view.webContents.getURL() || '')
      }
    }
  } catch {
    /* ignore */
  }
  return urls.some((u) => isReplayAdSensitiveUrl(u))
}

function isGoogleAdsNetworkHost(host) {
  const h = String(host || '')
    .replace(/^www\./i, '')
    .toLowerCase()
  return /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|googletagservices\.com|googletagmanager\.com)$/i.test(
    h,
  )
}

function isLikelyAdFrameUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    const path = new URL(url).pathname.toLowerCase()
    return (
      /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|popads\.net|propellerads\.com|exoclick\.com|trafficjunky\.net|juicyads\.com|adnxs\.com|moatads\.com|taboola\.com|outbrain\.com|adaround\.net)$/i.test(
        host,
      ) ||
      /\/banner\//i.test(path)
    )
  } catch {
    return false
  }
}

/** Cap hung executeJavaScript on dead/ad iframes (sports embeds spawn many). */
function raceFrameExec(promise, ms = 1200) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame-exec-timeout')), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Collect BrowserView frames, sports/player first, skip obvious ad iframes.
 * @param {Electron.WebContents} contents
 * @param {{ maxFrames?: number }} [options]
 */
function collectContentFrames(contents, options = {}) {
  const maxFrames = Math.max(1, Number(options.maxFrames) || 8)
  const frames = []
  try {
    const root = contents.mainFrame
    if (root?.framesInSubtree?.length) frames.push(...root.framesInSubtree)
    else if (root) {
      const walk = (frame) => {
        if (!frame) return
        frames.push(frame)
        for (const child of frame.frames || []) walk(child)
      }
      walk(root)
    }
  } catch {
    /* ignore */
  }
  if (frames.length === 0 && contents.mainFrame) frames.push(contents.mainFrame)

  const scored = frames.filter(Boolean).map((frame) => {
    const url = String(frame.url || '')
    let score = 1
    if (!url || url === 'about:blank') score = 0
    else if (isSportsEmbedHost(url) || isReplayAdSensitiveUrl(url)) score = 20
    else if (/player|embed|stream|hls|video/i.test(url)) score = 8
    else if (isLikelyAdFrameUrl(url)) score = -50
    return { frame, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const usable = scored.filter((row) => row.score >= 0)
  const pick = (usable.length ? usable : scored).slice(0, maxFrames)
  return pick.map((row) => row.frame)
}

/** Soften overlays + trap window.open so ads don't steal the main player. */
const BROWSER_AD_SHIELD_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    const path = String(location.pathname || '');
    // Wait for real navigation — blank frames must not lock in the hard shield.
    if (!host || /^about:/i.test(String(location.protocol || ''))) return 'skip-blank';
    // LiveXTV / soccerfull / DoodStream VODs detect .adsbox bait + blocked ad scripts.
    const replayAds =
      /(^|\\.)soccerfull\\.net$/i.test(host) ||
      /livextv/i.test(host) ||
      /(^|\\.)footreplays\\.com$/i.test(host) ||
      /^\\/[de]\\/[a-z0-9]{6,}/i.test(path);
    // Always re-assert — early-return must not skip FS block on later injects.
    try {
      if (!window.__jiyuFsBlocked) {
        window.__jiyuFsBlocked = true;
        const reject = () => Promise.reject(new DOMException('Fullscreen blocked in Jiyu', 'NotAllowedError'));
        const patch = (proto, key) => {
          try {
            if (proto && typeof proto[key] === 'function') proto[key] = reject;
          } catch (_) {}
        };
        patch(Element.prototype, 'requestFullscreen');
        patch(Element.prototype, 'webkitRequestFullscreen');
        patch(Element.prototype, 'webkitRequestFullScreen');
        patch(HTMLElement.prototype, 'webkitRequestFullScreen');
      }
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        if (document.webkitFullscreenElement) document.webkitExitFullscreen();
      } catch (_) {}
    } catch (_) {}
    if (window.__jiyuAdShield) return 'bound';
    window.__jiyuAdShield = true;
    const report = (url) => {
      try { console.log('jiyu-ad-open:' + String(url || '')); } catch (_) {}
    };
    const wrapOpen = () => {
      try {
        const nativeOpen = window.open;
        window.open = function (url) {
          report(url);
          return null;
        };
        window.open.__jiyuWrapped = true;
        window.open.toString = () => 'function open() { [native code] }';
        void nativeOpen;
      } catch (_) {}
    };
    // Fake notification interstitials (treasure chest / "You received a message!" / OK).
    // Narrow text match only — never touch .adsbox bait nodes on replay hosts.
    const hideFakePushAds = () => {
      try {
        const looksFake = (text) => {
          if (!text) return false;
          if (/You received a message!?/i.test(text)) return true;
          if (/You have (?:a |received a )?message!?/i.test(text)) return true;
          if (/New message!?/i.test(text) && /\bOK\b/i.test(text)) return true;
          if (/A Surprise Is Waiting/i.test(text) && /OPEN\\s*NOW/i.test(text)) return true;
          if (
            /(?:push|browser)\\s+notification/i.test(text) &&
            /\b(?:OK|Allow|Accept|Open)\\b/i.test(text) &&
            text.length < 280
          ) {
            return true;
          }
          return false;
        };
        const nodes = document.querySelectorAll('div,section,aside,article');
        for (const el of nodes) {
          if (!el || el.getAttribute('data-jiyu-ad-hide') === '1') continue;
          let text = '';
          try { text = String(el.innerText || el.textContent || ''); } catch (_) { continue; }
          text = text.replace(/\\s+/g, ' ').trim();
          if (!text || text.length > 360) continue;
          if (!looksFake(text)) continue;
          let target = el;
          try {
            for (let i = 0; i < 6 && target.parentElement; i += 1) {
              const parent = target.parentElement;
              if (!parent || parent === document.body || parent === document.documentElement) break;
              const st = window.getComputedStyle(parent);
              const pos = st ? String(st.position || '') : '';
              if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
                target = parent;
                break;
              }
              let parentText = '';
              try { parentText = String(parent.innerText || '').replace(/\\s+/g, ' ').trim(); } catch (_) {}
              if (parentText && parentText.length <= text.length + 64 && looksFake(parentText)) {
                target = parent;
                continue;
              }
              break;
            }
          } catch (_) {}
          try {
            target.setAttribute('data-jiyu-ad-hide', '1');
            target.style.setProperty('display', 'none', 'important');
            target.style.setProperty('visibility', 'hidden', 'important');
            target.style.setProperty('pointer-events', 'none', 'important');
            target.style.setProperty('opacity', '0', 'important');
            try { target.remove(); } catch (_) {}
          } catch (_) {}
        }
      } catch (_) {}
    };
    const armFakePushWatch = () => {
      try {
        hideFakePushAds();
        if (window.__jiyuSurpriseObs || !document.documentElement) return;
        let scheduled = 0;
        const kick = () => {
          if (scheduled) return;
          scheduled = window.setTimeout(() => {
            scheduled = 0;
            try { hideFakePushAds(); } catch (_) {}
          }, 200);
        };
        const obs = new MutationObserver(kick);
        obs.observe(document.documentElement, { childList: true, subtree: true });
        window.__jiyuSurpriseObs = obs;
        window.setInterval(() => {
          try { hideFakePushAds(); } catch (_) {}
        }, 2000);
      } catch (_) {
        try { hideFakePushAds(); } catch (_) {}
      }
    };
    if (replayAds) {
      // Keep FS block + route popups to the ad dock, but do NOT hide bait nodes
      // or ad iframes — those hosts refuse to start the video otherwise.
      wrapOpen();
      armFakePushWatch();
      return 'replay-soft';
    }
    try {
      const style = document.createElement('style');
      style.id = 'jiyu-ad-shield';
      style.textContent = [
        'iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="popads"],',
        'iframe[src*="exoclick"],iframe[src*="trafficjunky"],iframe[src*="juicyads"],',
        'iframe[src*="pornhub"],iframe[src*="xvideos"],iframe[src*="xnxx"],',
        'iframe[src*="chaturbate"],iframe[src*="stripchat"],iframe[src*="livejasmin"],',
        '[id*="ad-overlay"],[class*="ad-overlay"],[id*="adsbox"],[class*="adsbox"],',
        '#ol-ads,[class*="pop-under"],[class*="popunder"],',
        '[data-jiyu-ad-hide="1"]',
        '{ display:none !important; visibility:hidden !important; pointer-events:none !important; }',
      ].join('');
      (document.documentElement || document.head || document.body)?.appendChild(style);
    } catch (_) {}
    wrapOpen();
    armFakePushWatch();
    return 'bound';
  } catch (_) {
    return 'error';
  }
})();`

/**
 * Rive embed (rivestream.ru/embed): Direct mode auto-rotates; Embed does not.
 * Seed Embed + Fast-Server (ADF) before page JS, then hop starred servers on error.
 */
/** Self-contained hop — jump straight to the next known embed host (skip dead PRIME/ADF shells). */
const RIVESTREAM_FORCE_HOP_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    const ORDER = ['VUP','VIDZ','CIN','MAP','SUP','AGGREGATOR','TORR','VAP','EASY','PRIME','SMASH','VID','ADF'];
    const HOP_KEY = 'jiyu.rive.hopIdx';
    const EP_KEY = 'jiyu.rive.hopEp';
    const LAST_KEY = 'jiyu.rive.lastGood';

    const parseTv = () => {
      try {
        const u = new URL(location.href);
        let id = u.searchParams.get('id') || u.searchParams.get('tmdb') || '';
        let season = u.searchParams.get('season') || '1';
        let episode = u.searchParams.get('episode') || '1';
        const m = u.pathname.match(/\\/(?:embed\\/)?tv\\/(\\d+)(?:\\/(\\d+)(?:\\/(\\d+))?)?/i);
        if (m) {
          id = id || m[1];
          season = m[2] || season;
          episode = m[3] || episode;
        }
        const m2 = u.pathname.match(/\\/tv\\/(\\d+)-(\\d+)-(\\d+)/i);
        if (m2) {
          id = id || m2[1];
          season = m2[2] || season;
          episode = m2[3] || episode;
        }
        if (!id) {
          try {
            id = String(sessionStorage.getItem('jiyu.rive.tmdb') || '');
            season = String(sessionStorage.getItem('jiyu.rive.season') || season);
            episode = String(sessionStorage.getItem('jiyu.rive.episode') || episode);
          } catch (_) {}
        }
        return { id: String(id || '').trim(), season: String(season || '1'), episode: String(episode || '1') };
      } catch (_) {
        return { id: '', season: '1', episode: '1' };
      }
    };

    const directFor = (code, id, season, episode) => {
      if (!id) return null;
      const s = season || '1';
      const e = episode || '1';
      switch (code) {
        case 'VAP': return 'https://vaplayer.ru/embed/tv/' + id + '/' + s + '/' + e;
        case 'VUP': return 'https://vidup.to/tv/' + id + '/' + s + '/' + e + '?autoPlay=true';
        case 'EASY': return 'https://player.videasy.to/tv/' + id + '/' + s + '/' + e;
        case 'CIN': return 'https://player.cinezo.live/embed/tv/' + id + '/' + s + '/' + e + '?autoplay=true&poster=true';
        case 'VIDZ': return 'https://player.vidzee.wtf/embed/tv/' + id + '/' + s + '/' + e;
        case 'SUP': return null; // needs Rive tokenized streamingnow URL
        case 'AGGREGATOR': return 'https://rivestream.ru/embed/agg?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'MAP': return 'https://mapple.fun/watch/tv/' + id + '-' + s + '-' + e + '?nextButton=true&autoPlay=true&autoNext=true';
        case 'TORR': return 'https://rivestream.ru/embed/torrent?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'PRIME': return 'https://primesrc.me/embed/tv?tmdb=' + id + '&season=' + s + '&episode=' + e;
        default: return null;
      }
    };

    const { id, season, episode } = parseTv();
    if (id) {
      try {
        sessionStorage.setItem('jiyu.rive.tmdb', id);
        sessionStorage.setItem('jiyu.rive.season', season);
        sessionStorage.setItem('jiyu.rive.episode', episode);
        sessionStorage.setItem(EP_KEY, 'tv:' + id + ':' + season + ':' + episode);
      } catch (_) {}
    }

    let idx = 0;
    try {
      const raw = sessionStorage.getItem(HOP_KEY);
      if (raw != null && Number.isFinite(Number(raw))) {
        idx = Number(raw) || 0;
      } else {
        const cur = String(localStorage.getItem('RiveStreamLatestAgg') || '').trim();
        const at = ORDER.indexOf(cur);
        idx = at >= 0 ? at : 0;
      }
    } catch (_) {}

    for (let step = 1; step <= ORDER.length; step += 1) {
      const next = idx + step;
      if (next >= ORDER.length) break;
      const code = ORDER[next];
      const target = directFor(code, id, season, episode);
      if (!target && code !== 'SUP') continue;
      try { sessionStorage.setItem(HOP_KEY, String(next)); } catch (_) {}
      try {
        localStorage.setItem('RiveStreamWatchMode', 'embed');
        localStorage.setItem('RiveStreamEmbedMode', 'true');
        localStorage.setItem('RiveStreamLatestAgg', code);
        localStorage.removeItem(LAST_KEY);
      } catch (_) {}
      console.log('jiyu-rive-force-hop:' + code);
      if (target) {
        location.replace(target);
        return code;
      }
      // SUP etc. — fall back to Rive shell with seeded aggregator.
      location.replace(
        'https://rivestream.ru/embed?type=tv&id=' + encodeURIComponent(id) +
        '&season=' + encodeURIComponent(season) + '&episode=' + encodeURIComponent(episode) + '#jiyuAuto=1'
      );
      return code;
    }

    try {
      if (!document.getElementById('jiyu-rive-no-source')) {
        const banner = document.createElement('div');
        banner.id = 'jiyu-rive-no-source';
        banner.textContent = 'No working RiveStream source for this episode.';
        banner.setAttribute('style',
          'position:fixed;inset:auto 12px 12px 12px;z-index:2147483647;padding:12px 14px;' +
          'border-radius:10px;background:rgba(12,14,18,0.92);color:#f3f6fb;font:600 14px/1.35 Segoe UI,sans-serif;' +
          'border:1px solid rgba(255,255,255,0.12);pointer-events:none;');
        (document.body || document.documentElement).appendChild(banner);
      }
    } catch (_) {}
    return 'exhausted';
  } catch (e) {
    return 'err';
  }
})();`

const RIVESTREAM_EMBED_AUTO_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    const onRive = /(^|\\.)rivestream\\.(ru|app)$/i.test(host);
    const onDirect =
      /(^|\\.)(vaplayer\\.ru|vidup\\.to|videasy\\.to|cinezo\\.live|vidzee\\.wtf|mapple\\.fun|primesrc\\.me|streamingnow\\.mov)$/i.test(host);
    if (!onRive && !onDirect) return 'skip-host';

    // Prefer path-based hosts. VAP shells nextgencloudfabric "Cloud:" ads then whites.
    const ORDER = ['VUP','VIDZ','CIN','MAP','SUP','AGGREGATOR','TORR','VAP','EASY','PRIME','SMASH','VID','ADF'];
    const LAST_KEY = 'jiyu.rive.lastGood';
    const HOP_KEY = 'jiyu.rive.hopIdx';
    const EP_KEY = 'jiyu.rive.hopEp';

    const parseTv = () => {
      try {
        const u = new URL(location.href);
        let id = u.searchParams.get('id') || u.searchParams.get('tmdb') || '';
        let season = u.searchParams.get('season') || '1';
        let episode = u.searchParams.get('episode') || '1';
        const m = u.pathname.match(/\\/(?:embed\\/)?tv\\/(\\d+)(?:\\/(\\d+)(?:\\/(\\d+))?)?/i);
        if (m) {
          id = id || m[1];
          season = m[2] || season;
          episode = m[3] || episode;
        }
        const m2 = u.pathname.match(/\\/tv\\/(\\d+)-(\\d+)-(\\d+)/i);
        if (m2) {
          id = id || m2[1];
          season = m2[2] || season;
          episode = m2[3] || episode;
        }
        if (!id) {
          try {
            id = String(sessionStorage.getItem('jiyu.rive.tmdb') || '');
            season = String(sessionStorage.getItem('jiyu.rive.season') || season);
            episode = String(sessionStorage.getItem('jiyu.rive.episode') || episode);
          } catch (_) {}
        }
        return { id: String(id || '').trim(), season: String(season || '1'), episode: String(episode || '1') };
      } catch (_) {
        return { id: '', season: '1', episode: '1' };
      }
    };

    const directFor = (code, id, season, episode) => {
      if (!id) return null;
      const s = season || '1';
      const e = episode || '1';
      switch (code) {
        case 'VAP': return 'https://vaplayer.ru/embed/tv/' + id + '/' + s + '/' + e;
        case 'VUP': return 'https://vidup.to/tv/' + id + '/' + s + '/' + e + '?autoPlay=true';
        case 'EASY': return 'https://player.videasy.to/tv/' + id + '/' + s + '/' + e;
        case 'CIN': return 'https://player.cinezo.live/embed/tv/' + id + '/' + s + '/' + e + '?autoplay=true&poster=true';
        case 'VIDZ': return 'https://player.vidzee.wtf/embed/tv/' + id + '/' + s + '/' + e;
        case 'AGGREGATOR': return 'https://rivestream.ru/embed/agg?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'MAP': return 'https://mapple.fun/watch/tv/' + id + '-' + s + '-' + e + '?nextButton=true&autoPlay=true&autoNext=true';
        case 'TORR': return 'https://rivestream.ru/embed/torrent?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'PRIME': return 'https://primesrc.me/embed/tv?tmdb=' + id + '&season=' + s + '&episode=' + e;
        default: return null;
      }
    };

    const seedPrefs = (code) => {
      try {
        // Prefer Direct (Vanguard/Citadel/…) first; Embed servers are hop fallback.
        localStorage.setItem('RiveStreamWatchMode', 'direct');
        localStorage.setItem('RiveStreamEmbedMode', 'false');
        if (code) localStorage.setItem('RiveStreamLatestAgg', code);
      } catch (_) {}
    };

    const seedEmbedPrefs = (code) => {
      try {
        localStorage.setItem('RiveStreamWatchMode', 'embed');
        localStorage.setItem('RiveStreamEmbedMode', 'true');
        if (code) localStorage.setItem('RiveStreamLatestAgg', code);
      } catch (_) {}
    };

    const { id: tvId, season: tvSeason, episode: tvEpisode } = parseTv();
    if (tvId) {
      try {
        sessionStorage.setItem('jiyu.rive.tmdb', tvId);
        sessionStorage.setItem('jiyu.rive.season', tvSeason);
        sessionStorage.setItem('jiyu.rive.episode', tvEpisode);
        const ep = 'tv:' + tvId + ':' + tvSeason + ':' + tvEpisode;
        if (sessionStorage.getItem(EP_KEY) !== ep) {
          sessionStorage.setItem(EP_KEY, ep);
          sessionStorage.removeItem(HOP_KEY);
        }
      } catch (_) {}
    }

    const prefer = (() => {
      try {
        const hopRaw = sessionStorage.getItem(HOP_KEY);
        if (hopRaw != null) {
          const idx = Number(hopRaw);
          if (Number.isFinite(idx) && ORDER[idx]) return ORDER[idx];
        }
        const last = String(localStorage.getItem(LAST_KEY) || '').trim();
        if (last && ORDER.includes(last) && last !== 'ADF' && last !== 'PRIME' && last !== 'VAP') return last;
      } catch (_) {}
      return 'VUP';
    })();

    // Stay on Rivestream Direct first. Only hop to Embed hosts after Direct fails.
    const hoppingToEmbed = (() => {
      try { return sessionStorage.getItem(HOP_KEY) != null; } catch (_) { return false; }
    })();
    if (hoppingToEmbed) seedEmbedPrefs(prefer);
    else seedPrefs(prefer);

    // Click Direct mode control when still on the Rive shell.
    if (onRive && !hoppingToEmbed) {
      const clickDirect = () => {
        try {
          for (const el of Array.from(document.querySelectorAll('button, [role="button"], div, span, label, a'))) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.closest('video, audio, iframe')) continue;
            const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
              .replace(/\\s+/g, ' ').trim();
            if (!label || label.length > 48) continue;
            if (!/^direct$/i.test(label) && !/^playback\\s*mode\\s*:?\\s*direct$/i.test(label)) continue;
            el.click();
            return;
          }
        } catch (_) {}
      };
      clickDirect();
      setTimeout(clickDirect, 700);
      setTimeout(clickDirect, 1800);
    }

    // When already hopping, jump once to an Embed player URL.
    if (hoppingToEmbed && onRive && /\\/embed/i.test(String(location.pathname || '') + String(location.search || '')) && !/\\/embed\\/(agg|torrent)/i.test(location.pathname || '')) {
      const jumpKey = 'jiyu.rive.directJump:' + (tvId || '') + ':' + tvSeason + ':' + tvEpisode;
      let already = false;
      try { already = sessionStorage.getItem(jumpKey) === '1'; } catch (_) {}
      const target = directFor(prefer, tvId, tvSeason, tvEpisode);
      if (target && !already && !window.__jiyuRiveDirectJump) {
        window.__jiyuRiveDirectJump = true;
        try { sessionStorage.setItem(jumpKey, '1'); } catch (_) {}
        console.log('jiyu-rive-embed-jump:' + prefer);
        location.replace(target);
        return 'embed-jump';
      }
    }

    const isBrokenSrc = (src) => {
      const s = String(src || '');
      if (!s || s === 'about:blank') return false;
      if (/\\/undefined(?:\\/|\\?|#|$)/i.test(s)) return true;
      if (/[?&](?:tmdb|id)=undefined\\b/i.test(s)) return true;
      if (/chrome-error:|chromewebdata/i.test(s)) return true;
      try {
        const h = new URL(s, location.href).hostname.replace(/^www\\./i, '').toLowerCase();
        if (/(^|\\.)example\\.(com|net|org)$/i.test(h)) return true;
        if (/(^|\\.)invalid$/i.test(h)) return true;
        // VAP handoff that only paints Cloud: ad tips (no real stream for many titles).
        if (/(^|\\.)nextgencloudfabric\\.com$/i.test(h)) return true;
      } catch (_) {}
      return false;
    };

    const textLooksDead = () => {
      const t = String(document.body && document.body.innerText || '');
      // Loading copy is not a failure — hopping here caused white↔spinner flashes.
      if (/getting things ready|loading|buffering|please wait/i.test(t)) return false;
      return /Cloud:\\s*use AD-Blocker|Cloud:\\s*use video downloader|no working sources|access denied|http error 403|err_name_not_resolved|Firefox Can't Open This Page|will not allow Firefox to display|X-Frame-Options|to protect your security/i.test(t);
    };

    const hideServerChrome = () => {
      if (!onRive) return;
      try {
        let style = document.getElementById('jiyu-rive-hide-servers');
        if (!style) {
          style = document.createElement('style');
          style.id = 'jiyu-rive-hide-servers';
          (document.head || document.documentElement).appendChild(style);
        }
        const PROVIDER =
          /\\b(Vanguard|Citadel|FlowCast|Flowcast|Apex|Pulse|Nova|Hydra|Shadow|Astra|Zenith|Orion|Vertex|Prism|Forge|Beacon|Harbor|Summit|Cascade)\\b/i;
        style.textContent = [
          '[aria-label="Playback Mode"],',
          '[aria-label="Select Aggregator Server"],',
          '[aria-label="Select Direct Server"],',
          '[aria-label="Select Local Media Server"],',
          '[aria-label="Select Server"],',
          '[aria-label*="Server"], [aria-label*="server"],',
          '[aria-label*="Playback Mode"],',
          '[aria-label*="Controls Bar"], [aria-label*="controls bar"],',
          '[title*="Controls Bar"],',
          '[aria-label="Expand Controls Bar"], [aria-label="Shrink Controls Bar"],',
          '[title="Expand Controls Bar"], [title="Shrink Controls Bar"],',
          '[aria-label*="Quick Menu"], [aria-label*="quick menu"], [title*="Quick Menu"],',
          'button#source, button[name="source"],',
          'select#watchMode, select[name="watchMode"],',
          '[class*="watchBar"], [class*="WatchBar"],',
          '[class*="modeSelect"], [class*="serverSelect"], [class*="ServerSelect"],',
          '[class*="selectWrapper"], [class*="pillText"], [class*="pillChevron"],',
          '[class*="expandedContent"], [class*="collapsedContent"],',
          '[class*="collapsedState"], [class*="expandedState"],',
          '[class*="hideNavBtn"], [class*="sourceBar"], [class*="SourceBar"],',
          '[class*="quickMenu"], [class*="QuickMenu"]',
          '{ display: none !important; visibility: hidden !important; opacity: 0 !important;',
          '  pointer-events: none !important; height: 0 !important; max-height: 0 !important;',
          '  overflow: hidden !important; margin: 0 !important; padding: 0 !important; }',
        ].join('');
        const kill = (el) => {
          if (!(el instanceof HTMLElement)) return;
          if (el.closest('video, audio, iframe')) return;
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.style.setProperty('height', '0', 'important');
          el.style.setProperty('max-height', '0', 'important');
          el.style.setProperty('overflow', 'hidden', 'important');
        };
        const killBar = (el) => {
          kill(el);
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            if (p === document.body || p === document.documentElement) break;
            const pt = String(p.textContent || '').replace(/\\s+/g, ' ').trim();
            if (pt.length > 220) break;
            const hasMode = /\\b(Direct|Embed)\\b/i.test(pt);
            const hasServer = PROVIDER.test(pt) || /\\bServer\\s*\\d+/i.test(pt) || /\\b\\d{3,4}p\\b/i.test(pt);
            if (hasMode && hasServer) kill(p);
            p = p.parentElement;
          }
        };
        for (const el of Array.from(document.querySelectorAll(
          '[aria-label*="Controls Bar"], [aria-label*="controls bar"], [aria-label*="Server"], [aria-label*="server"],' +
          '[aria-label*="Playback Mode"], [aria-label*="Quick Menu"],' +
          '[class*="watchBar"], [class*="serverSelect"], [class*="sourceBar"], [class*="quickMenu"], [class*="QuickMenu"]',
        ))) {
          kill(el);
        }
        for (const el of Array.from(document.querySelectorAll('button, div, span, section, nav, label, a'))) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.closest('video, audio, iframe')) continue;
          const raw = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!raw || raw.length > 160) continue;
          if (/Servers\\s*&\\s*Mode/i.test(raw) || /^QUICK\\s*MENU$/i.test(raw)) {
            killBar(el);
            continue;
          }
          const looksLikeServerCapsule =
            !el.querySelector('iframe, video') &&
            (
              (/\\bDirect\\b/i.test(raw) && (PROVIDER.test(raw) || /\\b\\d{3,4}p\\b/i.test(raw))) ||
              (/\\bEmbed\\b/i.test(raw) && /\\bServer\\s*\\d+/i.test(raw))
            );
          if (looksLikeServerCapsule) killBar(el);
        }
      } catch (_) {}
    };

    const nudgePlay = () => {
      try {
        for (const v of Array.from(document.querySelectorAll('video'))) {
          try { v.muted = false; v.play?.(); } catch (_) {}
        }
        const hit = Array.from(document.querySelectorAll('button, [role="button"], div, span')).find((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const t = String(el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!t || t.length > 40) return false;
          return /^(play|watch|start)$/i.test(t) || /^play\\b/i.test(t);
        });
        if (hit) hit.click();
        else {
          const mid = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
          if (mid) mid.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      } catch (_) {}
    };

    const hasBrokenFrame = () =>
      Array.from(document.querySelectorAll('iframe[src]')).some((f) => isBrokenSrc(f.getAttribute('src')));

    const hasPlayerFrame = () => {
      const frames = Array.from(document.querySelectorAll('iframe[src]'));
      const okFrame = frames.some((f) => {
        const src = String(f.getAttribute('src') || '');
        if (!src || src === 'about:blank' || isBrokenSrc(src)) return false;
        const r = f.getBoundingClientRect();
        return r.width > 120 && r.height > 80;
      });
      if (okFrame) return true;
      return Array.from(document.querySelectorAll('video')).some((v) => {
        try {
          return v.readyState >= 2 && (v.videoWidth > 0 || v.currentTime > 0);
        } catch (_) {
          return false;
        }
      });
    };

    const hop = (reason) => {
      if (window.__jiyuRiveHopping) return 'busy';
      const now = Date.now();
      if (window.__jiyuRiveLastHopAt && now - window.__jiyuRiveLastHopAt < 12000) return 'cooldown';
      window.__jiyuRiveHopping = true;
      window.__jiyuRiveLastHopAt = now;
      let idx = 0;
      try {
        const raw = sessionStorage.getItem(HOP_KEY);
        if (raw != null) idx = Number(raw) || 0;
        else idx = -1; // first Direct→Embed hop starts at ORDER[0]
      } catch (_) {
        idx = -1;
      }
      for (let step = 1; step <= ORDER.length; step += 1) {
        const next = idx + step;
        if (next >= ORDER.length) break;
        const code = ORDER[next];
        const target = directFor(code, tvId, tvSeason, tvEpisode);
        if (!target && code !== 'SUP' && code !== 'SMASH' && code !== 'VID' && code !== 'ADF') continue;
        try { sessionStorage.setItem(HOP_KEY, String(next)); } catch (_) {}
        seedEmbedPrefs(code);
        try { localStorage.removeItem(LAST_KEY); } catch (_) {}
        console.log('jiyu-rive-hop:' + code + ':' + String(reason || ''));
        if (target) {
          location.replace(target);
          return true;
        }
        if (tvId) {
          location.replace(
            'https://rivestream.ru/embed?type=tv&id=' + encodeURIComponent(tvId) +
            '&season=' + encodeURIComponent(tvSeason) + '&episode=' + encodeURIComponent(tvEpisode) + '#jiyuAuto=1'
          );
          return true;
        }
      }
      window.__jiyuRiveHopping = false;
      try {
        console.log('jiyu-rive-hop-exhausted:' + String(reason || ''));
        if (!document.getElementById('jiyu-rive-no-source')) {
          const banner = document.createElement('div');
          banner.id = 'jiyu-rive-no-source';
          banner.textContent = 'No working RiveStream source for this episode.';
          banner.setAttribute('style',
            'position:fixed;inset:auto 12px 12px 12px;z-index:2147483647;padding:12px 14px;' +
            'border-radius:10px;background:rgba(12,14,18,0.92);color:#f3f6fb;font:600 14px/1.35 Segoe UI,sans-serif;' +
            'border:1px solid rgba(255,255,255,0.12);pointer-events:none;');
          (document.body || document.documentElement).appendChild(banner);
        }
      } catch (_) {}
      return false;
    };

    try {
      window.__jiyuRiveForceHop = (reason) => hop(String(reason || 'forced'));
    } catch (_) {}

    // primesrc with empty servers paints a play UI then hands off to /undefined/ — skip it.
    if (/(^|\\.)primesrc\\.me$/i.test(host)) {
      setTimeout(() => {
        try {
          if (hasBrokenFrame() || !hasPlayerFrame()) hop('primesrc-empty');
        } catch (_) {}
      }, 3500);
      setTimeout(() => {
        try { if (hasBrokenFrame()) hop('primesrc-undefined'); } catch (_) {}
      }, 7000);
    }

    const markGood = () => {
      try {
        const cur = String(localStorage.getItem('RiveStreamLatestAgg') || prefer || 'VAP');
        if (ORDER.includes(cur) && cur !== 'ADF' && cur !== 'PRIME') localStorage.setItem(LAST_KEY, cur);
        sessionStorage.removeItem(HOP_KEY);
      } catch (_) {}
      hideServerChrome();
    };

    if (window.__jiyuRiveEmbedHop) return 'seeded';
    window.__jiyuRiveEmbedHop = true;

    let startedAt = Date.now();
    let hops = 0;
    let goodAt = 0;
    const tick = () => {
      try {
        if (window.__jiyuRiveHopping) return;
        if (hasBrokenFrame() || textLooksDead()) {
          if (hops >= ORDER.length) return;
          hops += 1;
          startedAt = Date.now();
          goodAt = 0;
          hop(hasBrokenFrame() ? 'broken-src' : 'dead-text');
          return;
        }
        if (hasPlayerFrame()) {
          if (!goodAt) goodAt = Date.now();
          if (Date.now() - goodAt > 4000) markGood();
          return;
        }
        goodAt = 0;
        if (Date.now() - startedAt < 3000) return;
        if (hops >= ORDER.length) return;
        if (Date.now() - startedAt > 20000) {
          hops += 1;
          startedAt = Date.now();
          hop('no-player');
        }
      } catch (_) {}
    };

    const start = () => {
      nudgePlay();
      setTimeout(nudgePlay, 1200);
      setTimeout(nudgePlay, 3000);
      setInterval(tick, 1000);
      setTimeout(tick, 2000);
      setTimeout(tick, 5000);
      setTimeout(tick, 9000);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      setTimeout(start, 50);
    }
    return 'armed';
  } catch (_) {
    return 'error';
  }
})();`

function forceRiveEmbedHop(contents, reason) {
  if (!contents || contents.isDestroyed()) return
  let current = ''
  try {
    current = contents.getURL() || ''
  } catch {
    return
  }
  const onRiveFamily =
    /rivestream\.(ru|app)/i.test(current) ||
    /vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(
      current,
    )
  if (!onRiveFamily) return
  const now = Date.now()
  if (contents.__jiyuRiveForceHopAt && now - contents.__jiyuRiveForceHopAt < 2500) {
    console.log('[rive-auto] force hop debounced', reason || '')
    return
  }
  contents.__jiyuRiveForceHopAt = now
  console.log('[rive-auto] force hop', reason || '')
  void contents
    .executeJavaScript(RIVESTREAM_FORCE_HOP_SCRIPT, true)
    .then((r) => console.log('[rive-auto] force hop result', r))
    .catch((err) =>
      console.log('[rive-auto] force hop err', err instanceof Error ? err.message : err),
    )
}

async function installRiveEmbedAutoScript(contents) {
  if (!contents || contents.isDestroyed()) return
  if (contents.__jiyuRiveEmbedAutoInstalled) return
  contents.__jiyuRiveEmbedAutoInstalled = true
  try {
    const dbg = contents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: RIVESTREAM_EMBED_AUTO_SCRIPT,
    })
  } catch (err) {
    console.log(
      '[rive-auto] CDP inject skipped',
      err instanceof Error ? err.message : err,
    )
  }
}

function scheduleRiveEmbedAuto(contents) {
  if (!contents || contents.isDestroyed()) return
  let pageUrl = ''
  try {
    pageUrl = contents.getURL() || ''
  } catch {
    return
  }
  const onRiveFamily =
    /rivestream\.(ru|app)/i.test(pageUrl) ||
    /vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(
      pageUrl,
    )
  if (!onRiveFamily) return
  const run = () => {
    if (!contents || contents.isDestroyed()) return
    void contents.executeJavaScript(RIVESTREAM_EMBED_AUTO_SCRIPT, true).catch(() => {})
  }
  run()
  setTimeout(run, 800)
  setTimeout(run, 2500)
}

async function installBrowserAdShield(contents) {
  if (!contents || contents.isDestroyed()) return
  let pageUrl = ''
  try {
    pageUrl = contents.getURL()
  } catch {
    return
  }
  if (!isSportsEmbedHost(pageUrl) && !/embedindia|embed\.st|ppv\.st|streamed\.pk/i.test(pageUrl)) {
    // Still install on blank→embed navigations via frame scripts below.
  }
  const frames = collectContentFrames(contents, { maxFrames: 10 })
  for (const frame of frames) {
    try {
      await raceFrameExec(frame.executeJavaScript(BROWSER_AD_SHIELD_SCRIPT, true), 1500)
    } catch {
      /* timeout / ignore */
    }
  }
}

function scheduleBrowserAdShield(contents) {
  if (!contents || contents.isDestroyed()) return
  const run = () => {
    void installBrowserAdShield(contents)
  }
  run()
  setTimeout(run, 500)
  setTimeout(run, 2000)
  setTimeout(run, 5000)
}

function destroyAdDock() {
  stopAdDockHardMute()
  if (!adDockView) return
  try {
    if (mainWindow && !mainWindow.isDestroyed() && adDockAttached) {
      mainWindow.contentView.removeChildView(adDockView)
    }
  } catch {
    /* ignore */
  }
  try {
    adDockView.webContents.destroy()
  } catch {
    /* ignore */
  }
  adDockView = null
  adDockAttached = false
  adDockVisible = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:ad-dock', { visible: false, url: '' })
  }
}

/** Keep parked ads silent — page JS often unmutes a few seconds after load. */
const AD_DOCK_HARD_MUTE_SCRIPT = `(() => {
  try {
    const lockMedia = (m) => {
      try {
        m.muted = true;
        m.volume = 0;
        m.defaultMuted = true;
        try { m.setAttribute('muted', ''); } catch (_) {}
        try { m.pause(); } catch (_) {}
      } catch (_) {}
    };
    const lockAll = () => {
      try {
        document.querySelectorAll('video,audio').forEach(lockMedia);
      } catch (_) {}
    };
    if (!window.__jiyuAdDockMuteLock) {
      window.__jiyuAdDockMuteLock = true;
      try {
        const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
        if (proto) {
          const descVol = Object.getOwnPropertyDescriptor(proto, 'volume');
          const descMute = Object.getOwnPropertyDescriptor(proto, 'muted');
          if (descVol && descVol.set) {
            Object.defineProperty(proto, 'volume', {
              configurable: true,
              get: descVol.get,
              set: function () { try { descVol.set.call(this, 0); } catch (_) {} },
            });
          }
          if (descMute && descMute.set) {
            Object.defineProperty(proto, 'muted', {
              configurable: true,
              get: function () { return true; },
              set: function () { try { descMute.set.call(this, true); } catch (_) {} },
            });
          }
          const origPlay = proto.play;
          if (typeof origPlay === 'function') {
            proto.play = function (...args) {
              try { this.muted = true; this.volume = 0; } catch (_) {}
              return origPlay.apply(this, args);
            };
          }
        }
      } catch (_) {}
      try {
        document.addEventListener('play', (e) => {
          try { if (e && e.target) lockMedia(e.target); } catch (_) {}
        }, true);
        document.addEventListener('volumechange', (e) => {
          try { if (e && e.target) lockMedia(e.target); } catch (_) {}
        }, true);
      } catch (_) {}
      try {
        const mo = new MutationObserver(() => lockAll());
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
      } catch (_) {}
      try { setInterval(lockAll, 750); } catch (_) {}
    }
    lockAll();
    if (!document.getElementById('jiyu-ad-dock-cover')) {
      const cover = document.createElement('div');
      cover.id = 'jiyu-ad-dock-cover';
      cover.setAttribute('aria-hidden', 'true');
      cover.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#0b0d12;pointer-events:none;';
      (document.documentElement || document.body).appendChild(cover);
    }
    try {
      document.documentElement.style.background = '#0b0d12';
      if (document.body) document.body.style.background = '#0b0d12';
    } catch (_) {}
    return 'locked';
  } catch (_) {
    return 'error';
  }
})();`

function muteAdDockMedia() {
  if (!adDockView || adDockView.webContents.isDestroyed()) return
  try {
    adDockView.webContents.setAudioMuted(true)
  } catch {
    /* ignore */
  }
  void adDockView.webContents.executeJavaScript(AD_DOCK_HARD_MUTE_SCRIPT, true).catch(() => {})
}

function startAdDockHardMute() {
  stopAdDockHardMute()
  muteAdDockMedia()
  adDockMuteTimer = setInterval(() => {
    if (!adDockVisible || !adDockView || adDockView.webContents.isDestroyed()) {
      stopAdDockHardMute()
      return
    }
    muteAdDockMedia()
  }, 800)
}

function stopAdDockHardMute() {
  if (adDockMuteTimer) {
    clearInterval(adDockMuteTimer)
    adDockMuteTimer = null
  }
}

function ensureAdDock() {
  if (adDockView) return adDockView
  if (!mainWindow || mainWindow.isDestroyed()) return null
  adDockView = new WebContentsView({
    webPreferences: {
      session: webSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  adDockView.setBackgroundColor('#0b0d12')
  adDockView.webContents.setUserAgent(BROWSER_UA)
  adDockView.webContents.setAudioMuted(true)
  adDockView.webContents.setWindowOpenHandler(({ url }) => {
    const target = String(url || '')
    if (/^https?:\/\//i.test(target)) {
      void adDockView.webContents.loadURL(target)
    }
    return { action: 'deny' }
  })
  adDockView.webContents.on('did-finish-load', muteAdDockMedia)
  adDockView.webContents.on('did-navigate', muteAdDockMedia)
  adDockView.webContents.on('did-frame-finish-load', muteAdDockMedia)
  adDockView.webContents.on('dom-ready', muteAdDockMedia)
  adDockView.webContents.on('media-started-playing', () => {
    muteAdDockMedia()
  })
  return adDockView
}

function applyAdDockBounds() {
  if (!adDockView || !mainWindow || mainWindow.isDestroyed()) return
  // Park off-screen: ads stay loaded/muted so they don't hijack the player,
  // but adult creatives never paint in the corner.
  adDockView.setBounds({
    x: -64,
    y: -64,
    width: 32,
    height: 32,
  })
}

function isPipLikeBrowserBounds(bounds) {
  if (!bounds) return false
  const w = Number(bounds.width) || 0
  const h = Number(bounds.height) || 0
  return w > 0 && h > 0 && w <= 420 && h <= 240
}

function showAdDock(url) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return false
  // Never park Cloudflare challenges in the ad dock.
  if (/challenges\.cloudflare\.com|turnstile|__cf_chl/i.test(target)) return false
  // Never open installer / adware bait in the dock (or anywhere).
  if (isBlockedBrowserDownloadUrl(target)) return false
  // PiP stage is small; an ad dock would cover the HTML Expand/Full/Close bar.
  if (isPipLikeBrowserBounds(webBrowserLastBounds)) return false
  const now = Date.now()
  // Avoid thrashing the main player with rapid popup storms.
  if (
    adDockVisible &&
    (target === adDockLastUrl || now - adDockLastShownAt < 2500)
  ) {
    return true
  }
  const view = ensureAdDock()
  if (!view || !mainWindow || mainWindow.isDestroyed()) return false
  try {
    view.webContents.setAudioMuted(true)
  } catch {
    /* ignore */
  }
  if (!adDockAttached) {
    mainWindow.contentView.addChildView(view)
    adDockAttached = true
  }
  applyAdDockBounds()
  // Keep attached + loaded, but never paint the creative (Close ad bar is enough).
  try {
    view.setVisible(false)
  } catch {
    /* ignore */
  }
  adDockVisible = true
  adDockLastUrl = target
  adDockLastShownAt = now
  void view.webContents.loadURL(target)
  startAdDockHardMute()
  // Keep the main stream focused so playback doesn't stall when the dock opens.
  try {
    if (webBrowserView && !webBrowserView.webContents.isDestroyed() && webBrowserVisible) {
      webBrowserView.webContents.setBackgroundThrottling(false)
      webBrowserView.webContents.focus()
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.focus()
    }
  } catch {
    /* ignore */
  }
  mainWindow.webContents.send('browser:ad-dock', { visible: true, url: target })
  return true
}

function hideAdDock() {
  stopAdDockHardMute()
  if (!adDockView) {
    adDockVisible = false
    adDockAttached = false
    adDockLastUrl = ''
    return
  }
  try {
    adDockView.setVisible(false)
  } catch {
    /* ignore */
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed() && adDockAttached) {
      mainWindow.contentView.removeChildView(adDockView)
    }
  } catch {
    /* ignore */
  }
  adDockAttached = false
  try {
    void adDockView.webContents.loadURL('about:blank')
  } catch {
    /* ignore */
  }
  adDockVisible = false
  adDockLastUrl = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:ad-dock', { visible: false, url: '' })
  }
}

/**
 * Cloudflare unlock + authenticated fetches for EZTV Show List.
 * Uses persist:jiyu-web cookies + session.fetch — never probes the challenge page.
 */
/** @type {Set<string>} */
const scrapeWarmedOrigins = new Set()
/** @type {Map<string, Promise<boolean>>} */
const scrapeWarmInflight = new Map()
/** @type {BrowserWindow | null} */
let unlockWindow = null

function looksLikeCloudflareChallenge(content, title = '') {
  const sample = `${title}\n${String(content || '').slice(0, 2500)}`
  return (
    /just a moment|cf-browser-verification|attention required|checking your browser|enable javascript and cookies to continue|cdn-cgi\/challenge|verify you are human|performing security verification/i.test(
      sample,
    ) ||
    (/cloudflare/i.test(sample) && /challenge-platform/i.test(sample))
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** YTS / YIFY mirrors — catalog sync uses JSON API only; never open CF unlock UI. */
function isYtsHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
  return /(^|[.-])(yts|yify)([.-]|$)/i.test(host) || /yts-official|yifymovies/i.test(host)
}

function isYtsUrl(pageUrl) {
  try {
    return isYtsHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

function isYtsApiPath(pageUrl) {
  try {
    const url = new URL(pageUrl)
    return (
      isYtsHost(url.hostname) &&
      /\/api\/v2\/(?:list_movies|movie_details)\.json$/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

/** NetMirror catalog host — Cloudflare blocks Electron; use system Chrome like EZTV. */
function isFreemoviesHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
  return host === 'freemovies.lol' || host.endsWith('.freemovies.lol')
}

function isFreemoviesOrigin(origin) {
  try {
    return isFreemoviesHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

function isFreemoviesUrl(pageUrl) {
  try {
    return isFreemoviesHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

function freemoviesNeedsSystemBrowser(targetUrl) {
  return isFreemoviesUrl(targetUrl)
}

/**
 * Embed hosts that 404/403 when Electron navigates with no site Referer.
 * @param {string} targetUrl
 * @returns {string | undefined}
 */
function httpReferrerForBrowserUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const path = parsed.pathname || ''
    if (host === 'fstream365.com' || host.endsWith('.fstream365.com')) {
      return 'https://ww.ymovies.vip/'
    }
    if (host === 'cinextream.cc' || host.endsWith('.cinextream.cc')) {
      return 'https://cinetaro.to/'
    }
    if (
      host === 'vsembed.ru' ||
      host.endsWith('.vsembed.ru') ||
      host === 'vidsrc.to' ||
      host.endsWith('.vidsrc.to') ||
      host === 'vidsrc.me' ||
      host.endsWith('.vidsrc.me')
    ) {
      return 'https://freemovies.lol/'
    }
    if (isFreemoviesHost(host)) {
      return 'https://freemovies.lol/'
    }
    // embed.st / embedhd.st: ANY Referer (including streamed.pk) often returns a
    // ~1KB stub with no media — leave Referer unset so the full player loads.
    if (host === 'embedindia.st' || host.endsWith('.embedindia.st')) {
      return 'https://ppv.st/'
    }
    if (host === 'rivestream.ru' || host.endsWith('.rivestream.ru')) {
      return 'https://rivestream.ru/'
    }
    if (host === 'soccerfull.net' || host.endsWith('.soccerfull.net')) {
      return 'https://livextv.hybrows.workers.dev/'
    }
    if (host === 'livextv.hybrows.workers.dev' || /livextv/i.test(host)) {
      return 'https://livextv.hybrows.workers.dev/'
    }
    // YouTube embeds (Error 153): top-level /embed loads in WebContentsView often
    // have no Referer (about:blank). YouTube requires an embedder identity — and
    // rejects Referer https://www.youtube.com/ itself.
    if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    ) {
      if (/^\/embed\//i.test(path) || host.includes('nocookie')) {
        return 'https://jiyu.app/'
      }
    }
    // DoodStream-style /e|/d embeds nested under soccerfull.
    if (/^\/[de]\/[a-z0-9]{6,}/i.test(path)) {
      return 'https://soccerfull.net/'
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * YouTube Error 153 — embedder identity missing. Packaged UI iframes load from
 * file:// so Chromium sends no Referer; force a https embed host YouTube accepts.
 * Mutates headers in place. Returns true when applied.
 * @param {string} url
 * @param {Record<string, string>} headers
 */
function applyYouTubeEmbedderHeaders(url, headers) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const pathName = parsed.pathname || ''
    const isYt =
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    if (!isYt) return false
    const isEmbedPath = /^\/embed\//i.test(pathName) || host.includes('nocookie')
    // Player config / Innertube calls from the embed also need an embedder.
    const isPlayerApi =
      /\/youtubei\//i.test(pathName) ||
      /\/get_video_info/i.test(pathName) ||
      /\/player_api/i.test(pathName)
    if (!isEmbedPath && !isPlayerApi) return false
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'referer' || lower === 'origin') delete headers[name]
    }
    headers.Referer = 'https://jiyu.app/'
    headers.Origin = 'https://jiyu.app'
    return true
  } catch {
    return false
  }
}

function scrapeOriginNeedsSystemBrowser(origin) {
  return /eztv/i.test(origin) || isFreemoviesOrigin(origin)
}

/**
 * Quiet plain-fetch with backoff for YTS — no unlock windows.
 * @param {string} targetUrl
 * @param {number} [attempts]
 */
async function fetchYtsQuietly(targetUrl, attempts = 4) {
  const delays = [0, 5_000, 15_000, 30_000]
  let last = {
    ok: false,
    status: 0,
    content: '',
    error: 'YTS request failed',
  }
  for (let i = 0; i < attempts; i += 1) {
    if (delays[i]) {
      console.log('[yts] backing off before retry', {
        waitMs: delays[i],
        attempt: i + 1,
        url: String(targetUrl).slice(0, 120),
      })
      await sleep(delays[i])
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(targetUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: withDesktopChromeClientHints({
          'User-Agent': BROWSER_UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        }),
      })
      const content = await response.text()
      const challenged = looksLikeCloudflareChallenge(content)
      if (response.ok && !challenged) {
        return { ok: true, status: response.status, content, error: '' }
      }
      last = {
        ok: false,
        status: response.status,
        content,
        error: challenged
          ? 'YTS rate-limited (will retry quietly; no unlock window)'
          : `Server returned ${response.status}`,
      }
      console.log('[yts] request blocked or failed', {
        status: response.status,
        challenged,
        attempt: i + 1,
      })
    } catch (err) {
      last = {
        ok: false,
        status: 0,
        content: '',
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return last
}

function webSession() {
  return session.fromPartition(WEB_SESSION)
}

function destroyUnlockWindow() {
  if (!unlockWindow || unlockWindow.isDestroyed()) {
    unlockWindow = null
    return
  }
  try {
    unlockWindow.destroy()
  } catch {
    /* ignore */
  }
  unlockWindow = null
}

/** Used on app quit — clears any leftover unlock UI / Chrome helper. */
function destroyScrapeWindow() {
  destroyUnlockWindow()
  if (systemBrowserIdleTimer) clearTimeout(systemBrowserIdleTimer)
  systemBrowserIdleTimer = null
  closeActiveSystemBrowser()
}

/**
 * @param {string} origin
 */
async function hasCfClearance(origin) {
  let host = ''
  try {
    host = new URL(origin).hostname.replace(/^www\./i, '')
  } catch {
    return false
  }
  try {
    const cookies = await webSession().cookies.get({ name: 'cf_clearance' })
    return cookies.some((c) => {
      const domain = String(c.domain || '')
        .replace(/^\./, '')
        .replace(/^www\./i, '')
      return domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`)
    })
  } catch {
    return false
  }
}

/**
 * Fetch with the shared browser session cookies (no BrowserWindow / no page JS).
 * @param {string} targetUrl
 */
async function sessionFetchText(targetUrl) {
  try {
    const ses = webSession()
    const response = await ses.fetch(targetUrl, {
      redirect: 'follow',
      headers: withDesktopChromeClientHints({
        'User-Agent': BROWSER_UA,
        Accept: 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }),
    })
    const content = await response.text()
    const challenged = looksLikeCloudflareChallenge(content)
    return {
      ok: response.ok && !challenged,
      status: response.status,
      content,
      error: challenged
        ? 'Cloudflare challenge'
        : response.ok
          ? ''
          : `Server returned ${response.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * @param {string} origin
 */
async function clearCfCookies(origin) {
  let host = ''
  try {
    host = new URL(origin).hostname
  } catch {
    return
  }
  try {
    const ses = webSession()
    const cookies = await ses.cookies.get({})
    for (const c of cookies) {
      if (!/^cf_clearance$|^__cf/i.test(c.name)) continue
      const domain = String(c.domain || '').replace(/^\./, '')
      if (!host.endsWith(domain) && !domain.endsWith(host.replace(/^www\./i, ''))) continue
      const url = `https://${domain.replace(/^\./, '')}${c.path || '/'}`
      await ses.cookies.remove(url, c.name).catch(() => {})
    }
    console.log('[cf-unlock] cleared stale Cloudflare cookies for', host)
  } catch (err) {
    console.log('[cf-unlock] cookie clear failed', err instanceof Error ? err.message : err)
  }
}

/**
 * @param {string} origin
 * @param {{ verbose?: boolean }} [opts]
 */
async function originAjaxUnlocked(origin, { verbose = false } = {}) {
  if (/eztv/i.test(origin)) {
    const result = await sessionFetchText(
      `${origin}/showlist/ajax/?page=1&letter=all&status=all`,
    )
    if (!result.ok) {
      if (verbose) {
        console.log('[cf-unlock] showlist ajax failed', {
          status: result.status,
          error: result.error,
          sample: String(result.content || '')
            .replace(/\s+/g, ' ')
            .slice(0, 180),
        })
      }
      return false
    }
    try {
      const json = JSON.parse(result.content)
      return Array.isArray(json.shows) && json.shows.length > 0
    } catch {
      if (verbose) {
        console.log('[cf-unlock] showlist ajax not JSON', {
          status: result.status,
          sample: String(result.content || '')
            .replace(/\s+/g, ' ')
            .slice(0, 180),
        })
      }
      return false
    }
  }
  return hasCfClearance(origin)
}

/**
 * @param {string} origin
 * @param {{ allowVisible?: boolean }} [opts]
 */
async function warmScrapeOrigin(origin, { allowVisible = true } = {}) {
  // EZTV "warmed" only counts while the live Chrome helper can still fetch.
  if (scrapeWarmedOrigins.has(origin)) {
    if (/eztv/i.test(origin)) {
      if (
        activeSystemBrowser?.browser?.connected &&
        activeSystemBrowser.origin === origin
      ) {
        return true
      }
      scrapeWarmedOrigins.delete(origin)
    } else {
      return true
    }
  }
  const inflight = scrapeWarmInflight.get(origin)
  if (inflight) return inflight

  const run = warmScrapeOriginImpl(origin, { allowVisible }).finally(() => {
    scrapeWarmInflight.delete(origin)
  })
  scrapeWarmInflight.set(origin, run)
  return run
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} origin
 * @param {number} deadlineMs
 */
async function waitForManualUnlock(win, origin, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastProbe = 0
  let probeCount = 0
  let sawVerifyingSpinner = false
  let verifyingSince = 0
  while (Date.now() < deadline) {
    if (!win || win.isDestroyed()) {
      console.log('[cf-unlock] window closed before clearance')
      return false
    }

    const title = win.webContents.getTitle() || ''
    const url = win.webContents.getURL() || ''
    if (/verifying you are human/i.test(title)) {
      if (!sawVerifyingSpinner) {
        sawVerifyingSpinner = true
        verifyingSince = Date.now()
        console.log('[cf-unlock] challenge moved to verifying/spinner state', { title, url })
      } else if (Date.now() - verifyingSince > 20_000) {
        // Click registered, but Cloudflare never finishes inside Electron.
        try {
          win.setTitle('Jiyu — Cloudflare is stuck verifying (Electron block)')
        } catch {
          /* ignore */
        }
      }
    }

    // Only watch cookies / try session.fetch — never touch the challenge DOM.
    if (Date.now() - lastProbe >= 2500) {
      lastProbe = Date.now()
      const cleared = await hasCfClearance(origin)
      probeCount += 1
      // Probe AJAX even without a cookie — clearance alone was staying true while
      // Show List still returned a challenge page (stale cf_clearance).
      const ajaxOk = await originAjaxUnlocked(origin, { verbose: probeCount === 1 || probeCount % 5 === 0 })
      console.log('[cf-unlock] probe', {
        title,
        url: url.slice(0, 160),
        cf_clearance: cleared,
        showlistAjax: ajaxOk,
        verifyingMs: sawVerifyingSpinner ? Date.now() - verifyingSince : 0,
      })
      if (ajaxOk) {
        console.log('[cf-unlock] unlocked via showlist ajax')
        return true
      }
      // Title flip without cookie can still mean success on some CF flows.
      if (
        title &&
        !looksLikeCloudflareChallenge('', title) &&
        !/just a moment|verify you are human|security check|cloudflare is stuck/i.test(title)
      ) {
        const again = await originAjaxUnlocked(origin, { verbose: true })
        if (again) {
          console.log('[cf-unlock] unlocked via title + showlist ajax')
          return true
        }
      }
    }
    await sleep(800)
  }
  console.log('[cf-unlock] timed out waiting for clearance')
  return false
}

function findSystemBrowserExe() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Live system Chrome/Edge session used for EZTV Show List after CF unlock.
 * Cookies from Chrome do not work in Electron (fingerprint-bound), so we keep
 * this browser open and fetch Show List pages through it.
 * @type {{ browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page, origin: string } | null}
 */
let activeSystemBrowser = null
/** Origins where stealth Electron unlock made session.fetch work for Show List. */
const eztvElectronSessionOk = new Set()

function closeActiveSystemBrowser() {
  const current = activeSystemBrowser
  activeSystemBrowser = null
  if (systemBrowserIdleTimer) {
    clearTimeout(systemBrowserIdleTimer)
    systemBrowserIdleTimer = null
  }
  if (!current?.browser) return
  void current.browser.close().catch(() => {})
  for (const origin of [...scrapeWarmedOrigins]) {
    if (/eztv/i.test(origin)) scrapeWarmedOrigins.delete(origin)
  }
}

/**
 * @param {string} targetUrl
 */
/** @type {ReturnType<typeof setTimeout> | null} */
let systemBrowserIdleTimer = null

/** Server/NUC mode: slightly longer idle safety net; sync still closes Chrome when done. */
function cfServerMode() {
  const flag = String(process.env.JIYU_CF_SERVER_MODE || '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false' && flag !== 'off'
}

function scheduleSystemBrowserIdleClose() {
  if (systemBrowserIdleTimer) clearTimeout(systemBrowserIdleTimer)
  // Safety net only — Show List sync is rare, so prefer closing soon after use.
  // Saved Chrome profile keeps CF cookies for the next sync.
  const idleMs = cfServerMode() ? 30 * 60 * 1000 : 3 * 60 * 1000
  systemBrowserIdleTimer = setTimeout(() => {
    console.log('[cf-unlock] closing idle system browser')
    closeActiveSystemBrowser()
  }, idleMs)
}

/** Close the CF helper shortly after catalog sync finishes (or on demand). */
function scheduleSystemBrowserCloseSoon(reason = 'sync-done') {
  if (systemBrowserIdleTimer) clearTimeout(systemBrowserIdleTimer)
  systemBrowserIdleTimer = setTimeout(() => {
    console.log('[cf-unlock] closing system browser:', reason)
    closeActiveSystemBrowser()
  }, 12_000)
}

/**
 * Best-effort Turnstile "Verify you are human" click inside system Chrome.
 * Often no checkbox appears (spinner-only) — then this no-ops.
 * @param {import('puppeteer-core').Page} page
 */
async function tryAutoClickCfVerify(page) {
  if (!page || page.isClosed?.()) return false
  try {
    const clicked = await page.evaluate(async () => {
      const visible = (el) => {
        if (!el || !(el instanceof Element)) return false
        const r = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return (
          r.width >= 12 &&
          r.height >= 12 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < window.innerHeight &&
          r.left < window.innerWidth
        )
      }
      const labelOf = (el) =>
        `${el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.value || ''}`
          .replace(/\s+/g, ' ')
          .trim()
      const isVerify = (el) => /verify you are human|i'?m not a robot|confirm you are human/i.test(labelOf(el))

      /** @type {Element[]} */
      const candidates = []
      for (const el of document.querySelectorAll('input, button, label, div, span, a')) {
        if (isVerify(el) && visible(el)) candidates.push(el)
      }
      // Prefer the smallest matching control (real checkbox/button, not the page shell).
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return ra.width * ra.height - rb.width * rb.height
      })
      const target = candidates[0]
      if (!target) return false
      const r = target.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y) || target
      hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }))
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }))
      hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }))
      if (typeof hit.click === 'function') hit.click()
      return true
    })
    if (clicked) {
      console.log('[cf-unlock] auto-clicked Cloudflare Verify control')
      return true
    }
  } catch (err) {
    console.log('[cf-unlock] auto-click failed', err instanceof Error ? err.message : err)
  }

  // Turnstile often lives in a cross-origin iframe — try CDP click at checkbox-ish boxes.
  try {
    const box = await page.evaluate(() => {
      const frames = [...document.querySelectorAll('iframe')]
      for (const iframe of frames) {
        const src = `${iframe.src || ''} ${iframe.getAttribute('title') || ''}`
        if (!/turnstile|cloudflare|challenge|cf-chl/i.test(src)) continue
        const r = iframe.getBoundingClientRect()
        if (r.width < 20 || r.height < 20) continue
        // Checkbox is usually on the left side of the widget.
        return { x: r.left + Math.min(28, r.width * 0.2), y: r.top + r.height / 2 }
      }
      return null
    })
    if (box) {
      await page.mouse.click(box.x, box.y)
      console.log('[cf-unlock] auto-clicked Turnstile iframe hotspot', box)
      return true
    }
  } catch (err) {
    console.log('[cf-unlock] iframe click failed', err instanceof Error ? err.message : err)
  }
  return false
}

async function probeShowlistAjax(page, origin) {
  const ajaxUrl = `${origin}/showlist/ajax/?page=1&letter=all&status=all`
  try {
    return await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        if (!r.ok) return false
        const json = await r.json()
        return Array.isArray(json.shows) && json.shows.length > 0
      } catch {
        return false
      }
    }, ajaxUrl)
  } catch {
    return false
  }
}

async function probeFreemoviesCatalog(page, origin) {
  const listUrl = `${origin}/category/tv-series/`
  try {
    return await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        })
        if (!r.ok) return false
        const text = await r.text()
        return /id="post-\d+"/.test(text)
      } catch {
        return false
      }
    }, listUrl)
  } catch {
    return false
  }
}

async function probeOriginUnlocked(page, origin) {
  if (/eztv/i.test(origin)) return probeShowlistAjax(page, origin)
  if (isFreemoviesOrigin(origin)) return probeFreemoviesCatalog(page, origin)
  return false
}

function warmUrlForOrigin(origin) {
  if (/eztv/i.test(origin)) return `${origin}/showlist/`
  if (isFreemoviesOrigin(origin)) return `${origin}/category/tv-series/`
  return `${origin}/`
}

/**
 * freemovies.lol paints bonus / “verify” overlays after CF clears.
 * Hide them in the unlock Chrome so sync isn’t covered in spam.
 * @param {import('puppeteer-core').Page} page
 */
async function suppressFreemoviesChromeNoise(page) {
  try {
    await page.evaluate(() => {
      const STYLE_ID = 'jiyu-hide-freemovies-noise'
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = `
          [class*="popup"], [class*="modal"], [id*="popup"], [id*="modal"],
          [class*="overlay"], [id*="overlay"], [class*="bonus"], [id*="bonus"],
          .swal2-container, .fancybox-container, .mfp-wrap {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
          body { overflow: auto !important; }
        `
        document.documentElement.appendChild(style)
      }
      const kill = (el) => {
        try {
          el.remove()
        } catch (_) {
          try {
            el.style.setProperty('display', 'none', 'important')
          } catch (_) {
            /* ignore */
          }
        }
      }
      const noisy =
        /bonus account|you have received|\$\d+|congratulations|claim now|verify your age|download our app/i
      for (const el of document.querySelectorAll('body *')) {
        const text = (el.textContent || '').slice(0, 240)
        if (!noisy.test(text)) continue
        // Only kill small overlay-ish nodes, not the whole page shell.
        const rect = el.getBoundingClientRect?.()
        if (!rect || (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.95)) {
          continue
        }
        kill(el)
      }
    })
  } catch {
    /* page may be navigating */
  }
}

/** @param {import('puppeteer-core').Page} page */
async function minimizeSystemBrowserPage(page) {
  try {
    const client = await page.createCDPSession()
    const { windowId } = await client.send('Browser.getWindowForTarget')
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    })
  } catch {
    /* ignore */
  }
}

async function fetchViaSystemBrowser(targetUrl) {
  let active = activeSystemBrowser
  if (!active?.page || !active.browser?.connected) {
    let origin = ''
    try {
      origin = new URL(targetUrl).origin
    } catch {
      return { ok: false, status: 0, content: '', error: 'System browser not unlocked' }
    }
    scrapeWarmedOrigins.delete(origin)
    const warmed = await warmViaSystemBrowser(origin)
    active = activeSystemBrowser
    if (!warmed || !active?.page || !active.browser?.connected) {
      return {
        ok: false,
        status: 0,
        content: '',
        error:
          'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.',
      }
    }
  }
  scheduleSystemBrowserIdleClose()
  try {
    const result = await active.page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json,text/html,*/*;q=0.8' },
        })
        const content = await r.text()
        return { ok: r.ok, status: r.status, content, error: r.ok ? '' : `Server returned ${r.status}` }
      } catch (err) {
        return {
          ok: false,
          status: 0,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }, targetUrl)
    if (looksLikeCloudflareChallenge(result.content)) {
      console.log('[cf-unlock] chrome fetch challenged', String(targetUrl).slice(0, 120))
      return {
        ok: false,
        status: result.status || 403,
        content: result.content,
        error: 'Cloudflare challenge',
      }
    }
    console.log('[cf-unlock] chrome fetch ok', {
      status: result.status,
      bytes: String(result.content || '').length,
      url: String(targetUrl).slice(0, 120),
    })
    return result
  } catch (err) {
    return {
      ok: false,
      status: 0,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Cloudflare Turnstile cannot finish inside Electron (WebGL errors). Open the
 * real system Chrome/Edge, let the user Verify there, then keep that browser
 * for Show List fetches (cookie copy into Electron is not enough).
 * @param {string} origin
 */
async function warmViaSystemBrowser(origin) {
  if (
    activeSystemBrowser?.browser?.connected &&
    activeSystemBrowser.origin === origin
  ) {
    const probeUrl = /eztv/i.test(origin)
      ? `${origin}/showlist/ajax/?page=1&letter=all&status=all`
      : isFreemoviesOrigin(origin)
        ? `${origin}/category/tv-series/`
        : `${origin}/`
    const probe = await fetchViaSystemBrowser(probeUrl)
    if (probe.ok) {
      if (/eztv/i.test(origin)) {
        try {
          const json = JSON.parse(probe.content)
          if (Array.isArray(json.shows) && json.shows.length > 0) return true
        } catch {
          /* continue relaunch */
        }
      } else if (isFreemoviesOrigin(origin) && /id="post-\d+"/.test(probe.content || '')) {
        return true
      }
    }
  }

  closeActiveSystemBrowser()

  const exe = findSystemBrowserExe()
  if (!exe) {
    console.log('[cf-unlock] no system Chrome/Edge found')
    return false
  }

  let puppeteer
  try {
    puppeteer = require('puppeteer-core')
  } catch (err) {
    console.log('[cf-unlock] puppeteer-core missing', err instanceof Error ? err.message : err)
    return false
  }

  const warmUrl = warmUrlForOrigin(origin)
  const profileDir = path.join(app.getPath('userData'), 'cf-system-browser-profile')
  console.log('[cf-unlock] launching system browser', exe, { serverMode: cfServerMode(), origin })

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: false,
      defaultViewport: null,
      userDataDir: profileDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        `--app=${warmUrl}`,
      ],
      // Drop Puppeteer's --enable-automation (infobar) without the unsupported
      // --disable-blink-features=AutomationControlled flag Chrome warns about.
      ignoreDefaultArgs: ['--enable-automation'],
    })
  } catch (err) {
    console.log('[cf-unlock] system browser launch failed', err instanceof Error ? err.message : err)
    return false
  }

  try {
    const pages = await browser.pages()
    const page = pages[0] || (await browser.newPage())
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => undefined,
          configurable: true,
        })
      } catch (_) {
        /* ignore */
      }
    })
    // freemovies: block popunder tabs and strip bonus overlays during unlock/sync.
    if (isFreemoviesOrigin(origin)) {
      browser.on('targetcreated', async (target) => {
        try {
          if (target.type() !== 'page') return
          const popup = await target.page()
          if (popup && popup !== page) await popup.close().catch(() => {})
        } catch {
          /* ignore */
        }
      })
      page.on('framenavigated', () => {
        void suppressFreemoviesChromeNoise(page)
      })
    }

    try {
      await page.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    } catch (err) {
      console.log('[cf-unlock] system browser goto', err instanceof Error ? err.message : err)
    }
    if (isFreemoviesOrigin(origin)) await suppressFreemoviesChromeNoise(page)

    // Persistent profile may already be cleared — succeed silently (no dialog).
    if (await probeOriginUnlocked(page, origin)) {
      activeSystemBrowser = { browser, page, origin }
      scheduleSystemBrowserIdleClose()
      console.log('[cf-unlock] system browser ready from saved profile')
      if (isFreemoviesOrigin(origin)) await suppressFreemoviesChromeNoise(page)
      await minimizeSystemBrowserPage(page)
      return true
    }

    // Best-effort auto Verify; only prompt a human if still blocked after a bit.
    let prompted = false
    let lastClick = 0
    const waitStarted = Date.now()
    const deadline = waitStarted + 180_000
    while (Date.now() < deadline) {
      if (!browser.connected) {
        console.log('[cf-unlock] system browser closed by user')
        return false
      }

      if (Date.now() - lastClick >= 8000) {
        lastClick = Date.now()
        await tryAutoClickCfVerify(page)
      }
      if (isFreemoviesOrigin(origin)) await suppressFreemoviesChromeNoise(page)

      const ok = await probeOriginUnlocked(page, origin)
      console.log('[cf-unlock] system browser probe', { ok, url: page.url() })
      if (ok) {
        activeSystemBrowser = { browser, page, origin }
        scheduleSystemBrowserIdleClose()
        console.log('[cf-unlock] system browser ready — scrape fetches will use Chrome')
        // Minimize (do not close) — closing would drop the CF session the server needs.
        if (isFreemoviesOrigin(origin)) await suppressFreemoviesChromeNoise(page)
        await minimizeSystemBrowserPage(page)
        return true
      }

      if (!prompted && Date.now() - waitStarted >= 12_000) {
        prompted = true
        if (cfServerMode()) {
          console.log(
            '[cf-unlock] server mode: still blocked — auto-click ran; complete Verify once in Chrome if a checkbox is visible',
          )
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          const siteLabel = isFreemoviesOrigin(origin) ? 'NetMirror' : 'EZTV'
          void dialog.showMessageBox(mainWindow, {
            type: 'info',
            buttons: ['OK'],
            title: `${siteLabel} security check`,
            message: 'Complete Verify in Chrome/Edge if asked',
            detail:
              'Jiyu tries to complete Cloudflare automatically. If a “Verify you are human” box is still visible in the Chrome window, click it once. Chrome will minimize when unlocked and stay running for sync (needed for a future TV/server setup).',
          })
        }
      }

      await sleep(2000)
    }
    console.log('[cf-unlock] system browser timed out')
    await browser.close().catch(() => {})
    return false
  } catch (err) {
    console.log('[cf-unlock] system browser error', err instanceof Error ? err.message : err)
    try {
      await browser.close()
    } catch {
      /* ignore */
    }
    return false
  }
}

/**
 * @param {string} origin
 * @param {{ allowVisible?: boolean }} opts
 */
async function warmScrapeOriginImpl(origin, { allowVisible = true } = {}) {
  // Local torrent/remux servers must never trigger a Cloudflare Verify window.
  try {
    const host = new URL(origin).hostname
    if (/^(127\.0\.0\.1|localhost)$/i.test(host)) return false
  } catch {
    return false
  }

  const isEztv = /eztv/i.test(origin)
  const isFreemovies = isFreemoviesOrigin(origin)

  // YTS catalog uses the public JSON API — never open Verify/Chrome unlock UI.
  if (isYtsUrl(origin)) {
    if (await originAjaxUnlocked(origin, { verbose: false })) {
      scrapeWarmedOrigins.add(origin)
      return true
    }
    console.log('[cf-unlock] skipping visible unlock for YTS (API-only quiet mode)')
    return false
  }

  // YMovies: already a huge Series shelf; popping Verify during background sync
  // is more pain than gain. Stay quiet — manual Sync can retry later.
  try {
    const yHost = new URL(origin).hostname.replace(/^www\./i, '').toLowerCase()
    if (yHost === 'ww.ymovies.vip' || yHost.endsWith('.ymovies.vip') || yHost === 'ymovies.vip') {
      if (await originAjaxUnlocked(origin, { verbose: false })) {
        scrapeWarmedOrigins.add(origin)
        return true
      }
      console.log('[cf-unlock] skipping visible unlock for YMovies (quiet mode)')
      return false
    }
    // Cinetaro: CF Turnstile in Electron is disruptive; catalog can wait.
    if (yHost === 'cinetaro.to' || yHost.endsWith('.cinetaro.to') || yHost === 'cinextream.cc') {
      if (await originAjaxUnlocked(origin, { verbose: false })) {
        scrapeWarmedOrigins.add(origin)
        return true
      }
      console.log('[cf-unlock] skipping visible unlock for Cinetaro (quiet mode)')
      return false
    }
  } catch {
    /* not a URL */
  }

  // EZTV + freemovies.lol must use live system Chrome. Electron Turnstile unlock
  // stays blank; session.fetch does not keep clearance after Chrome unlock.
  if (isEztv || isFreemovies) {
    if (activeSystemBrowser?.page && activeSystemBrowser.browser?.connected) {
      if (activeSystemBrowser.origin === origin || !activeSystemBrowser.origin) {
        scrapeWarmedOrigins.add(origin)
        return true
      }
    }
    if (!allowVisible) return false
    console.log('[cf-unlock] system Chrome unlock (Electron stealth skipped)', { origin })
    if (isEztv) eztvElectronSessionOk.delete(origin)
    const unlocked = await warmViaSystemBrowser(origin)
    if (unlocked) {
      scrapeWarmedOrigins.add(origin)
      return true
    }
    scrapeWarmedOrigins.delete(origin)
    return false
  }

  if (scrapeWarmedOrigins.has(origin)) return true

  if (await originAjaxUnlocked(origin, { verbose: true })) {
    scrapeWarmedOrigins.add(origin)
    return true
  }

  if (!allowVisible) return false

  await clearCfCookies(origin)

  // Non-EZTV: optional stealth Electron unlock.
  const electronUnlocked = await tryStealthElectronUnlock(origin, 180_000)
  if (electronUnlocked) {
    scrapeWarmedOrigins.add(origin)
    return true
  }

  return false
}

/**
 * In-app Cloudflare unlock with automation softeninig. Returns true only if
 * Show List / origin AJAX becomes reachable via the Electron session.
 * @param {string} origin
 * @param {number} timeoutMs
 */
async function tryStealthElectronUnlock(origin, timeoutMs) {
  if (unlockWindow && !unlockWindow.isDestroyed()) {
    const unlocked = await waitForManualUnlock(unlockWindow, origin, timeoutMs)
    if (unlocked) {
      destroyUnlockWindow()
      return true
    }
    destroyUnlockWindow()
    return false
  }

  const warmUrl = /eztv/i.test(origin) ? `${origin}/showlist/` : `${origin}/`
  const ses = webSession()
  const stealthPreload = path.join(__dirname, 'stealth-preload.cjs')
  console.log('[cf-unlock] trying stealth Electron unlock', { origin, timeoutMs })
  unlockWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    title: 'Jiyu — Verify you are human (closes when unlocked)',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      session: ses,
      // Page-world patches for navigator.webdriver / plugins.
      preload: stealthPreload,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  const win = unlockWindow
  win.on('closed', () => {
    if (unlockWindow === win) unlockWindow = null
  })
  // Blank white challenge (common when CF refuses Electron) — don't block watching.
  const blankWatch = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(blankWatch)
      return
    }
    void win.webContents
      .executeJavaScript(
        `(() => {
          const text = (document.body && document.body.innerText || '').trim();
          const hasChallenge = /verify you are human|just a moment|cloudflare|cf-turnstile|challenge/i.test(
            document.documentElement ? document.documentElement.innerHTML : '',
          );
          return { len: text.length, hasChallenge, title: document.title || '' };
        })()`,
      )
      .then((info) => {
        if (!info || win.isDestroyed()) return
        if (info.len < 8 && !info.hasChallenge) {
          console.log('[cf-unlock] blank challenge window — closing')
          clearInterval(blankWatch)
          destroyUnlockWindow()
        }
      })
      .catch(() => {})
  }, 1500)
  setTimeout(() => clearInterval(blankWatch), Math.min(timeoutMs, 20_000))
  // If still blank after a few seconds, don't hold the sync hostage.
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    void win.webContents
      .executeJavaScript(
        `(() => {
          const text = (document.body && document.body.innerText || '').trim();
          return text.length;
        })()`,
      )
      .then((len) => {
        if (typeof len === 'number' && len < 8 && !win.isDestroyed()) {
          console.log('[cf-unlock] blank challenge still empty — aborting unlock wait')
          destroyUnlockWindow()
        }
      })
      .catch(() => {})
  }, 8_000)
  try {
    win.webContents.setUserAgent(BROWSER_UA)
  } catch {
    /* ignore */
  }
  try {
    const dbg = win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => undefined, configurable: true
        });
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
      `,
    })
  } catch (err) {
    console.log(
      '[cf-unlock] CDP stealth inject skipped',
      err instanceof Error ? err.message : err,
    )
  }
  win.focus()
  try {
    await win.loadURL(warmUrl)
  } catch {
    /* ignore */
  }

  const unlocked = await waitForManualUnlock(win, origin, timeoutMs)
  destroyUnlockWindow()
  if (unlocked) console.log('[cf-unlock] stealth Electron unlock succeeded')
  else console.log('[cf-unlock] stealth Electron unlock timed out / failed')
  return unlocked
}

/**
 * Fetch Cloudflare-guarded URLs. EZTV Show List goes through system Chrome
 * (Electron session.fetch stays challenged even after a valid Chrome unlock).
 * @param {string} targetUrl
 * @param {{ allowVisible?: boolean }} [opts]
 */
async function fetchViaScrapeBrowser(targetUrl, opts = {}) {
  const allowVisible = opts.allowVisible !== false
  let origin
  try {
    origin = new URL(targetUrl).origin
  } catch {
    return { ok: false, status: 0, content: '', error: 'Invalid page URL' }
  }

  // Never open Chrome for the public JSON API — TMDB→EZTV sync uses only this.
  if (isEztvApiPath(targetUrl)) {
    return sessionFetchText(targetUrl)
  }

  // YTS: quiet API/backoff only — unlock windows crash more than they help.
  if (isYtsUrl(targetUrl)) {
    return fetchYtsQuietly(targetUrl)
  }

  const warmed = await warmScrapeOrigin(origin, { allowVisible })
  if (!warmed) {
    return {
      ok: false,
      status: 403,
      content: '',
      error: allowVisible
        ? 'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.'
        : 'Catalog unlock needed. Sync this source from Library (Chrome verify), then try again.',
    }
  }

  if (scrapeOriginNeedsSystemBrowser(origin)) {
    let result = await fetchViaSystemBrowser(targetUrl)
    if (!result.ok || looksLikeCloudflareChallenge(result.content)) {
      scrapeWarmedOrigins.delete(origin)
      const rewarmed = await warmScrapeOrigin(origin, { allowVisible })
      if (rewarmed) result = await fetchViaSystemBrowser(targetUrl)
    }
    if (looksLikeCloudflareChallenge(result.content)) {
      return {
        ok: false,
        status: result.status || 403,
        content: result.content || '',
        error: allowVisible
          ? 'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.'
          : 'Catalog unlock needed. Sync this source from Library (Chrome verify), then try again.',
      }
    }
    return {
      ok: Boolean(result.ok),
      status: result.status || 0,
      content: result.content || '',
      error: result.ok ? '' : result.error || `Server returned ${result.status}`,
    }
  }

  let result = await sessionFetchText(targetUrl)
  if (!result.ok || looksLikeCloudflareChallenge(result.content)) {
    scrapeWarmedOrigins.delete(origin)
    const rewarmed = await warmScrapeOrigin(origin, { allowVisible })
    if (rewarmed) result = await sessionFetchText(targetUrl)
  }

  if (looksLikeCloudflareChallenge(result.content)) {
    return {
      ok: false,
      status: result.status || 403,
      content: result.content || '',
      error: allowVisible
        ? 'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.'
        : 'Catalog unlock needed. Sync this source from Library (Chrome verify), then try again.',
    }
  }
  return {
    ok: Boolean(result.ok),
    status: result.status || 0,
    content: result.content || '',
    error: result.ok ? '' : result.error || `Server returned ${result.status}`,
  }
}

/** Push updater state to the renderer (brand menu / toast). */
function sendUpdaterEvent(payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:updater', payload)
  } catch {
    /* ignore */
  }
}

/**
 * GitHub Releases feed via electron-builder publish config (app-update.yml).
 * No-op in `npm run dev:desktop`. Packaged NSIS / AppImage check on launch.
 */
function setupAutoUpdater() {
  if (!app.isPackaged) {
    sendUpdaterEvent({ status: 'idle', reason: 'dev' })
    return
  }
  // Portable .exe cannot self-update (missing update.yml / no install dir).
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) {
    sendUpdaterEvent({
      status: 'error',
      message:
        'Portable builds cannot auto-update. Install with “Jiyu Setup”, or download the latest Setup from GitHub Releases.',
    })
    return
  }
  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    console.warn('[updater] electron-updater missing:', err?.message || err)
    sendUpdaterEvent({ status: 'error', message: 'Updater not installed' })
    return
  }
  autoUpdaterRef = autoUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  try {
    autoUpdater.logger = null
  } catch {
    /* ignore */
  }

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterEvent({ status: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    sendUpdaterEvent({
      status: 'available',
      version: info?.version || null,
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    sendUpdaterEvent({
      status: 'not-available',
      version: info?.version || APP_VERSION,
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent({
      status: 'downloading',
      percent: Number(progress?.percent) || 0,
      transferred: Number(progress?.transferred) || 0,
      total: Number(progress?.total) || 0,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdaterEvent({
      status: 'downloaded',
      version: info?.version || null,
    })
  })
  autoUpdater.on('error', (err) => {
    const raw = String(err?.message || err || 'Update check failed')
    const message = /ENOENT|update\.yml/i.test(raw)
      ? 'Auto-update needs the installed app (Jiyu Setup). Download the latest Setup from GitHub Releases.'
      : raw
    sendUpdaterEvent({
      status: 'error',
      message,
    })
  })

  // Let the window settle before hitting GitHub.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      const raw = String(err?.message || err || 'Update check failed')
      const message = /ENOENT|update\.yml/i.test(raw)
        ? 'Auto-update needs the installed app (Jiyu Setup). Download the latest Setup from GitHub Releases.'
        : raw
      sendUpdaterEvent({
        status: 'error',
        message,
      })
    })
  }, 10_000)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0d10',
    title: 'Jiyu',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  })

  mainWindow = win
  /** @type {boolean} */
  win.__jiyuAllowClose = false
  /** @type {boolean} */
  win.__jiyuTrueMinimize = false
  installEscapeExitsFullscreen(win.webContents)
  // Never start (or stay) stuck in OS fullscreen on launch.
  try {
    jiyuWantOsFullScreen = false
    if (win.isFullScreen()) win.setFullScreen(false)
  } catch {
    /* ignore */
  }

  win.on('enter-full-screen', () => {
    try {
      win.webContents.send('app:fullscreen-changed', { fullScreen: true })
    } catch {
      /* ignore */
    }
  })
  win.on('leave-full-screen', () => {
    // Embed players often enter+exit HTML fullscreen on resize. That can drop the
    // BrowserWindow out of OS fullscreen even when Jiyu explicitly requested it.
    // Re-assert instead of clearing the want-flag (which made Full look broken).
    // Skip while minimize is being turned into PiP — re-pinning looks like no PiP.
    if (jiyuWantOsFullScreen && !jiyuSuppressFullscreenReassert) {
      setImmediate(() => {
        try {
          if (
            jiyuWantOsFullScreen &&
            mainWindow &&
            !mainWindow.isDestroyed() &&
            !mainWindow.isFullScreen()
          ) {
            mainWindow.setFullScreen(true)
          }
        } catch {
          /* ignore */
        }
      })
      return
    }
    try {
      win.webContents.send('app:fullscreen-changed', { fullScreen: false })
    } catch {
      /* ignore */
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Give the renderer a moment to flush Continue watching before the window dies.
  win.on('close', (event) => {
    if (win.__jiyuAllowClose || win.isDestroyed()) return
    event.preventDefault()
    if (win.__jiyuSavingContinue) return
    win.__jiyuSavingContinue = true
    const finish = () => {
      win.__jiyuAllowClose = true
      win.__jiyuSavingContinue = false
      if (!win.isDestroyed()) win.close()
    }
    const timer = setTimeout(finish, 700)
    const onSaved = () => {
      clearTimeout(timer)
      ipcMain.removeListener('app:continue-saved', onSaved)
      finish()
    }
    ipcMain.once('app:continue-saved', onSaved)
    try {
      win.webContents.send('app:save-continue')
    } catch {
      clearTimeout(timer)
      ipcMain.removeListener('app:continue-saved', onSaved)
      finish()
    }
  })

  win.on('closed', () => {
    destroyAdDock()
    destroyWebBrowser()
    destroyScrapeWindow()
    if (mainWindow === win) mainWindow = null
  })

  win.on('resize', () => {
    if (adDockVisible) applyAdDockBounds()
  })

  // Hide the live WebContentsView while the window is dragged. Moving a
  // hardware video layer onto another monitor otherwise stalls the GPU.
  win.on('move', () => {
    beginWindowMove()
  })
  win.on('moved', () => {
    endWindowMove()
  })

  // Minimize → PiP: restore immediately and let the renderer demote playback.
  // True taskbar minimize is allowed when the pref is off, already in PiP,
  // multi-view, or the renderer asks via app:minimizeWindow.
  win.on('minimize', () => {
    if (win.__jiyuTrueMinimize) {
      win.__jiyuTrueMinimize = false
      return
    }
    if (!jiyuMinimizeToPipEnabled) return
    // Drop the fullscreen pin first — otherwise leave-full-screen puts the
    // window straight back to full screen and PiP never appears.
    jiyuWantOsFullScreen = false
    jiyuSuppressFullscreenReassert = true
    setImmediate(() => {
      try {
        if (win.isDestroyed()) return
        if (win.isFullScreen()) win.setFullScreen(false)
        if (win.isMinimized()) win.restore()
        win.show()
        win.webContents.send('app:minimize-to-pip')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        jiyuSuppressFullscreenReassert = false
      }, 1500)
    })
  })

  if (isDev) {
    void loadDevUrl(win)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  return win
}

function navCanGoBack(contents) {
  try {
    if (contents.navigationHistory && typeof contents.navigationHistory.canGoBack === 'function') {
      return contents.navigationHistory.canGoBack()
    }
    if (typeof contents.canGoBack === 'function') return contents.canGoBack()
  } catch {
    /* ignore */
  }
  return false
}

function navCanGoForward(contents) {
  try {
    if (contents.navigationHistory && typeof contents.navigationHistory.canGoForward === 'function') {
      return contents.navigationHistory.canGoForward()
    }
    if (typeof contents.canGoForward === 'function') return contents.canGoForward()
  } catch {
    /* ignore */
  }
  return false
}

function navGoBack(contents) {
  try {
    if (contents.navigationHistory && typeof contents.navigationHistory.goBack === 'function') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      return
    }
    if (typeof contents.goBack === 'function' && contents.canGoBack()) contents.goBack()
  } catch {
    /* ignore */
  }
}

function navGoForward(contents) {
  try {
    if (contents.navigationHistory && typeof contents.navigationHistory.goForward === 'function') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      return
    }
    if (typeof contents.goForward === 'function' && contents.canGoForward()) contents.goForward()
  } catch {
    /* ignore */
  }
}

function detachWebBrowser() {
  if (!webBrowserView || !mainWindow || mainWindow.isDestroyed()) {
    webBrowserAttached = false
    return
  }
  try {
    mainWindow.contentView.removeChildView(webBrowserView)
  } catch {
    /* ignore */
  }
  webBrowserAttached = false
}

function destroyWebBrowser() {
  destroyAdDock()
  hideAllMultiWeb({ blank: true })
  if (!webBrowserView) return
  detachWebBrowser()
  try {
    webBrowserView.webContents.destroy()
  } catch {
    /* ignore */
  }
  webBrowserView = null
  webBrowserVisible = false
}

function ensureWebBrowser() {
  if (webBrowserView) return webBrowserView
  if (!mainWindow || mainWindow.isDestroyed()) return null

  const browserSession = session.fromPartition('persist:jiyu-web')
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = [
      'media',
      'mediaKeySystem',
      'fullscreen',
      'pointerLock',
      'clipboard-sanitized-write',
    ].includes(permission)
    callback(allow)
  })

  webBrowserView = new WebContentsView({
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  webBrowserView.setBackgroundColor('#10141a')
  webBrowserView.webContents.setUserAgent(BROWSER_UA)
  webBrowserView.webContents.setBackgroundThrottling(false)
  void installRiveEmbedAutoScript(webBrowserView.webContents)

  webBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    const target = String(url || '')
    // Never navigate the main sports/player tile into a popup (ads / adult sites).
    if (/^https?:\/\//i.test(target)) {
      if (!shouldBlockBrowserNavigation(target)) showAdDock(target)
    }
    return { action: 'deny' }
  })
  installEmbedNavGuard(webBrowserView.webContents)
  installEscapeExitsFullscreen(webBrowserView.webContents)

  const emitNav = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !webBrowserView) return
    const contents = webBrowserView.webContents
    mainWindow.webContents.send('browser:nav', {
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: navCanGoBack(contents),
      canGoForward: navCanGoForward(contents),
      loading: contents.isLoading(),
    })
  }

  webBrowserView.webContents.on('did-navigate', emitNav)
  webBrowserView.webContents.on('did-navigate-in-page', emitNav)
  webBrowserView.webContents.on('did-start-loading', emitNav)
  webBrowserView.webContents.on('did-stop-loading', () => {
    emitNav()
    scheduleBrowserWheelVolume(webBrowserView.webContents)
    scheduleBrowserAdShield(webBrowserView.webContents)
    scheduleRiveEmbedAuto(webBrowserView.webContents)
    scheduleWebBrowserSportsAutoplay(webBrowserView.webContents)
  })
  webBrowserView.webContents.on('page-title-updated', emitNav)
  webBrowserView.webContents.on('dom-ready', () => {
    emitNav()
    scheduleBrowserWheelVolume(webBrowserView.webContents)
    scheduleBrowserAdShield(webBrowserView.webContents)
    scheduleRiveEmbedAuto(webBrowserView.webContents)
    scheduleWebBrowserSportsAutoplay(webBrowserView.webContents)
  })
  // Subframe loads (ads) used to re-run shield/volume on every iframe and hitch the stream.
  let frameShieldTimer = 0
  webBrowserView.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
    if (isMainFrame) return
    if (frameShieldTimer) clearTimeout(frameShieldTimer)
    frameShieldTimer = setTimeout(() => {
      frameShieldTimer = 0
      if (!webBrowserView || webBrowserView.webContents.isDestroyed()) return
      scheduleBrowserAdShield(webBrowserView.webContents)
    }, 800)
  })
  try {
    webBrowserView.webContents.on('frame-created', (_e, details) => {
      const frame = details?.frame
      if (!frame) return
      setTimeout(() => {
        try {
          if (!frame.isDestroyed?.()) {
            void frame.executeJavaScript(
              BROWSER_WHEEL_VOLUME_SCRIPT.replace(
                'window.__jiyuVolLevel = 1;',
                `window.__jiyuVolLevel = ${Number.isFinite(webBrowserVolume) ? webBrowserVolume : 1};`,
              ),
              true,
            )
            void frame.executeJavaScript(BROWSER_AD_SHIELD_SCRIPT, true)
          }
        } catch {
          /* ignore */
        }
      }, 200)
    })
  } catch {
    /* older Electron */
  }
  webBrowserView.webContents.on('console-message', (...args) => {
    let message = ''
    if (typeof args[2] === 'string') message = args[2]
    else if (args[1] && typeof args[1] === 'object' && args[1] && 'message' in args[1]) {
      message = String(args[1].message || '')
    }
    const text = String(message || '').trim()
    const adOpen = /^jiyu-ad-open:(.*)$/.exec(text)
    if (adOpen) {
      const target = String(adOpen[1] || '').trim()
      if (target) showAdDock(target)
      return
    }
    const m = /^jiyu-browser-vol:(\d+)\s*$/.exec(text)
    if (!m) return
    const percent = Math.max(0, Math.min(100, Number(m[1]) || 0))
    webBrowserVolume = percent / 100
    if (webBrowserVolume > 0.001) webBrowserVolumeBeforeMute = webBrowserVolume
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:volume', { percent })
    }
  })
  webBrowserView.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return
    const failedUrl = String(validatedURL || '')
    const dead =
      isDeadPlaceholderEmbedUrl(failedUrl) ||
      /ERR_NAME_NOT_RESOLVED|NAME_NOT_RESOLVED|DNS_PROBE/i.test(String(errorDescription || ''))
    if (dead && webBrowserView && !webBrowserView.webContents.isDestroyed()) {
      let current = ''
      try {
        current = webBrowserView.webContents.getURL() || ''
      } catch {
        current = ''
      }
      console.log('[browser] dead embed load failed', {
        errorCode,
        errorDescription,
        url: failedUrl.slice(0, 140),
        main: isMainFrame,
      })
      if (
        /rivestream\.(ru|app)|vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me/i.test(
          current,
        )
      ) {
        forceRiveEmbedHop(webBrowserView.webContents, 'fail-load')
      }
    }
    if (!isMainFrame) return
    if (!mainWindow || mainWindow.isDestroyed() || !webBrowserView) return
    mainWindow.webContents.send('browser:nav', {
      url: validatedURL || webBrowserView.webContents.getURL(),
      title: dead
        ? 'Source failed — trying next server…'
        : `Failed to load (${errorDescription || errorCode})`,
      canGoBack: navCanGoBack(webBrowserView.webContents),
      canGoForward: navCanGoForward(webBrowserView.webContents),
      loading: false,
    })
  })

  return webBrowserView
}

function applyBounds(view, bounds) {
  if (!bounds) return
  webBrowserLastBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
  // Dragging across monitors: keep the hardware video layer hidden until the
  // move ends. setBounds on every move tick deadlocks the GPU.
  if (windowMoveActive) return
  view.setBounds(webBrowserLastBounds)
}

function showWebBrowser(bounds) {
  const view = ensureWebBrowser()
  if (!view || !mainWindow || mainWindow.isDestroyed()) return false
  // Navigate can call show without bounds — keep last size or fill the window.
  let nextBounds = bounds
  if (!nextBounds || nextBounds.width < 8 || nextBounds.height < 8) {
    if (webBrowserLastBounds && webBrowserLastBounds.width >= 8 && webBrowserLastBounds.height >= 8) {
      nextBounds = webBrowserLastBounds
    } else {
      const [cw, ch] = mainWindow.getContentSize()
      nextBounds = { x: 0, y: 0, width: Math.max(1, cw), height: Math.max(1, ch) }
    }
  }
  if (isPipLikeBrowserBounds(nextBounds)) hideAdDock()
  const alreadyShown = webBrowserVisible && webBrowserAttached
  if (!alreadyShown) {
    // Single-player mode takes over — destroy multi tiles so they can't cover the UI.
    hideAllMultiWeb({ blank: true })
  }
  if (!webBrowserAttached) {
    mainWindow.contentView.addChildView(view)
    webBrowserAttached = true
  }
  applyBounds(view, nextBounds)
  if (!windowMoveActive) view.setVisible(true)
  webBrowserVisible = true
  if (alreadyShown) return true
  try {
    // Live embeds need full CPU while visible (PiP / full page).
    view.webContents.setBackgroundThrottling(false)
  } catch {
    /* ignore */
  }
  try {
    // Respect chrome Mute — sports kick used to force-unmute after the user muted.
    const wantSound = !(Number.isFinite(webBrowserVolume) && webBrowserVolume <= 0.001)
    view.webContents.setAudioMuted(!wantSound)
  } catch {
    /* ignore */
  }
  scheduleBrowserWheelVolume(view.webContents)
  if (Number.isFinite(webBrowserVolume)) {
    void applyWebBrowserVolume(webBrowserVolume, { emit: false })
  }
  return true
}

function clearWebBrowserSportsAutoplay() {
  for (const t of webBrowserSportsAutoplayTimers) clearTimeout(t)
  webBrowserSportsAutoplayTimers = []
}

function hideWebBrowser(options = {}) {
  const blank = Boolean(options && options.blank)
  const pause = options.pause !== false
  hideAdDock()
  clearWebBrowserSportsAutoplay()
  if (!webBrowserView) {
    webBrowserVisible = false
    return
  }
  try {
    webBrowserView.setVisible(false)
  } catch {
    /* ignore */
  }
  // Pause media when hiding. Only blank on explicit close — blanking kills the
  // session and made Expand from PiP look like a 30s reload to about:blank.
  try {
    const contents = webBrowserView.webContents
    if (contents && !contents.isDestroyed()) {
      // Hidden views were left with throttling off, so HLS/JW kept decoding → high idle CPU.
      try {
        contents.setBackgroundThrottling(true)
      } catch {
        /* ignore */
      }
      if (pause) {
        void contents
          .executeJavaScript(
            `(() => {
              try {
                document.querySelectorAll('video,audio').forEach((m) => {
                  try {
                    m.pause();
                    m.muted = true;
                    m.volume = 0;
                  } catch (_) {}
                });
                try {
                  if (typeof jwplayer === 'function') {
                    const players =
                      typeof jwplayer.getPlayers === 'function' ? jwplayer.getPlayers() || [] : [];
                    for (const p of players) {
                      try {
                        p.pause?.();
                        p.setMute?.(true);
                      } catch (_) {}
                    }
                    try {
                      jwplayer().pause?.();
                      jwplayer().setMute?.(true);
                    } catch (_) {}
                  }
                } catch (_) {}
                try {
                  if (window.videojs) {
                    for (const el of document.querySelectorAll('.video-js')) {
                      try {
                        window.videojs.getPlayer?.(el)?.pause?.();
                      } catch (_) {}
                    }
                  }
                } catch (_) {}
              } catch (_) {}
            })();`,
            true,
          )
          .catch(() => {})
        try {
          contents.setAudioMuted(true)
        } catch {
          /* ignore */
        }
      }
      if (blank) {
        const current = contents.getURL()
        if (current && current !== 'about:blank') {
          void contents.loadURL('about:blank')
        }
      }
    }
  } catch {
    /* ignore */
  }
  webBrowserVisible = false
}

function destroyMultiWebView(id) {
  const key = String(id || '')
  // Stop autoplay nudge timers first — otherwise executeJavaScript keeps the
  // main process busy for up to ~12s after the tile is closed.
  const timers = multiWebAutoplayTimers.get(key) || []
  for (const t of timers) clearTimeout(t)
  multiWebAutoplayTimers.delete(key)
  const view = multiWebViews.get(key)
  if (!view) return
  try {
    if (mainWindow && !mainWindow.isDestroyed() && multiWebAttached.has(key)) {
      mainWindow.contentView.removeChildView(view)
    }
  } catch {
    /* ignore */
  }
  multiWebAttached.delete(key)
  try {
    view.webContents.destroy()
  } catch {
    /* ignore */
  }
  multiWebViews.delete(key)
}

function hideAllMultiWeb(options = {}) {
  const blank = Boolean(options && options.blank)
  for (const id of [...multiWebViews.keys()]) {
    const view = multiWebViews.get(id)
    if (!view) continue
    try {
      view.setVisible(false)
    } catch {
      /* ignore */
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed() && multiWebAttached.has(id)) {
        mainWindow.contentView.removeChildView(view)
      }
    } catch {
      /* ignore */
    }
    multiWebAttached.delete(id)
    if (blank) {
      try {
        void view.webContents.loadURL('about:blank')
      } catch {
        /* ignore */
      }
    }
  }
  if (blank) {
    for (const id of [...multiWebViews.keys()]) destroyMultiWebView(id)
    multiWebAudioPrimary = ''
  }
}

function ensureMultiWebView(id) {
  const key = String(id || '')
  if (!key || !mainWindow || mainWindow.isDestroyed()) return null
  let view = multiWebViews.get(key)
  if (view) return view
  const browserSession = session.fromPartition('persist:jiyu-web')
  view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  view.setBackgroundColor('#10141a')
  view.webContents.setUserAgent(BROWSER_UA)
  view.webContents.setBackgroundThrottling(false)
  void installRiveEmbedAutoScript(view.webContents)
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = String(url || '')
    if (/^https?:\/\//i.test(target) && !shouldBlockBrowserNavigation(target)) showAdDock(target)
    return { action: 'deny' }
  })
  installEmbedNavGuard(view.webContents)
  view.webContents.on('did-stop-loading', () => {
    scheduleBrowserAdShield(view.webContents)
    scheduleRiveEmbedAuto(view.webContents)
    scheduleMultiWebAutoplay(key)
  })
  view.webContents.on('dom-ready', () => {
    scheduleRiveEmbedAuto(view.webContents)
    scheduleMultiWebAutoplay(key)
  })
  view.webContents.on('console-message', (...args) => {
    let message = ''
    if (typeof args[2] === 'string') message = args[2]
    else if (args[1] && typeof args[1] === 'object' && args[1] && 'message' in args[1]) {
      message = String(args[1].message || '')
    }
    const adOpen = /^jiyu-ad-open:(.*)$/.exec(String(message || '').trim())
    if (adOpen?.[1]) showAdDock(String(adOpen[1]).trim())
  })
  multiWebViews.set(key, view)
  installEscapeExitsFullscreen(view.webContents)
  view.webContents.on('focus', () => {
    emitMultiWebUserFocus(key)
  })
  view.webContents.on('before-input-event', (_event, input) => {
    if (!input || input.type !== 'mouseDown') return
    if (input.button && input.button !== 'left') return
    emitMultiWebUserFocus(key)
  })
  return view
}

/** Autoplay / play-button clicks for multi-view embed tiles.
 *  `forceMute` keeps non-spotlight tiles silent; spotlight must not remute. */
function multiWebAutoplayScript(forceMute) {
  const muteJs = forceMute ? 'true' : 'false'
  const level =
    Number.isFinite(webBrowserVolume) && webBrowserVolume > 0.001 ? webBrowserVolume : 1
  return `(() => {
  try {
    const forceMute = ${muteJs};
    const wantVol = ${Number(level)};
    const clickPlay = () => {
      const sels = [
        'button.ytp-large-play-button',
        '.ytp-large-play-button',
        '.vjs-big-play-button',
        '.jw-icon-display',
        '.jw-display-icon-container',
        '.media-control-button[data-play]',
        '.clappr-play-button',
        '.play-wrapper',
        '.plyr__control--overlaid',
        '[data-testid="play-button"]',
        'button[aria-label*="Play" i]',
        'button[title*="Play" i]',
        'button[class*="play" i]',
        'div[class*="play" i][role="button"]'
      ];
      for (const s of sels) {
        const nodes = document.querySelectorAll(s);
        for (const el of nodes) {
          if (!el) continue;
          if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') continue;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (r && (r.width < 8 || r.height < 8)) continue;
          try { el.click(); return 'ui:' + s; } catch (_) {}
        }
      }
      return null;
    };
    const applyMute = (m) => {
      try {
        m.muted = forceMute;
        if (forceMute) { try { m.volume = 0; } catch (_) {} }
        else {
          try {
            const live =
              typeof window.__jiyuVolLevel === 'number' && Number.isFinite(window.__jiyuVolLevel)
                ? Math.max(0, Math.min(1, window.__jiyuVolLevel))
                : wantVol;
            m.volume = live;
          } catch (_) {}
        }
      } catch (_) {}
    };
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) applyMute(v);
    // Treat any non-paused video as playing — readyState/videoWidth lag and
    // re-clicking Clappr/JW play UI toggles pause on LIVE sports.
    const playing = videos.find((v) => !v.paused && !v.ended);
    if (playing) return 'already';
    for (const video of videos) {
      try {
        applyMute(video);
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        if (video.paused) {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (_) {}
    }
    // If a <video> exists, never click toggleable stage/play chrome — play() only.
    if (videos.length) return 'play';
    const ui = clickPlay();
    return ui || 'noop';
  } catch (_) {
    return 'error';
  }
})();`
}

const multiWebAutoplayTimers = new Map()

async function executeInMultiWeb(id, script, options = {}) {
  const view = multiWebViews.get(String(id || ''))
  if (!view || view.webContents.isDestroyed()) return { ok: false, value: null }
  const contents = view.webContents
  const frames = collectContentFrames(contents, { maxFrames: 8 })
  // Always try player frames — sports embeds put <video> in child iframes.
  let value = null
  let anyPlaying = false
  for (const frame of frames) {
    try {
      const v = await raceFrameExec(frame.executeJavaScript(String(script || ''), true), 1200)
      if (v === 'already' || v === 'playing' || (typeof v === 'string' && v.includes('play'))) {
        anyPlaying = true
      }
      if (value == null || value === '' || value === 'noop' || value === 'error' || value === 'idle') {
        value = v
      }
    } catch {
      /* timeout / ignore */
    }
  }
  if (anyPlaying && (value === 'noop' || value === 'idle' || value == null)) value = 'already'
  return { ok: true, value }
}

function emitMultiWebUserFocus(id) {
  if (Date.now() < multiWebIgnoreFocusUntil) return
  const key = String(id || '')
  if (!key) return
  // Already the audio tile — don't re-enter spotlight / autoplay loops.
  if (key === multiWebAudioPrimary) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('browser:multi-focus', { id: key })
}

async function multiWebIsPlaying(id) {
  const result = await executeInMultiWeb(
    id,
    `(() => {
      try {
        const v = Array.from(document.querySelectorAll('video')).find(
          (m) => !m.paused && !m.ended && m.readyState > 1
        );
        return v ? 'playing' : 'idle';
      } catch (_) { return 'idle'; }
    })();`,
  )
  return result?.value === 'playing'
}

function clickMultiWebCenter(id, aggressive = false) {
  const view = multiWebViews.get(String(id || ''))
  if (!view || view.webContents.isDestroyed()) return false
  let bounds
  try {
    bounds = view.getBounds()
  } catch {
    return false
  }
  if (!bounds || bounds.width < 8 || bounds.height < 8) return false
  const contents = view.webContents
  // Only suppress audio-switch for the synthetic click itself — a long
  // ignore window blocked click-to-spotlight on the added stream.
  multiWebIgnoreFocusUntil = Math.max(multiWebIgnoreFocusUntil, Date.now() + 350)
  const points = aggressive
    ? [
        { x: 0.5, y: 0.42 },
        { x: 0.5, y: 0.32 },
        { x: 0.5, y: 0.55 },
        { x: 0.5, y: 0.22 },
      ]
    : [{ x: 0.5, y: 0.42 }]
  for (const pt of points) {
    const x = Math.max(1, Math.min(bounds.width - 1, Math.round(bounds.width * pt.x)))
    const y = Math.max(1, Math.min(bounds.height - 1, Math.round(bounds.height * pt.y)))
    contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 })
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  return true
}

function scheduleMultiWebAutoplay(id) {
  const key = String(id || '')
  if (!key) return
  const prev = multiWebAutoplayTimers.get(key) || []
  for (const t of prev) clearTimeout(t)
  const timers = []
  const forceMute0 = !multiWebAudioPrimary || key !== multiWebAudioPrimary
  // Muted add-on tiles can be nudged harder (autoplay policy allows muted play).
  // Spotlight stays conservative so we don't pause an already-live primary.
  // Keep intervals short — long timers used to hitch the UI for ~10s after close.
  const aggressive = forceMute0
  let clicksLeft = aggressive ? 4 : 1
  const intervals = aggressive ? [350, 900, 1800, 3200] : [700, 1800]
  const run = async () => {
    const view = multiWebViews.get(key)
    if (!view || view.webContents.isDestroyed()) return
    if (!multiWebAttached.has(key)) return
    const forceMute = !multiWebAudioPrimary || key !== multiWebAudioPrimary
    try {
      view.webContents.setAudioMuted(forceMute)
    } catch {
      /* ignore */
    }
    await executeInMultiWeb(key, multiWebAutoplayScript(forceMute))
    const playing = await multiWebIsPlaying(key)
    if (playing) {
      clicksLeft = 0
      return
    }
    if (clicksLeft > 0) {
      clicksLeft -= 1
      clickMultiWebCenter(key, forceMute)
    }
    scheduleBrowserAdShield(view.webContents)
  }
  void run()
  for (const ms of intervals) {
    timers.push(setTimeout(() => void run(), ms))
  }
  multiWebAutoplayTimers.set(key, timers)
}

/** Single-player sports embeds: kick play in main process (renderer nudges race/reload). */
let webBrowserSportsAutoplayTimers = []
let webBrowserSportsAutoplayUrl = ''
let webBrowserSportsAutoplayAt = 0

async function executeInWebBrowser(script) {
  if (!webBrowserView || webBrowserView.webContents.isDestroyed()) {
    return { ok: false, value: null }
  }
  const contents = webBrowserView.webContents
  const frames = collectContentFrames(contents, { maxFrames: 8 })
  let value = null
  for (const frame of frames) {
    try {
      const v = await raceFrameExec(frame.executeJavaScript(String(script || ''), true), 1200)
      value = v
      if (
        v === 'already' ||
        v === 'playing' ||
        (typeof v === 'string' && /play/i.test(v) && v !== 'noop')
      ) {
        break
      }
    } catch {
      /* frame timeout / destroyed */
    }
  }
  return { ok: true, value }
}

async function webBrowserIsPlaying() {
  const result = await executeInWebBrowser(`(() => {
    try {
      const videos = Array.from(document.querySelectorAll('video'));
      const v = videos.find((m) => !m.paused && !m.ended);
      return v ? 'playing' : 'idle';
    } catch (_) { return 'idle'; }
  })();`)
  return result?.value === 'playing'
}

function clickWebBrowserCenter(aggressive = false) {
  if (!webBrowserView || webBrowserView.webContents.isDestroyed() || !webBrowserVisible) {
    return false
  }
  const bounds = webBrowserLastBounds
  if (!bounds || bounds.width < 8 || bounds.height < 8) return false
  const contents = webBrowserView.webContents
  try {
    contents.focus()
  } catch {
    /* ignore */
  }
  // Default: ONE click. Two+ center hits toggle pause on Clappr/JW LIVE embeds.
  const points = aggressive
    ? [
        { x: 0.5, y: 0.42 },
        { x: 0.5, y: 0.32 },
        { x: 0.5, y: 0.55 },
      ]
    : [{ x: 0.5, y: 0.42 }]
  for (const pt of points) {
    const x = Math.max(1, Math.min(bounds.width - 1, Math.round(bounds.width * pt.x)))
    const y = Math.max(1, Math.min(bounds.height - 1, Math.round(bounds.height * pt.y)))
    contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 })
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  return true
}

function scheduleWebBrowserSportsAutoplay(contents, options = {}) {
  if (!contents || contents.isDestroyed?.()) return
  const url = (() => {
    try {
      return contents.getURL() || ''
    } catch {
      return ''
    }
  })()
  if (!needsSportsStyleAutoplay(url)) return
  const force = Boolean(options && options.force)
  const now = Date.now()
  // Ad iframes / partial reloads fire stop-loading often — don't reset forever.
  if (!force && url === webBrowserSportsAutoplayUrl && now - webBrowserSportsAutoplayAt < 20000) {
    return
  }
  webBrowserSportsAutoplayUrl = url
  webBrowserSportsAutoplayAt = now
  clearWebBrowserSportsAutoplay()
  let clicksLeft = 1
  let started = false
  // Replay VODs often mount <video> later than live sports — poll a bit longer.
  const intervals = isReplayAdSensitiveUrl(url) ? [900, 2200, 4500, 8000] : [900, 2800]
  const run = async () => {
    if (!webBrowserView || webBrowserView.webContents.isDestroyed()) return
    if (!webBrowserVisible) return
    if (started) return
    try {
      // Don't undo chrome Mute while kicking autoplay.
      if (!(Number.isFinite(webBrowserVolume) && webBrowserVolume <= 0.001)) {
        webBrowserView.webContents.setAudioMuted(false)
      } else {
        webBrowserView.webContents.setAudioMuted(true)
      }
    } catch {
      /* ignore */
    }
    const keepMuted = Number.isFinite(webBrowserVolume) && webBrowserVolume <= 0.001
    await executeInWebBrowser(multiWebAutoplayScript(keepMuted))
    if (keepMuted) {
      void applyWebBrowserVolume(0, { emit: false })
    }
    const playing = await webBrowserIsPlaying()
    if (playing) {
      started = true
      clicksLeft = 0
      clearWebBrowserSportsAutoplay()
      // Re-assert chrome volume — embeds often reset to 100% when play resumes.
      if (!keepMuted) {
        void applyWebBrowserVolume(webBrowserVolume, { emit: false })
      }
      return
    }
    // One gentle center click only — extra clicks pause a started stream.
    if (clicksLeft > 0) {
      clicksLeft -= 1
      clickWebBrowserCenter(false)
    }
  }
  void run()
  for (const ms of intervals) {
    webBrowserSportsAutoplayTimers.push(setTimeout(() => void run(), ms))
  }
}

function showMultiWeb(id, url, bounds, options = {}) {
  const key = String(id || '')
  const target = normalizeBrowserUrl(url)
  if (!key || !target) return { ok: false, error: 'Invalid multi-web request' }
  if (isStreamRefererOnlyUrl(target) || shouldBlockBrowserNavigation(target)) {
    console.log('[browser] blocked multiShow stream-referer/ad', String(target).slice(0, 140))
    return { ok: false, error: 'Blocked stream-referer page' }
  }
  const view = ensureMultiWebView(key)
  if (!view || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'Browser unavailable' }
  }
  // Single-player browser must not keep playing under multi tiles (ghost audio).
  if (webBrowserView && !webBrowserView.webContents.isDestroyed()) {
    hideWebBrowser({ blank: true, pause: true })
  } else {
    webBrowserVisible = false
  }
  const wasAttached = multiWebAttached.has(key)
  if (!wasAttached) {
    mainWindow.contentView.addChildView(view)
    multiWebAttached.add(key)
  } else {
    mainWindow.contentView.addChildView(view)
  }
  if (bounds) {
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    })
  }
  view.setVisible(true)
  const muted = options.muted !== false && !options.primary
  if (options.primary) multiWebAudioPrimary = key
  else if (!multiWebAudioPrimary) multiWebAudioPrimary = key
  try {
    view.webContents.setAudioMuted(Boolean(muted) || key !== multiWebAudioPrimary)
  } catch {
    /* ignore */
  }
  const current = view.webContents.getURL()
  const same =
    current &&
    current !== 'about:blank' &&
    String(current).split('#')[0] === String(target).split('#')[0]
  if (!same) {
    const httpReferrer = httpReferrerForBrowserUrl(target)
    void view.webContents
      .loadURL(target, httpReferrer ? { httpReferrer } : undefined)
      .catch(() => {})
    scheduleMultiWebAutoplay(key)
  } else if (!wasAttached) {
    // First attach of an already-loaded URL — kick once.
    scheduleMultiWebAutoplay(key)
  }
  // Re-show / layout refresh: do NOT re-nudge (center-clicks pause playing video).
  return { ok: true, url: target }
}

function setMultiWebBounds(id, bounds) {
  const view = multiWebViews.get(String(id || ''))
  if (!view || !bounds) return false
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  })
  return true
}

function setMultiWebAudio(id, muted) {
  const key = String(id || '')
  const view = multiWebViews.get(key)
  if (!view || view.webContents.isDestroyed()) return false
  try {
    view.webContents.setAudioMuted(Boolean(muted))
  } catch {
    return false
  }
  // Match the single-browser volume so multi spotlight isn't stuck quiet.
  const level =
    Number.isFinite(webBrowserVolume) && webBrowserVolume > 0.001 ? webBrowserVolume : 1
  // Autoplay leaves <video muted>; webContents mute alone isn't enough to switch hearable audio.
  const script = muted
    ? `(() => {
        try {
          document.querySelectorAll('video,audio').forEach((m) => {
            m.muted = true;
            try { m.volume = 0; } catch (_) {}
          });
          return 'muted';
        } catch (_) { return 'error'; }
      })();`
    : `(() => {
        try {
          const level =
            typeof window.__jiyuVolLevel === 'number' && Number.isFinite(window.__jiyuVolLevel)
              ? Math.max(0, Math.min(1, window.__jiyuVolLevel))
              : ${Number(level)};
          window.__jiyuVolLevel = level;
          document.querySelectorAll('video,audio').forEach((m) => {
            m.muted = false;
            try { m.volume = level; } catch (_) {}
            if (m.paused) {
              const p = m.play();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }
          });
          return 'unmuted';
        } catch (_) { return 'error'; }
      })();`
  void executeInMultiWeb(key, script)
  return true
}

/** Mute every multi tile except the spotlight; unmute the spotlight. */
function setMultiWebSpotlight(primaryId) {
  const primary = String(primaryId || '')
  const same = primary && primary === multiWebAudioPrimary
  multiWebAudioPrimary = primary
  // Mute single browser too — leftover watch session must stay silent.
  if (webBrowserView && !webBrowserView.webContents.isDestroyed()) {
    try {
      webBrowserView.webContents.setAudioMuted(true)
    } catch {
      /* ignore */
    }
  }
  for (const id of multiWebViews.keys()) {
    setMultiWebAudio(id, id !== primary)
  }
  if (primary) {
    setTimeout(() => setMultiWebAudio(primary, false), 120)
    setTimeout(() => {
      // Re-mute everyone else in case a nudge unmuted a tile.
      for (const id of multiWebViews.keys()) {
        if (id !== primary) setMultiWebAudio(id, true)
      }
      setMultiWebAudio(primary, false)
    }, 700)
    if (!same) {
      void executeInMultiWeb(primary, multiWebAutoplayScript(false))
    }
  }
  return true
}

function normalizeBrowserUrl(raw) {
  let target = String(raw || '').trim()
  if (!target) return null
  if (!/^https?:\/\//i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}([/:?]|$)/i.test(target)) {
      target = `https://${target}`
    } else {
      target = `https://www.google.com/search?q=${encodeURIComponent(target)}`
    }
  }
  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

async function loadDevUrl(win, attempt = 0) {
  try {
    await win.loadURL(DEV_URL)
  } catch {
    if (attempt >= 20 || win.isDestroyed()) return
    await new Promise((r) => setTimeout(r, 300))
    return loadDevUrl(win, attempt + 1)
  }
}

app.whenReady().then(() => {
  loadJiyuDotEnv()
  loadDotEnvFile(path.join(app.getPath('userData'), '.env'))
  if (jiyuDataPaths?.temp) {
    process.env.TEMP = jiyuDataPaths.temp
    process.env.TMP = jiyuDataPaths.temp
  }

  recoverCatalogFromLegacyApps()
  sweepPartialTorrents()
  const partialSweep = setInterval(sweepPartialTorrents, 15 * 60 * 1000)
  if (typeof partialSweep.unref === 'function') partialSweep.unref()

  // Desktop Chrome UA + Sec-CH-UA* on the shared web session. Electron's default
  // UA / empty brands look non-browser to Cloudflare.
  try {
    const ses = webSession()
    ses.setUserAgent(BROWSER_UA, 'en-US,en;q=0.9')
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = withDesktopChromeClientHints({
        ...details.requestHeaders,
        'User-Agent': BROWSER_UA,
      })
      if (!headers.Accept && !headers.accept) {
        headers.Accept =
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
      }
      if (!headers['Accept-Language'] && !headers['accept-language']) {
        headers['Accept-Language'] = 'en-US,en;q=0.9'
      }
      // fstream365 / vsembed: main document needs a site Referer (else nginx 404).
      // Never overwrite same-origin XHR Referer — getSources then returns HTML and
      // CryptoJS throws "Malformed UTF-8 data" (player spinner forever).
      // embed.st: strip Referer on document navigations — a Referer yields a stub player.
      try {
        const host = new URL(details.url).hostname.replace(/^www\./i, '').toLowerCase()
        if (
          (host === 'embed.st' ||
            host.endsWith('.embed.st') ||
            host === 'embedhd.st' ||
            host.endsWith('.embedhd.st')) &&
          (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')
        ) {
          delete headers.Referer
          delete headers.referer
          callback({ requestHeaders: headers })
          return
        }
      } catch {
        /* ignore */
      }
      if (applyYouTubeEmbedderHeaders(details.url, headers)) {
        callback({ requestHeaders: headers })
        return
      }
      const forcedReferrer = httpReferrerForBrowserUrl(details.url)
      if (forcedReferrer) {
        const current = String(headers.Referer || headers.referer || '')
        let reqHost = ''
        let curHost = ''
        try {
          reqHost = new URL(details.url).hostname.replace(/^www\./i, '').toLowerCase()
        } catch {
          /* ignore */
        }
        try {
          curHost = current ? new URL(current).hostname.replace(/^www\./i, '').toLowerCase() : ''
        } catch {
          /* ignore */
        }
        const sameSite =
          Boolean(curHost) &&
          (curHost === reqHost ||
            reqHost.endsWith(`.${curHost}`) ||
            curHost.endsWith(`.${reqHost}`))
        const missing =
          !current || /^(about:blank|about:srcdoc|chrome:|chrome-error:|data:)/i.test(current)
        if (!sameSite && (missing || details.resourceType === 'mainFrame')) {
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === 'referer') delete headers[name]
          }
          headers.Referer = forcedReferrer
        }
      }
      callback({ requestHeaders: headers })
    })
    // Block ad networks + installer/adware bait in one handler (Electron keeps one listener).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url || '')
      if (isBlockedBrowserDownloadUrl(url)) {
        callback({ cancel: true })
        return
      }
      try {
        const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
        // LiveXTV / DoodStream VODs refuse to play unless Google ad scripts load.
        if (isGoogleAdsNetworkHost(host) && browserSessionAllowsReplayAds()) {
          callback({})
          return
        }
        const blockedHost =
          /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|popads\.net|propellerads\.com|exoclick\.com|trafficjunky\.net|juicyads\.com|tsyndicate\.com|adsterra\.com|adnxs\.com|moatads\.com|taboola\.com|outbrain\.com|adaround\.net|adultfriendfinder\.com|stripchat\.com|chaturbate\.com|pornhub\.com|xvideos\.com|xnxx\.com|xhamster\.com|spankwire\.com|livejasmin\.com|drimzzzz\.info|wpnxiswpuyrfn\.icu|therocketlanguages\.com|opera\.com|geo\.opera\.com|worldofwarships\.com|wargaming\.net)$/i.test(
            host,
          ) ||
          ((host === 'fstream365.com' || host.endsWith('.fstream365.com')) &&
            /\/banner\//i.test(url))
        if (blockedHost || isAdHijackUrl(url)) {
          callback({ cancel: true })
          return
        }
      } catch {
        /* ignore */
      }
      if (isAdHijackUrl(url)) {
        callback({ cancel: true })
        return
      }
      callback({})
    })
    installWebSessionDownloadGuard(ses)
    console.log('[cf-unlock] session UA =', BROWSER_UA)
    console.log('[cf-unlock] Sec-CH-UA =', desktopChromeClientHintHeaders()['Sec-CH-UA'])
  } catch (err) {
    console.log(
      '[cf-unlock] failed to apply Chrome Client Hints',
      err instanceof Error ? err.message : err,
    )
  }

  // Block popup windows + guest HTML-fullscreen (YouTube auto-max on play).
  // Cloudflare Turnstile MUST be allowed to open challenge windows — denying
  // every window.open left EZTV stuck on "Verifying…" after clicking Verify.
  app.on('web-contents-created', (_event, contents) => {
    try {
      if (contents.session === webSession()) {
        contents.setUserAgent(BROWSER_UA)
      }
    } catch {
      /* ignore */
    }
    contents.setWindowOpenHandler(({ url }) => {
      const target = String(url || '')
      const allowCf =
        /challenges\.cloudflare\.com|cloudflare\.com\/cdn-cgi|turnstile|__cf_chl/i.test(target) ||
        (unlockWindow &&
          !unlockWindow.isDestroyed() &&
          contents.id === unlockWindow.webContents.id)
      if (allowCf) {
        console.log('[cf-unlock] allowing window.open', target.slice(0, 160))
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: unlockWindow && !unlockWindow.isDestroyed() ? unlockWindow : undefined,
            show: true,
            autoHideMenuBar: true,
            webPreferences: {
              session: webSession(),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          },
        }
      }
      return { action: 'deny' }
    })
    contents.on('enter-html-full-screen', () => {
      // Main UI player fullscreen must be allowed (hides the Windows taskbar).
      try {
        if (
          mainWindow &&
          !mainWindow.isDestroyed() &&
          contents.id === mainWindow.webContents.id
        ) {
          return
        }
      } catch {
        /* ignore */
      }
      // Guest pages (YouTube / sports embeds) must never use the HTML Fullscreen API —
      // it fights Jiyu's OS fullscreen (enter then immediate leave). Always dismiss
      // guest HTML FS; keep or restore OS fullscreen when Jiyu requested it.
      // Never force OS FS *off* here — a stale want-flag must not yank Full out from
      // under the user when a guest briefly tries HTML fullscreen.
      void contents
        .executeJavaScript(
          `(() => { try { document.exitFullscreen?.(); document.webkitExitFullscreen?.(); } catch (_) {} })();`,
          true,
        )
        .catch(() => {})
      if (jiyuWantOsFullScreen) {
        try {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
            mainWindow.setFullScreen(true)
          }
        } catch {
          /* ignore */
        }
      }
    })
  })

  try {
    APP_VERSION = app.getVersion() || APP_VERSION
  } catch {
    /* keep package.json fallback */
  }
  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: 'Jiyu',
      version: APP_VERSION,
      copyright: 'Jiyu',
    })
  }

  // Many IPTV CDNs reject Electron's default UA or empty clients.
  // Still emit standard desktop Chrome Sec-CH-UA* alongside STREAM_UA.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || ''
    let userAgent = STREAM_UA
    let referer
    let origin
    try {
      const host = new URL(url).host.toLowerCase()
      const override = playbackHeaderOverrides.get(host)
      if (override?.userAgent) userAgent = override.userAgent
      if (override?.referrer) referer = override.referrer
      // Manifest/probe host often differs from segment CDN — carry the active
      // playback Referer onto media requests so RiveStream HLS isn't blocked.
      if (!referer && activePlaybackReferrer && isIptvMediaUrl(url)) {
        referer = activePlaybackReferrer
      }
    } catch {
      /* ignore bad URLs */
    }
    const headers = withDesktopChromeClientHints({
      ...details.requestHeaders,
      'User-Agent': userAgent,
    })
    if (!headers.Accept && !headers.accept) headers.Accept = '*/*'
    // Home/local channel YouTube iframes use defaultSession (file:// → no Referer).
    if (applyYouTubeEmbedderHeaders(url, headers)) {
      callback({ requestHeaders: headers })
      return
    }
    // CVM Vimeo live: player config + CDN segments expect the official site origin
    if (/vimeocdn\.com|player\.vimeo\.com|vimeo\.com\/live\//i.test(url)) {
      headers.Referer = 'https://site.cvmtv.com/'
      headers.Origin = 'https://site.cvmtv.com'
    } else if (referer) {
      headers.Referer = referer
      try {
        origin = new URL(referer).origin
        headers.Origin = origin
      } catch {
        /* keep referer only */
      }
    }
    callback({ requestHeaders: headers })
  })

  // IPTV / HLS often omits ACAO or pins it to another site — hls.js in the
  // renderer needs * so manifests and .ts segments load (same fix as Vimeo).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || ''
    if (!isIptvMediaUrl(url)) {
      callback({})
      return
    }
    const responseHeaders = { ...(details.responseHeaders || {}) }
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'access-control-allow-origin') {
        delete responseHeaders[key]
      }
    }
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    callback({ responseHeaders })
  })

  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

ipcMain.handle('app:getVersion', async () => APP_VERSION)

ipcMain.handle('app:backgroundSync', async (_event, active) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(!active)
    }
  } catch {
    /* ignore */
  }
  return { ok: true }
})

ipcMain.handle('app:updater:check', async () => {
  if (!app.isPackaged || !autoUpdaterRef) {
    return { ok: false, reason: 'dev', message: 'Updates only run in packaged builds.' }
  }
  try {
    const result = await autoUpdaterRef.checkForUpdates()
    return {
      ok: true,
      version: result?.updateInfo?.version || null,
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})

ipcMain.handle('app:updater:download', async () => {
  if (!app.isPackaged || !autoUpdaterRef) {
    return { ok: false, reason: 'dev' }
  }
  try {
    await autoUpdaterRef.downloadUpdate()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})

ipcMain.handle('app:updater:install', async () => {
  if (!app.isPackaged || !autoUpdaterRef) {
    return { ok: false, reason: 'dev' }
  }
  // isSilent=false, isForceRunAfter=true
  setImmediate(() => {
    try {
      autoUpdaterRef.quitAndInstall(false, true)
    } catch {
      /* ignore */
    }
  })
  return { ok: true }
})

ipcMain.handle('system:getCapabilities', async () => {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  let onBattery = null
  try {
    if (typeof powerMonitor?.isOnBatteryPower === 'function') {
      onBattery = powerMonitor.isOnBatteryPower()
    }
  } catch {
    onBattery = null
  }
  let gpuAccelerated = null
  try {
    const status = app.getGPUFeatureStatus?.()
    if (status && typeof status === 'object') {
      const gl = String(status.gpu_compositing || status.webgl || '')
      if (/enabled/i.test(gl)) gpuAccelerated = true
      else if (/disabled|unavailable/i.test(gl)) gpuAccelerated = false
    }
  } catch {
    gpuAccelerated = null
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus()?.length || 1,
    totalMemGB: totalMem > 0 ? totalMem / (1024 * 1024 * 1024) : 0,
    freeMemGB: freeMem > 0 ? freeMem / (1024 * 1024 * 1024) : 0,
    onBattery,
    gpuAccelerated,
  }
})

ipcMain.handle('system:setPerformanceKnobs', async (_event, knobs) => {
  if (!knobs || typeof knobs !== 'object') return { ok: false }
  if (Number.isFinite(knobs.torrentMaxConns) && knobs.torrentMaxConns > 0) {
    performanceKnobs.torrentMaxConns = Math.min(200, Math.max(8, Math.floor(knobs.torrentMaxConns)))
  }
  if (Number.isFinite(knobs.torrentPrefetchPieces) && knobs.torrentPrefetchPieces > 0) {
    performanceKnobs.torrentPrefetchPieces = Math.min(
      400,
      Math.max(16, Math.floor(knobs.torrentPrefetchPieces)),
    )
  }
  if (Number.isFinite(knobs.torrentCriticalPieces) && knobs.torrentCriticalPieces > 0) {
    performanceKnobs.torrentCriticalPieces = Math.min(
      64,
      Math.max(4, Math.floor(knobs.torrentCriticalPieces)),
    )
  }
  if (Number.isFinite(knobs.streamProbeConcurrency) && knobs.streamProbeConcurrency > 0) {
    performanceKnobs.streamProbeConcurrency = Math.min(
      48,
      Math.max(4, Math.floor(knobs.streamProbeConcurrency)),
    )
  }
  if (typeof knobs.deviceClass === 'string' && knobs.deviceClass) {
    performanceKnobs.deviceClass = knobs.deviceClass
  }
  // Live-update an existing WebTorrent client when possible.
  try {
    if (torrentClientPromise) {
      const client = await torrentClientPromise
      if (client && typeof client === 'object') {
        client.maxConns = performanceKnobs.torrentMaxConns
      }
    }
  } catch {
    /* ignore */
  }
  console.log('[perf] knobs', performanceKnobs)
  return { ok: true }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function catalogPath() {
  return path.join(app.getPath('userData'), 'playlist-sources.json')
}

function torrentSourcesPath() {
  return path.join(app.getPath('userData'), 'torrent-sources.json')
}

function readTorrentSourcesFile() {
  try {
    const file = torrentSourcesPath()
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeTorrentSourcesFile(sources) {
  const file = torrentSourcesPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(Array.isArray(sources) ? sources : [], null, 2), 'utf8')
}

/** Recover playlists after Signal → Jiyu rename (old Electron userData folder). */
function recoverCatalogFromLegacyApps() {
  try {
    const dest = catalogPath()
    if (fs.existsSync(dest)) {
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'))
      if (Array.isArray(parsed) && parsed.length > 0) return false
    }

    const roaming = path.dirname(app.getPath('userData'))
    const legacyDirs = ['signal-media-center', 'Signal', 'signal']
    for (const dir of legacyDirs) {
      const candidate = path.join(roaming, dir, 'playlist-sources.json')
      if (!fs.existsSync(candidate)) continue
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(candidate, dest)
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function readCatalogFile() {
  try {
    const file = catalogPath()
    if (!fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCatalogFile(sources) {
  const file = catalogPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(sources, null, 2), 'utf8')
}

ipcMain.handle('catalog:list', async () => readCatalogFile())

ipcMain.handle('catalog:put', async (_event, source) => {
  if (!source || typeof source.id !== 'string') {
    throw new Error('Invalid playlist source')
  }
  const rows = readCatalogFile()
  const idx = rows.findIndex((row) => row.id === source.id)
  if (idx >= 0) rows[idx] = source
  else rows.push(source)
  writeCatalogFile(rows)
  return true
})

ipcMain.handle('catalog:delete', async (_event, id) => {
  writeCatalogFile(readCatalogFile().filter((row) => row.id !== id))
  return true
})

ipcMain.handle('catalog:clear', async () => {
  writeCatalogFile([])
  return true
})

ipcMain.handle('catalog:replaceAll', async (_event, sources) => {
  writeCatalogFile(Array.isArray(sources) ? sources : [])
  return true
})

ipcMain.handle('torrentSources:list', async () => readTorrentSourcesFile() ?? [])

ipcMain.handle('torrentSources:save', async (_event, sources) => {
  writeTorrentSourcesFile(sources)
  return true
})

function emitTmdbProgress(payload) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('tmdb:progress', payload)
    }
  } catch {
    /* ignore */
  }
}

/** Pause/cancel for long TMDB catalog fetches (driven by renderer sync controls). */
const tmdbFetchControl = { paused: false, cancelled: false }

function resetTmdbFetchControl() {
  tmdbFetchControl.paused = false
  tmdbFetchControl.cancelled = false
}

async function awaitTmdbFetchControl() {
  while (tmdbFetchControl.paused && !tmdbFetchControl.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (tmdbFetchControl.cancelled) {
    const err = new Error('Catalog sync cancelled')
    err.code = 'TMDB_SYNC_CANCELLED'
    throw err
  }
}

/**
 * TMDB TV lists.
 * kind: 'popular' (discover 2010+) | 'on_the_air' | 'trending' (week)
 * options.withExternalIds — default true (EZTV); false for Rive/TMDB-only shelves (faster).
 * Key from .env — never sent to the renderer except as results.
 */
async function fetchTmdbTvCatalog(kind = 'popular', limit = 3000, options = {}) {
  const apiKey = process.env.TMDB_API_KEY || process.env.TMDB_KEY || ''
  if (!apiKey) {
    return { ok: false, shows: [], error: 'TMDB_API_KEY missing from .env' }
  }
  const mode =
    kind === 'on_the_air'
      ? 'on_the_air'
      : kind === 'trending'
        ? 'trending'
        : kind === 'anime'
          ? 'anime'
          : kind === 'animation'
            ? 'animation'
            : kind === 'kids'
              ? 'kids'
              : kind === 'by_year'
                ? 'by_year'
                : 'popular'
  const withExternalIds = options?.withExternalIds !== false
  const byYearStart = 2000
  const byYearPerYear = 20
  const byYearEnd = new Date().getFullYear()
  const byYearDefault =
    Math.max(1, byYearEnd - byYearStart + 1) * byYearPerYear
  const defaultLimit =
    mode === 'on_the_air'
      ? 500
      : mode === 'trending'
        ? 100
        : mode === 'anime'
          ? 2000
          : mode === 'animation'
            ? 8000
            : mode === 'kids'
              ? 500
              : mode === 'by_year'
                ? byYearDefault
                : 3000
  // Animation (Zenox) may pull up to ~10k discover rows (TMDB page cap).
  const hardCap = mode === 'animation' ? 10000 : 5000
  const target = Math.max(1, Math.min(hardCap, Number(limit) || defaultLimit))
  const pageSize = 20
  const pagesNeeded = Math.ceil(target / pageSize)
  const shows = []
  try {
    await awaitTmdbFetchControl()
    emitTmdbProgress({ phase: 'discover', kind: mode, page: 0, pagesNeeded, done: 0, total: target })

    if (mode === 'by_year') {
      // Top N per first-air year (newest → oldest). One Discover page per year.
      const years = []
      for (let y = byYearEnd; y >= byYearStart; y -= 1) years.push(y)
      const yearTarget = Math.min(target, years.length * byYearPerYear)
      const seenIds = new Set()
      for (let i = 0; i < years.length && shows.length < yearTarget; i += 1) {
        await awaitTmdbFetchControl()
        const year = years[i]
        const url = new URL('https://api.themoviedb.org/3/discover/tv')
        url.searchParams.set('api_key', apiKey)
        url.searchParams.set('language', 'en-US')
        url.searchParams.set('page', '1')
        url.searchParams.set('sort_by', 'popularity.desc')
        url.searchParams.set('first_air_date_year', String(year))
        url.searchParams.set('include_null_first_air_dates', 'false')
        const res = await fetch(url)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return {
            ok: false,
            shows: [],
            error: `TMDB by_year ${year} HTTP ${res.status}: ${body.slice(0, 160)}`,
          }
        }
        const json = await res.json()
        const results = Array.isArray(json.results) ? json.results : []
        let taken = 0
        for (const row of results) {
          if (taken >= byYearPerYear || shows.length >= yearTarget) break
          const id = row?.id
          if (!id || seenIds.has(id)) continue
          seenIds.add(id)
          shows.push(row)
          taken += 1
        }
        emitTmdbProgress({
          phase: 'discover',
          kind: mode,
          page: i + 1,
          pagesNeeded: years.length,
          done: Math.min(shows.length, yearTarget),
          total: yearTarget,
        })
      }
    } else {
      for (let page = 1; page <= pagesNeeded; page += 1) {
        await awaitTmdbFetchControl()
        const url =
          mode === 'on_the_air'
            ? new URL('https://api.themoviedb.org/3/tv/on_the_air')
            : mode === 'trending'
              ? new URL('https://api.themoviedb.org/3/trending/tv/week')
              : new URL('https://api.themoviedb.org/3/discover/tv')
        url.searchParams.set('api_key', apiKey)
        url.searchParams.set('language', 'en-US')
        url.searchParams.set('page', String(page))
        if (mode === 'popular') {
          url.searchParams.set('sort_by', 'popularity.desc')
          url.searchParams.set('first_air_date.gte', '2010-01-01')
          url.searchParams.set('include_null_first_air_dates', 'false')
        }
        if (mode === 'anime') {
          // Anime → Full Shows: complete (Ended) Japanese animation only.
          // Weekly single-eps stay on New Releases via SubsPlease.
          url.searchParams.set('with_genres', '16')
          url.searchParams.set('with_original_language', 'ja')
          url.searchParams.set('with_status', '3') // Ended
          url.searchParams.set('sort_by', 'popularity.desc')
          url.searchParams.set('include_null_first_air_dates', 'false')
        }
        if (mode === 'animation') {
          // Zenox /tv?genre=16 — all TMDB Animation TV (anime + kids + Western).
          url.searchParams.set('with_genres', '16')
          url.searchParams.set('sort_by', 'popularity.desc')
          url.searchParams.set('include_null_first_air_dates', 'false')
        }
        if (mode === 'kids') {
          // Kids → Shows: TMDB Kids genre (10762). No Cloudflare — Rive plays by id.
          url.searchParams.set('with_genres', '10762')
          url.searchParams.set('sort_by', 'popularity.desc')
          url.searchParams.set('include_null_first_air_dates', 'false')
          url.searchParams.set('without_genres', '10767,10763') // Talk / News
        }
        const res = await fetch(url)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return {
            ok: false,
            shows: [],
            error: `TMDB ${mode} HTTP ${res.status}: ${body.slice(0, 160)}`,
          }
        }
        const json = await res.json()
        const results = Array.isArray(json.results) ? json.results : []
        if (results.length === 0) break
        // Trending mixes movies + TV — keep TV / shows only.
        const tvRows =
          mode === 'trending'
            ? results.filter((row) => !row.media_type || row.media_type === 'tv')
            : results
        shows.push(...tvRows)
        emitTmdbProgress({
          phase: 'discover',
          kind: mode,
          page,
          pagesNeeded,
          done: Math.min(shows.length, target),
          total: target,
        })
        const totalPages = Number(json.total_pages) || pagesNeeded
        if (page >= totalPages) break
      }
    }
    const top = shows.slice(0, target)
    const mapShow = (show, imdbId = '') => ({
      tmdbId: show.id,
      name: show.name || show.original_name || '',
      firstAirDate: show.first_air_date || '',
      popularity: show.popularity ?? 0,
      imdbId,
      overview: String(show.overview || '')
        .replace(/\s+/g, ' ')
        .trim(),
      poster: show.poster_path
        ? `https://image.tmdb.org/t/p/w342${show.poster_path}`
        : '',
      originalLanguage: String(show.original_language || '').trim(),
      genreIds: Array.isArray(show.genre_ids)
        ? show.genre_ids.map((g) => Number(g)).filter((n) => Number.isFinite(n))
        : [],
    })

    if (!withExternalIds) {
      const out = top.map((show) => mapShow(show))
      emitTmdbProgress({
        phase: 'done',
        kind: mode,
        page: out.length,
        pagesNeeded: out.length,
        done: out.length,
        total: out.length,
      })
      return { ok: true, shows: out.filter((s) => s.tmdbId && s.name), error: null }
    }

    const out = new Array(top.length)
    let cursor = 0
    let idsDone = 0
    const workers = Array.from({ length: Math.min(8, top.length) }, async () => {
      while (cursor < top.length) {
        await awaitTmdbFetchControl()
        const idx = cursor
        cursor += 1
        const show = top[idx]
        let imdbId = ''
        try {
          const extUrl = new URL(`https://api.themoviedb.org/3/tv/${show.id}/external_ids`)
          extUrl.searchParams.set('api_key', apiKey)
          const extRes = await fetch(extUrl)
          if (extRes.ok) {
            const ext = await extRes.json()
            imdbId = String(ext.imdb_id || '').replace(/^tt/i, '')
            if (!/^\d+$/.test(imdbId)) imdbId = ''
          }
        } catch {
          imdbId = ''
        }
        out[idx] = mapShow(show, imdbId)
        idsDone += 1
        if (idsDone === 1 || idsDone === top.length || idsDone % 40 === 0) {
          emitTmdbProgress({
            phase: 'ids',
            kind: mode,
            page: idsDone,
            pagesNeeded: top.length,
            done: idsDone,
            total: top.length,
          })
        }
      }
    })
    await Promise.all(workers)
    await awaitTmdbFetchControl()
    emitTmdbProgress({
      phase: 'done',
      kind: mode,
      page: top.length,
      pagesNeeded: top.length,
      done: top.length,
      total: top.length,
    })
    return { ok: true, shows: out.filter(Boolean), error: null }
  } catch (err) {
    if (err?.code === 'TMDB_SYNC_CANCELLED' || /Catalog sync cancelled/i.test(String(err?.message || ''))) {
      return { ok: false, shows: [], error: 'Catalog sync cancelled', cancelled: true }
    }
    throw err
  }
}

ipcMain.handle('tmdb:popularTv', async (_event, limit) => fetchTmdbTvCatalog('popular', limit))
ipcMain.handle('tmdb:tvCatalog', async (_event, kind, limit, options) =>
  fetchTmdbTvCatalog(kind, limit, options || {}),
)
ipcMain.handle('tmdb:syncControl', async (_event, action) => {
  const cmd = String(action || '').toLowerCase()
  if (cmd === 'pause') {
    tmdbFetchControl.paused = true
  } else if (cmd === 'resume') {
    tmdbFetchControl.paused = false
  } else if (cmd === 'cancel') {
    tmdbFetchControl.cancelled = true
    tmdbFetchControl.paused = false
  } else if (cmd === 'reset') {
    resetTmdbFetchControl()
  }
  return {
    ok: true,
    paused: tmdbFetchControl.paused,
    cancelled: tmdbFetchControl.cancelled,
  }
})

ipcMain.handle('dialog:openPlaylist', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import M3U playlist(s)',
    filters: [
      { name: 'Playlists', extensions: ['m3u', 'm3u8'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  })

  if (result.canceled || result.filePaths.length === 0) return null

  return {
    files: result.filePaths.map((filePath) => ({
      path: filePath,
      content: fs.readFileSync(filePath, 'utf8'),
    })),
  }
})

ipcMain.handle('shell:openExternal', async (_event, url) => {
  await shell.openExternal(url)
})

ipcMain.handle('browser:show', async (_event, bounds) => {
  return showWebBrowser(bounds)
})

ipcMain.handle('browser:hide', async (_event, options) => {
  hideWebBrowser(options || {})
  return true
})

ipcMain.handle('browser:getVolume', async () => ({
  percent: Math.round((Number.isFinite(webBrowserVolume) ? webBrowserVolume : 1) * 100),
}))

ipcMain.handle('browser:setVolume', async (_event, percent) => {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  return applyWebBrowserVolume(pct / 100)
})

ipcMain.handle('browser:setBounds', async (_event, bounds) => {
  if (!webBrowserView || !bounds) return false
  if (isPipLikeBrowserBounds(bounds)) hideAdDock()
  applyBounds(webBrowserView, bounds)
  return true
})

function sameBrowserPageUrl(a, b) {
  try {
    const left = new URL(String(a || ''))
    const right = new URL(String(b || ''))
    if (left.hostname.replace(/^www\./i, '').toLowerCase() !== right.hostname.replace(/^www\./i, '').toLowerCase()) {
      return false
    }
    return left.href.split('#')[0] === right.href.split('#')[0]
  } catch {
    return String(a || '') === String(b || '')
  }
}

function rivestreamTmdbFromBrowserUrl(url) {
  try {
    const u = new URL(String(url || ''))
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 'rivestream.ru' || host.endsWith('.rivestream.ru')) {
      return String(u.searchParams.get('id') || u.searchParams.get('tmdb') || '').trim()
    }
    const m =
      u.pathname.match(/\/(?:embed\/)?tv\/(\d+)(?:\/|$)/i) ||
      u.pathname.match(/\/tv\/(\d+)-\d+-\d+/i)
    if (m) return m[1]
    return String(u.searchParams.get('tmdb') || u.searchParams.get('id') || '').trim()
  } catch {
    return ''
  }
}

/** Keep guest on vaplayer/vidup/… when React re-asks for the Rive shell URL. */
function shouldKeepRiveGuestHop(currentUrl, requestedUrl) {
  try {
    const current = String(currentUrl || '')
    const requested = String(requestedUrl || '')
    if (!current || !requested) return false
    if (sameBrowserPageUrl(current, requested)) return true
    const curHost = new URL(current).hostname.replace(/^www\./i, '').toLowerCase()
    const reqHost = new URL(requested).hostname.replace(/^www\./i, '').toLowerCase()
    const reqIsRive = reqHost === 'rivestream.ru' || reqHost.endsWith('.rivestream.ru')
    const curIsDirect =
      /(^|\.)(vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov)$/i.test(
        curHost,
      )
    if (!reqIsRive || !curIsDirect) return false
    const reqId = rivestreamTmdbFromBrowserUrl(requested)
    const curId = rivestreamTmdbFromBrowserUrl(current)
    return Boolean(reqId && curId && reqId === curId)
  } catch {
    return false
  }
}

ipcMain.handle('browser:navigate', async (_event, url) => {
  const target = normalizeBrowserUrl(url)
  if (!target) return { ok: false, error: 'Invalid URL' }
  if (isStreamRefererOnlyUrl(target) || shouldBlockBrowserNavigation(target)) {
    console.log('[browser] blocked navigate to stream-referer/ad url', String(target).slice(0, 140))
    return { ok: false, error: 'Blocked stream-referer page' }
  }
  const view = ensureWebBrowser()
  if (!view) return { ok: false, error: 'Browser unavailable' }
  if (!webBrowserAttached || !webBrowserVisible) showWebBrowser()
  try {
    let current = ''
    try {
      current = view.webContents.getURL() || ''
    } catch {
      current = ''
    }
    if (current && (sameBrowserPageUrl(current, target) || shouldKeepRiveGuestHop(current, target))) {
      return { ok: true, url: current, kept: true }
    }
    // PiP/hide may have left the guest muted — restore only if chrome volume is up.
    try {
      const wantSound = !(Number.isFinite(webBrowserVolume) && webBrowserVolume <= 0.001)
      view.webContents.setAudioMuted(!wantSound)
    } catch {
      /* ignore */
    }
    // Force a fresh sports/replay autoplay cycle (retries after PiP/hide used to no-op).
    if (needsSportsStyleAutoplay(target)) {
      webBrowserSportsAutoplayUrl = ''
      webBrowserSportsAutoplayAt = 0
    }
    // Start navigation immediately — do not wait for YouTube to finish loading
    // (loadURL can take many seconds and made PiP feel broken/slow).
    const httpReferrer = httpReferrerForBrowserUrl(target)
    void view.webContents
      .loadURL(target, httpReferrer ? { httpReferrer } : undefined)
      .catch((err) => {
        if (err && (err.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(String(err)))) return
        console.warn('[browser:navigate]', err instanceof Error ? err.message : err)
      })
    return { ok: true, url: target }
  } catch (err) {
    if (err && (err.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(String(err)))) {
      return { ok: true, url: target }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/** Open sites in a child window of Jiyu — always stays in-app, most reliable for YouTube */
ipcMain.handle('browser:openPanel', async (_event, url) => {
  const target = normalizeBrowserUrl(url)
  if (!target) return { ok: false, error: 'Invalid URL' }
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'No main window' }

  const panel = new BrowserWindow({
    parent: mainWindow,
    modal: false,
    width: 1180,
    height: 780,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0b0d10',
    title: 'Jiyu Web',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: 'persist:jiyu-web',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  panel.webContents.setUserAgent(BROWSER_UA)
  panel.once('ready-to-show', () => {
    panel.show()
    panel.focus()
  })
  panel.webContents.setWindowOpenHandler(({ url: next }) => {
    if (/^https?:\/\//i.test(next)) {
      void panel.webContents.loadURL(next)
    }
    return { action: 'deny' }
  })
  panel.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'mediaKeySystem', 'fullscreen', 'pointerLock'].includes(permission))
  })

  try {
    await panel.loadURL(target)
  } catch (err) {
    if (!(err && (err.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(String(err))))) {
      // Still show the window; page may recover
    }
  }
  return { ok: true, url: target }
})

ipcMain.handle('browser:goBack', async () => {
  if (webBrowserView) navGoBack(webBrowserView.webContents)
  return true
})

ipcMain.handle('browser:goForward', async () => {
  if (webBrowserView) navGoForward(webBrowserView.webContents)
  return true
})

ipcMain.handle('browser:reload', async () => {
  webBrowserView?.webContents.reload()
  return true
})

ipcMain.handle('browser:openExternalCurrent', async () => {
  const url = webBrowserView?.webContents.getURL()
  if (url && /^https?:\/\//i.test(url)) await shell.openExternal(url)
  return true
})

/** Serialize browser:execute so sports autoplay nudges don't pile up forever. */
let browserExecuteTail = Promise.resolve()

ipcMain.handle('browser:execute', async (_event, code) => {
  const run = async () => {
    if (!webBrowserView || webBrowserView.webContents.isDestroyed()) {
      return { ok: false, error: 'Browser unavailable' }
    }
    const script = String(code || '')
    const contents = webBrowserView.webContents
    const frames = collectContentFrames(contents, { maxFrames: 8 })

    const frameResults = []
    let best = null
    for (const frame of frames) {
      try {
        const result = await raceFrameExec(frame.executeJavaScript(script, true), 1200)
        const entry = { ok: true, url: frame.url || '', result }
        frameResults.push(entry)
        const tag = typeof result === 'string' ? result : ''
        if (
          tag &&
          tag !== 'no-video' &&
          tag !== 'noop' &&
          tag !== 'error' &&
          (!best || best.result === 'no-video')
        ) {
          best = entry
        }
        if (!best) best = entry
        // Only short-circuit on clear play successes — parent pages often return
        // overlay-click strings before the real player iframe is ready.
        if (
          best &&
          isSportsEmbedHost(best.url || '') &&
          /^(play-with-sound|jw-unmute|player-click|play-ui-click|playing|already)$/i.test(tag)
        ) {
          break
        }
      } catch (err) {
        frameResults.push({
          ok: false,
          url: frame.url || '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!best && frameResults.length > 0) {
      return {
        ok: false,
        error: frameResults[0]?.error || 'Script failed in all frames',
        frameResults,
      }
    }
    return { ok: true, result: best?.result, frameResults }
  }

  const pending = browserExecuteTail.then(run, run)
  browserExecuteTail = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
})

/** Synthetic click inside the embed view (cross-origin iframes block JS unmute). */
ipcMain.handle('browser:clickCenter', async (_event, options) => {
  if (!webBrowserView || webBrowserView.webContents.isDestroyed() || !webBrowserVisible) {
    return { ok: false, error: 'Browser unavailable' }
  }
  const bounds = webBrowserLastBounds
  if (!bounds || bounds.width < 8 || bounds.height < 8) {
    return { ok: false, error: 'Browser bounds unknown' }
  }
  const points = Array.isArray(options?.points) && options.points.length > 0
    ? options.points
    : [{ x: 0.5, y: 0.42 }]
  const contents = webBrowserView.webContents
  try {
    contents.focus()
  } catch {
    /* ignore */
  }
  for (const pt of points) {
    const fx = typeof pt.x === 'number' ? pt.x : 0.5
    const fy = typeof pt.y === 'number' ? pt.y : 0.5
    const x = Math.max(1, Math.min(bounds.width - 1, Math.round(bounds.width * fx)))
    const y = Math.max(1, Math.min(bounds.height - 1, Math.round(bounds.height * fy)))
    contents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 })
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  return { ok: true, clicks: points.length }
})

ipcMain.handle('browser:getNav', async () => {
  if (!webBrowserView || webBrowserView.webContents.isDestroyed()) {
    return {
      url: '',
      title: 'Web browser',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      visible: false,
    }
  }
  const contents = webBrowserView.webContents
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: navCanGoBack(contents),
    canGoForward: navCanGoForward(contents),
    loading: contents.isLoading(),
    visible: webBrowserVisible,
  }
})

ipcMain.handle('browser:adDockClose', async () => {
  hideAdDock()
  return true
})

ipcMain.handle('browser:adDockStatus', async () => ({
  visible: adDockVisible,
  url: adDockView && !adDockView.webContents.isDestroyed() ? adDockView.webContents.getURL() : '',
}))

ipcMain.handle('browser:multiShow', async (_event, payload) => {
  const id = payload?.id
  const url = payload?.url
  const bounds = payload?.bounds
  const primary = Boolean(payload?.primary)
  return showMultiWeb(id, url, bounds, { primary, muted: !primary })
})

ipcMain.handle('browser:multiSetBounds', async (_event, payload) => {
  return setMultiWebBounds(payload?.id, payload?.bounds)
})

ipcMain.handle('browser:multiSetAudio', async (_event, payload) => {
  return setMultiWebAudio(payload?.id, Boolean(payload?.muted))
})

ipcMain.handle('browser:multiSpotlight', async (_event, payload) => {
  return setMultiWebSpotlight(payload?.id)
})

ipcMain.handle('browser:multiNudge', async (_event, payload) => {
  const id = String(payload?.id || '')
  if (!id) return false
  scheduleMultiWebAutoplay(id)
  return true
})

ipcMain.handle('browser:multiHide', async (_event, payload) => {
  const id = String(payload?.id || '')
  if (!id) {
    hideAllMultiWeb({ blank: Boolean(payload?.blank) })
    return true
  }
  const view = multiWebViews.get(id)
  if (!view) return true
  try {
    view.setVisible(false)
  } catch {
    /* ignore */
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed() && multiWebAttached.has(id)) {
      mainWindow.contentView.removeChildView(view)
    }
  } catch {
    /* ignore */
  }
  multiWebAttached.delete(id)
  if (payload?.destroy) destroyMultiWebView(id)
  return true
})

ipcMain.handle('browser:multiHideAll', async (_event, options) => {
  hideAllMultiWeb(options || {})
  return true
})

ipcMain.handle('desktop:isDesktop', async () => true)

ipcMain.handle('app:quit', () => {
  app.quit()
})

ipcMain.handle('app:exitFullScreen', async () => {
  exitAppFullscreenSurfaces()
  return true
})

ipcMain.handle('app:setFullScreen', async (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  jiyuWantOsFullScreen = Boolean(enabled)
  try {
    mainWindow.setFullScreen(jiyuWantOsFullScreen)
    return mainWindow.isFullScreen()
  } catch {
    return false
  }
})

ipcMain.handle('app:isFullScreen', async () => {
  try {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen())
  } catch {
    return false
  }
})

ipcMain.handle('app:setMinimizeToPipPolicy', async (_event, policy) => {
  jiyuMinimizeToPipEnabled = policy?.enabled !== false
  jiyuMinimizeToPipArmed = Boolean(policy?.armed)
  return true
})

ipcMain.handle('app:minimizeWindow', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.__jiyuTrueMinimize = true
  try {
    mainWindow.minimize()
    return true
  } catch {
    mainWindow.__jiyuTrueMinimize = false
    return false
  }
})

/**
 * EZTV HTML + Show List need the unlocked Chrome helper. The public JSON API
 * (/api/get-torrents) is open and must use plain fetch — never launch Chrome
 * for API URLs (including challenge/error fallbacks).
 * @param {string} targetUrl
 */
function isEztvApiPath(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    const host = parsed.hostname.replace(/^www\./i, '')
    if (!/(^|\.)eztv[a-z0-9]*\.[a-z.]+$/i.test(host)) return false
    return /\/api\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

function eztvNeedsSystemBrowser(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    const host = parsed.hostname.replace(/^www\./i, '')
    if (!/(^|\.)eztv[a-z0-9]*\.[a-z.]+$/i.test(host)) return false
    if (isEztvApiPath(targetUrl)) return false
    return true
  } catch {
    return false
  }
}

// Show List sync is infrequent — release the Chrome helper when the UI is done.
// Also tear down the blank Electron "Verify" window so Cancel isn't stuck behind it.
ipcMain.handle('cf:closeSystemBrowser', async (_event, options) => {
  destroyUnlockWindow()
  const soon = !options || options.soon !== false
  if (soon) scheduleSystemBrowserCloseSoon(options?.reason || 'requested')
  else closeActiveSystemBrowser()
  return { ok: true }
})

// Fetch an HTML/JSON page as if from a real browser (for torrent-site scraping).
// Plain fetch first; Cloudflare-guarded EZTV HTML uses the Chrome helper.
// opts.quiet: never open a visible Chrome unlock window (Show/Play paths).
ipcMain.handle('page:fetchHtml', async (_event, url, opts = {}) => {
  let quiet = Boolean(opts && opts.quiet)
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, status: 0, content: '', error: 'Invalid page URL' }
    }
    let target = url.trim()
    let host = ''
    try {
      const parsed = new URL(target)
      host = parsed.hostname
      // Apex torlock.com has an invalid cert in Chromium; prefer www.
      if (/^torlock\.com$/i.test(host)) {
        parsed.hostname = 'www.torlock.com'
        target = parsed.toString()
        host = parsed.hostname
      }
      const h = host.replace(/^www\./i, '').toLowerCase()
      // Catalog hosts that must never pop Verify during background sync.
      if (
        h === 'ymovies.vip' ||
        h.endsWith('.ymovies.vip') ||
        h === 'cinetaro.to' ||
        h.endsWith('.cinetaro.to') ||
        h === 'cinextream.cc'
      ) {
        quiet = true
      }
    } catch {
      return { ok: false, status: 0, content: '', error: 'Invalid page URL' }
    }

    // Local remux / WebTorrent URLs are never Cloudflare-guarded — never open Verify.
    if (/^(127\.0\.0\.1|localhost)$/i.test(host)) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        const response = await fetch(target, { signal: controller.signal })
        clearTimeout(timer)
        const content = await response.text()
        return {
          ok: response.ok,
          status: response.status,
          content,
          error: response.ok ? '' : `Server returned ${response.status}`,
        }
      } catch (err) {
        return {
          ok: false,
          status: 0,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    // Show List / NetMirror catalog HTML are CF-bound. EZTV /api stays on plain fetch.
    if (eztvNeedsSystemBrowser(target) || freemoviesNeedsSystemBrowser(target)) {
      return await fetchViaScrapeBrowser(target, { allowVisible: !quiet })
    }

    // YTS catalog: never open the Verify window — quiet fetch + backoff only.
    if (isYtsUrl(target)) {
      return await fetchYtsQuietly(target)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const wantsSubtitle =
      /\.(vtt|srt)(\?|$)/i.test(target) ||
      /\/(?:english|en)(?:\.vtt)?(?:\?|$)/i.test(target) ||
      /caption|subtitle|softsub/i.test(target)
    const optReferer =
      typeof opts?.referer === 'string' && /^https?:\/\//i.test(opts.referer)
        ? opts.referer
        : ''
    let response
    try {
      response = await fetch(target, {
        redirect: 'follow',
        signal: controller.signal,
        headers: withDesktopChromeClientHints({
          'User-Agent': BROWSER_UA,
          Accept: wantsSubtitle
            ? 'text/vtt,text/plain,application/octet-stream,*/*;q=0.8'
            : isEztvApiPath(target)
              ? 'application/json,text/plain,*/*'
              : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(wantsSubtitle
            ? {
                Referer: optReferer || 'https://rivestream.ru/',
                Origin: 'https://rivestream.ru',
              }
            : optReferer
              ? { Referer: optReferer }
              : { 'Upgrade-Insecure-Requests': '1' }),
        }),
      })
    } finally {
      clearTimeout(timer)
    }

    const content = await response.text()
    const challenged = looksLikeCloudflareChallenge(content)
    if (response.ok && !challenged) {
      return { ok: true, status: response.status, content, error: '' }
    }

    // Softsubs: never open the Verify / scrape browser — return the failure as-is.
    if (wantsSubtitle) {
      return {
        ok: false,
        status: response.status,
        content,
        error: challenged
          ? 'Caption fetch blocked'
          : `Server returned ${response.status}`,
      }
    }

    // API-only sync must never open Chrome — return the failure as-is.
    if (isEztvApiPath(target) || isYtsApiPath(target)) {
      return {
        ok: false,
        status: response.status,
        content,
        error: challenged
          ? isYtsApiPath(target)
            ? 'YTS rate-limited (quiet mode)'
            : 'EZTV API looked blocked (unexpected)'
          : `Server returned ${response.status}`,
      }
    }

    if (challenged || !response.ok) {
      return await fetchViaScrapeBrowser(target, { allowVisible: !quiet })
    }

    return {
      ok: false,
      status: response.status,
      content,
      error: `Server returned ${response.status}`,
    }
  } catch (err) {
    const failedUrl = String(url || '').trim()
    const failedIsSub =
      /\.(vtt|srt)(\?|$)/i.test(failedUrl) ||
      /\/(?:english|en)(?:\.vtt)?(?:\?|$)/i.test(failedUrl) ||
      /caption|subtitle|softsub/i.test(failedUrl)
    if (failedIsSub || isEztvApiPath(failedUrl) || isYtsUrl(failedUrl)) {
      if (isYtsUrl(failedUrl)) return await fetchYtsQuietly(failedUrl)
      return {
        ok: false,
        status: 0,
        content: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    try {
      return await fetchViaScrapeBrowser(failedUrl, { allowVisible: !quiet })
    } catch {
      return {
        ok: false,
        status: 0,
        content: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
})

ipcMain.handle('page:fetchJsonPost', async (_event, url, body, referer) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, status: 0, content: '', error: 'Invalid API URL' }
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, status: 0, content: '', error: 'Invalid JSON body' }
    }
    const ref =
      typeof referer === 'string' && referer.trim()
        ? referer.trim()
        : 'https://m2box.org/web/tv-series'
    let origin = 'https://m2box.org'
    try {
      origin = new URL(ref).origin
    } catch {
      /* keep default */
    }
    const isYoutube = /youtube\.com|youtu\.be/i.test(url) || /youtube\.com/i.test(ref)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(url.trim(), {
        method: 'POST',
        redirect: 'follow',
        signal: controller.signal,
        headers: withDesktopChromeClientHints({
          'User-Agent': isYoutube
            ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip'
            : BROWSER_UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: origin,
          Referer: ref,
          ...(isYoutube
            ? {
                'X-Youtube-Client-Name': '3',
                'X-Youtube-Client-Version': '20.10.38',
              }
            : {}),
        }),
        body: JSON.stringify(body),
      })
    } finally {
      clearTimeout(timer)
    }
    const content = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      content,
      error: response.ok ? '' : `Server returned ${response.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

/** Wyzie softsubs — API key stays in main-process .env only (never in Vite/Android bundle). */
ipcMain.handle('wyzie:resolveSubtitle', async (_event, options = {}) => {
  const key = String(process.env.WYZIE_API_KEY || '').trim()
  if (!key) {
    return { ok: false, error: 'WYZIE_API_KEY missing — add it to .env (Electron only)' }
  }
  const tmdbId = String(options?.tmdbId || '').trim()
  if (!tmdbId) return { ok: false, error: 'No TMDB id for Wyzie' }

  const params = new URLSearchParams({
    id: tmdbId,
    key,
    language: String(options?.language || 'en').trim() || 'en',
    format: 'srt,vtt,ass',
    limit: '12',
  })
  const season = Number(options?.season)
  const episode = Number(options?.episode)
  if (Number.isFinite(season) && Number.isFinite(episode) && season >= 1 && episode >= 1) {
    params.set('season', String(Math.floor(season)))
    params.set('episode', String(Math.floor(episode)))
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    let response
    try {
      response = await fetch(`https://sub.wyzie.io/search?${params.toString()}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': BROWSER_UA,
        },
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const err = JSON.parse(text)
        detail = err.message || err.details || detail
      } catch {
        /* keep */
      }
      return { ok: false, error: detail }
    }
    let hits = []
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) hits = parsed
      else if (parsed && Array.isArray(parsed.data)) hits = parsed.data
    } catch {
      return { ok: false, error: 'Invalid Wyzie response' }
    }

    const scoreHit = (hit) => {
      let score = 0
      const lang = `${hit.language || ''} ${hit.display || ''}`.toLowerCase()
      if (/^en\b|english/.test(lang)) score += 20
      if (hit.isHearingImpaired) score -= 8
      const fmt = String(hit.format || '').toLowerCase()
      if (fmt === 'vtt' || fmt === 'srt') score += 6
      if (fmt === 'ass' || fmt === 'ssa') score += 3
      score += Math.min(10, Math.floor((Number(hit.downloadCount) || 0) / 5000))
      return score
    }

    const ranked = hits
      .filter((h) => h && /^https?:\/\//i.test(String(h.url || '')))
      .sort((a, b) => scoreHit(b) - scoreHit(a))
    const best = ranked[0]
    if (!best) return { ok: false, error: 'No Wyzie subtitles for this episode' }

    // Download URLs use encrypted tok — safe to hand to the renderer. Never return the API key.
    // Don't auto-apply fps=25:23.976 — many WEB English packs are already film-timed; stretching
    // them makes cues lag. Player Subs − / + handles small constant offsets.
    let subtitleUrl = String(best.url)
    try {
      const u = new URL(subtitleUrl)
      u.searchParams.set('to', 'vtt')
      u.searchParams.set('plain', '1')
      subtitleUrl = u.toString()
    } catch {
      const sep = subtitleUrl.includes('?') ? '&' : '?'
      subtitleUrl = `${subtitleUrl}${sep}to=vtt&plain=1`
    }

    return {
      ok: true,
      subtitleUrl,
      subtitleKind: 'file',
      source: 'wyzie',
      hit: {
        id: String(best.id || ''),
        format: best.format,
        language: best.language,
        display: best.display,
        fileName: best.fileName,
        release: best.release,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('page:fetchJsonGet', async (_event, url, referer) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return { ok: false, status: 0, content: '', error: 'Invalid API URL' }
    }
    const ref =
      typeof referer === 'string' && referer.trim() ? referer.trim() : 'https://m2box.org/web/tv-series'
    let origin = 'https://m2box.org'
    try {
      origin = new URL(ref).origin
    } catch {
      /* keep default */
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(url.trim(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: withDesktopChromeClientHints({
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
          Origin: origin,
          Referer: ref,
        }),
      })
    } finally {
      clearTimeout(timer)
    }
    const content = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      content,
      error: response.ok ? '' : `Server returned ${response.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

ipcMain.handle('playlist:fetchUrl', async (_event, url) => {
  try {
    if (typeof url !== 'string') {
      return { ok: false, status: 0, content: '', error: 'Invalid playlist URL' }
    }

    let target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      target = `http://${target}`
    }
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, status: 0, content: '', error: 'Only http(s) playlist URLs are supported' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180_000)
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          /youtube\.com|youtu\.be/i.test(target)
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            : `JiyuMedia/${APP_VERSION} (IPTV; M3U)`,
        Accept: /youtube\.com|youtu\.be/i.test(target)
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          : 'application/vnd.apple.mpegurl, audio/x-mpegurl, application/xml, text/xml, text/plain, */*',
      },
    })
    clearTimeout(timer)

    const bytes = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        content: '',
        error: `Server returned ${response.status}`,
      }
    }

    const looksGzip =
      /\.gz(\?|#|$)/i.test(target) ||
      /gzip/i.test(response.headers.get('content-type') || '') ||
      (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)

    let content = ''
    if (looksGzip) {
      try {
        content = (await gunzipAsync(bytes)).toString('utf8')
      } catch (err) {
        return {
          ok: false,
          status: response.status,
          content: '',
          error: `Failed to decompress gzip guide: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    } else {
      content = bytes.toString('utf8')
    }

    return { ok: true, status: response.status, content, error: '' }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      content: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

/** CVM (and similar) Vimeo live events — CDN m3u8 links are tokenized/short-lived. */
const vimeoLiveHlsCache = new Map()

function parseVimeoEventId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  if (/^\d{5,}$/.test(raw)) return raw
  try {
    const u = new URL(raw)
    if (!/vimeo\.com$/i.test(u.hostname) && !/\.vimeo\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/\/event\/(\d+)/i)
    return m?.[1] || null
  } catch {
    return null
  }
}

async function resolveVimeoLiveEventHls(eventId) {
  const id = String(eventId || '').trim()
  if (!/^\d{5,}$/.test(id)) {
    return { ok: false, error: 'Invalid Vimeo event id' }
  }

  const cached = vimeoLiveHlsCache.get(id)
  if (cached && cached.expires > Date.now() && cached.url) {
    return { ok: true, url: cached.url, title: cached.title || '', cached: true }
  }

  const ua = BROWSER_UA
  const viewer = await fetch('https://vimeo.com/_next/viewer', {
    headers: { 'User-Agent': ua, Accept: 'application/json' },
  }).then((r) => r.json())

  if (!viewer?.jwt) {
    return { ok: false, error: 'Could not get Vimeo viewer token' }
  }

  const eventRes = await fetch(`https://api.vimeo.com/live_events/${id}`, {
    headers: {
      'User-Agent': ua,
      Authorization: `jwt ${viewer.jwt}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4.2',
    },
  })
  const event = await eventRes.json().catch(() => null)
  if (!eventRes.ok || !event) {
    return { ok: false, error: event?.error || `Vimeo event HTTP ${eventRes.status}` }
  }

  const clip = event.streamable_clip
  const videoId = String(clip?.uri || '')
    .split('/')
    .filter(Boolean)
    .pop()
  if (!videoId) {
    return { ok: false, error: 'Vimeo event has no live clip right now' }
  }

  let hlsUrl = ''
  try {
    const embedUrl = clip.player_embed_url || ''
    const h = embedUrl ? new URL(embedUrl).searchParams.get('h') : null
    const configUrl = `https://player.vimeo.com/video/${videoId}/config${h ? `?h=${h}` : ''}`
    const configRes = await fetch(configUrl, {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        Referer: 'https://site.cvmtv.com/',
        Origin: 'https://site.cvmtv.com',
      },
    })
    const config = await configRes.json().catch(() => null)
    const hls = config?.request?.files?.hls
    const cdnKey = hls?.default_cdn || Object.keys(hls?.cdns || {})[0]
    hlsUrl = hls?.cdns?.[cdnKey]?.avc_url || hls?.cdns?.[cdnKey]?.url || ''
  } catch {
    /* fall through to play API */
  }

  if (!hlsUrl) {
    const playRes = await fetch(
      `https://api.vimeo.com/videos/${videoId}?fields=play.hls.link,name`,
      {
        headers: {
          'User-Agent': ua,
          Authorization: `jwt ${viewer.jwt}`,
          Accept: 'application/vnd.vimeo.*+json;version=3.4.2',
        },
      },
    )
    const play = await playRes.json().catch(() => null)
    hlsUrl = play?.play?.hls?.link || ''
  }

  if (!hlsUrl || !/^https?:\/\//i.test(hlsUrl)) {
    return { ok: false, error: 'No HLS URL in Vimeo live config' }
  }

  const title = event.stream_title || event.title || clip.name || ''
  // Tokenized CDN links typically last a few hours; refresh early.
  vimeoLiveHlsCache.set(id, {
    url: hlsUrl,
    title,
    expires: Date.now() + 4 * 60 * 1000,
  })
  return { ok: true, url: hlsUrl, title, cached: false }
}

async function probeHttpStream(rawUrl, timeoutMs = 2500) {
  const started = Date.now()
  let target = String(rawUrl || '').trim()
  const vimeoEventId = parseVimeoEventId(target)
  if (vimeoEventId) {
    try {
      const resolved = await resolveVimeoLiveEventHls(vimeoEventId)
      if (!resolved.ok || !resolved.url) {
        return {
          ok: false,
          state: 'offline',
          status: 0,
          latencyMs: Date.now() - started,
          error: resolved.error || 'Vimeo live resolve failed',
        }
      }
      target = resolved.url
    } catch (err) {
      return {
        ok: false,
        state: 'offline',
        status: 0,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  if (!/^https?:\/\//i.test(target)) target = `http://${target}`
  if (!/^https?:\/\//i.test(target)) {
    return {
      ok: false,
      state: 'offline',
      status: 0,
      latencyMs: Date.now() - started,
      error: 'Invalid URL',
    }
  }

  const headers = {
    'User-Agent': STREAM_UA,
    Accept: '*/*',
  }
  try {
    const host = new URL(target).host.toLowerCase()
    const override = playbackHeaderOverrides.get(host)
    if (override?.userAgent) headers['User-Agent'] = override.userAgent
    if (override?.referrer) {
      headers.Referer = override.referrer
      try {
        headers.Origin = new URL(override.referrer).origin
      } catch {
        /* referer only */
      }
    }
  } catch {
    /* ignore bad URL */
  }

  const withTimeout = async (fn) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fn(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  const finish = (ok, state, status, error = '') => ({
    ok,
    state,
    status,
    latencyMs: Date.now() - started,
    error,
  })

  const looksHls =
    /\.m3u8(\?|$)/i.test(target) ||
    /[?&]output=hls\b/i.test(target) ||
    /m3u8-proxy/i.test(target)

  try {
    // Always GET a small slice — HEAD lies too often on IPTV CDNs
    const res = await withTimeout((signal) =>
      fetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          ...headers,
          Range: 'bytes=0-2047',
        },
      }),
    )

    if (!(res.ok || res.status === 206)) {
      return finish(false, 'offline', res.status, `HTTP ${res.status}`)
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    let peek = ''
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const first = await withTimeout(async (signal) => {
        signal.addEventListener('abort', () => {
          try {
            reader.cancel()
          } catch {
            /* ignore */
          }
        })
        return reader.read()
      })
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      if (first?.value) peek = decoder.decode(first.value)
      if (first?.done && !peek) {
        return finish(false, 'offline', res.status, 'Empty response')
      }
    }

    const sample = peek.slice(0, 4000)
    if (/<!doctype html|<html[\s>]|login|cloudflare|access denied|forbidden/i.test(sample)) {
      return finish(false, 'offline', res.status, 'Got HTML/block page instead of media')
    }

    if (looksHls || /mpegurl|apple\.mpegurl|m3u/i.test(contentType)) {
      if (!/#EXTM3U|#EXTINF|#EXT-X-/i.test(sample)) {
        return finish(false, 'offline', res.status, 'Not a valid HLS playlist')
      }
      return finish(true, 'online', res.status)
    }

    // MPEG-TS / progressive: sync byte 0x47 or non-empty binary/octet stream
    if (sample.charCodeAt(0) === 0x47 || /octet-stream|video\/|mp2t|mpeg/i.test(contentType)) {
      return finish(true, 'online', res.status)
    }

    if (sample.length > 0) return finish(true, 'online', res.status)
    return finish(false, 'offline', res.status, 'Empty body')
  } catch (err) {
    if (err?.name === 'AbortError') {
      return finish(false, 'timeout', 0, 'Timed out')
    }
    return finish(false, 'offline', 0, err instanceof Error ? err.message : String(err))
  }
}

ipcMain.handle('stream:probe', async (_event, url, timeoutMs) => {
  return probeHttpStream(url, typeof timeoutMs === 'number' ? timeoutMs : 2500)
})

/** Apply M3U http-user-agent / http-referrer for the next HLS requests to this host. */
ipcMain.handle('stream:setPlaybackHeaders', async (_event, options) => {
  const url = typeof options?.url === 'string' ? options.url.trim() : ''
  if (!url) return { ok: false }
  try {
    const host = new URL(url).host.toLowerCase()
    const userAgent =
      typeof options?.userAgent === 'string' && options.userAgent.trim()
        ? options.userAgent.trim()
        : ''
    const referrer =
      typeof options?.referrer === 'string' && options.referrer.trim()
        ? options.referrer.trim()
        : ''
    if (!userAgent && !referrer) {
      playbackHeaderOverrides.delete(host)
      activePlaybackReferrer = ''
      return { ok: true, cleared: true }
    }
    playbackHeaderOverrides.set(host, { userAgent, referrer })
    activePlaybackReferrer = referrer
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('vimeo:resolveLiveHls', async (_event, input) => {
  try {
    const eventId = parseVimeoEventId(input) || String(input || '').trim()
    return await resolveVimeoLiveEventHls(eventId)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('stream:probeMany', async (_event, entries, timeoutMs) => {
  const list = Array.isArray(entries) ? entries : []
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 2500
  const concurrency = performanceKnobs.streamProbeConcurrency || 20
  const results = new Array(list.length)
  let index = 0

  async function worker() {
    while (index < list.length) {
      const current = index++
      const entry = list[current]
      const url = entry?.url
      const id = entry?.id
      const probe = await probeHttpStream(url, timeout)
      results[current] = { id, ...probe }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(list.length, 1)) }, () => worker()),
  )
  return results
})

// ---------------------------------------------------------------------------
// Torrent streaming (webtorrent) — serves magnet/.torrent links as local HTTP video
// ---------------------------------------------------------------------------

let torrentClientPromise = null
let torrentServerPort = 0

async function getTorrentClient() {
  if (!torrentClientPromise) {
    torrentClientPromise = (async () => {
      // webtorrent v2 is ESM-only; main process is CJS
      const { default: WebTorrent } = await import('webtorrent')
      // uTP often stalls the peer listener in Electron on Windows, so discovery
      // never starts and magnets time out waiting for metadata.
      const client = new WebTorrent({
        utp: false,
        maxConns: performanceKnobs.torrentMaxConns || 64,
      })
      console.log('[torrent] download root', torrentDownloadRoot())
      client.on('error', (err) => {
        console.error('[torrent] client error:', err?.message || err)
      })
      await new Promise((resolve, reject) => {
        if (client.listening) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          reject(new Error('Torrent engine failed to open a peer port'))
        }, 15000)
        client.once('listening', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      const server = client.createServer()
      const httpServer = server.server ?? server
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', () => resolve())
      })
      torrentServerPort = httpServer.address().port
      return client
    })().catch((err) => {
      torrentClientPromise = null
      throw err
    })
  }
  return torrentClientPromise
}

const VIDEO_FILE_RE = /\.(mp4|mkv|webm|m4v|mov|avi|ts|mpg|mpeg)$/i
const METADATA_TIMEOUT_MS = 45000
const METADATA_PEER_GRACE_MS = 15000
/** First wait for peers/bytes after metadata (DHT can be slow). */
const PEER_PROBE_MS = 12_000
/** Shorter probe when re-adding a magnet after a dead cached .torrent. */
const PEER_PROBE_RETRY_MS = 8_000
const MAGNET_METADATA_MS = 10_000
const MAGNET_RETRY_READY_MS = 12_000
const OPENING_BYTES_WAIT_MS = 35_000
const NO_PEERS_ERROR =
  'No peers found for this release — try another episode or quality.'
const DEFAULT_TORRENT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://9.rarbg.to:2710/announce',
  'https://tracker.tamersunion.org:443/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
]

function extractTrackersFromMagnet(magnet) {
  const trackers = []
  try {
    const q = String(magnet || '').split('?')[1] || ''
    for (const part of q.split('&')) {
      const [key, ...rest] = part.split('=')
      if (key !== 'tr' || !rest.length) continue
      try {
        const tr = decodeURIComponent(rest.join('='))
        if (tr) trackers.push(tr)
      } catch {
        /* ignore bad encoding */
      }
    }
  } catch {
    /* ignore */
  }
  return trackers
}

function magnetWithDefaultTrackers(magnet) {
  let out = magnet.trim()
  for (const tracker of DEFAULT_TORRENT_TRACKERS) {
    const encoded = encodeURIComponent(tracker)
    if (out.includes(encoded) || out.includes(tracker)) continue
    out += `${out.includes('?') ? '&' : '?'}tr=${encoded}`
  }
  return out
}

function announceListForTorrent(magnetUri) {
  const merged = [
    ...extractTrackersFromMagnet(magnetUri),
    ...DEFAULT_TORRENT_TRACKERS,
  ]
  return [...new Set(merged.filter(Boolean))]
}

/** Wait briefly for opening pieces so remux/ffmpeg can probe without hanging. */
function waitForFileBytes(file, minBytes, timeoutMs) {
  const downloaded = () => Number(file?.downloaded) || 0
  if (downloaded() >= minBytes) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (downloaded() >= minBytes) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 200)
  })
}

const TORRENT_PARTIAL_TTL_MS = 3 * 60 * 60 * 1000

function torrentDownloadComplete(torrent) {
  if (!torrent) return false
  const length = Number(torrent.length) || 0
  const downloaded = Number(torrent.downloaded) || 0
  if (length > 0 && downloaded >= length) return true
  return typeof torrent.progress === 'number' && torrent.progress >= 0.999
}

function torrentStoreDir(torrent) {
  const root = torrent?.path
  const name = torrent?.name
  if (!root || !name) return null
  const parent = path.resolve(root)
  const dir = path.resolve(root, name)
  if (dir !== parent && !dir.startsWith(parent + path.sep)) return null
  return dir
}

function partialLedgerPath() {
  return path.join(app.getPath('userData'), 'torrent-partials.json')
}

function readPartialLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(partialLedgerPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePartialLedger(rows) {
  try {
    fs.writeFileSync(partialLedgerPath(), JSON.stringify(rows))
  } catch (err) {
    console.warn('[torrent] partial ledger write failed', err?.message || err)
  }
}

function forgetPartialTorrent(infoHash) {
  if (!infoHash) return
  const key = String(infoHash).toLowerCase()
  const rows = readPartialLedger().filter((row) => String(row?.infoHash || '').toLowerCase() !== key)
  writePartialLedger(rows)
}

function rememberPartialTorrent(torrent) {
  const storePath = torrentStoreDir(torrent)
  const infoHash = torrent?.infoHash
  if (!storePath || !infoHash) return
  const key = String(infoHash).toLowerCase()
  const rows = readPartialLedger().filter(
    (row) => String(row?.infoHash || '').toLowerCase() !== key && row?.path !== storePath,
  )
  rows.push({
    infoHash: key,
    path: storePath,
    expiresAt: Date.now() + TORRENT_PARTIAL_TTL_MS,
  })
  writePartialLedger(rows)
}

function sweepPartialTorrents() {
  const now = Date.now()
  const kept = []
  for (const row of readPartialLedger()) {
    if (!row?.path) continue
    if (Number(row.expiresAt) > now) {
      kept.push(row)
      continue
    }
    try {
      fs.rmSync(row.path, { recursive: true, force: true })
      console.log('[torrent] removed unfinished download', row.infoHash)
    } catch (err) {
      console.warn('[torrent] partial cleanup failed', row.path, err?.message || err)
      kept.push(row)
    }
  }
  writePartialLedger(kept)
}

/** Finished downloads are deleted now. Unfinished ones are removed after 3 hours. */
function releaseTorrent(torrent, callback) {
  const done = typeof callback === 'function' ? callback : () => {}
  if (!torrent) {
    done()
    return
  }
  const downloaded = Number(torrent.downloaded) || 0
  const destroyStore = torrentDownloadComplete(torrent) || downloaded <= 0
  if (!destroyStore) rememberPartialTorrent(torrent)
  else forgetPartialTorrent(torrent.infoHash)
  try {
    torrent.destroy({ destroyStore }, () => done())
  } catch (err) {
    console.warn('[torrent] release failed', err?.message || err)
    done()
  }
}

function waitForTorrentReady(torrent, timeoutMs = METADATA_TIMEOUT_MS) {
  if (torrent.ready && torrent.files?.length) return Promise.resolve(torrent)

  return new Promise((resolve, reject) => {
    let settled = false
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (settled) return
      if (torrent.ready && torrent.files?.length) {
        finish(null, torrent)
        return
      }
      // Keep waiting a bit longer once peers show up — metadata often arrives next.
      if (torrent.numPeers > 0 && Date.now() < deadline + METADATA_PEER_GRACE_MS) return
      if (Date.now() < deadline) return
      finish(
        new Error(
          'Could not start this episode — the release may be unavailable. Try another episode or quality.',
        ),
      )
    }, 1000)

    function onReady() {
      finish(null, torrent)
    }
    function onError(err) {
      finish(err instanceof Error ? err : new Error(String(err || 'Torrent error')))
    }
    function finish(err, value) {
      if (settled) return
      settled = true
      clearInterval(timer)
      torrent.off('ready', onReady)
      torrent.off('error', onError)
      if (err) {
        releaseTorrent(torrent)
        reject(err)
        return
      }
      resolve(value)
    }

    torrent.once('ready', onReady)
    torrent.once('error', onError)
  })
}
// Every common container except webm: torrent releases (including MP4 WEB-DLs)
// routinely carry AC3/EAC3/DTS audio that Chromium cannot decode, which plays
// video with no sound. Video is copied when Chromium-safe; only audio is
// re-encoded to AAC. HEVC/x265 must be re-encoded — Electron can't paint it.
const AUDIO_TRANSCODE_RE = /\.(mp4|m4v|mov|mkv|avi|ts|mts|m2ts|mpg|mpeg)$/i
const HEVC_VIDEO_RE = /\b(x265|h\.?265|hevc)\b/i
const SUBTITLE_FILE_RE = /\.(srt|ass|ssa|vtt)$/i
const EMBEDDED_SUBS_RE = /\.(mkv|mp4|m4v|mov)$/i

let transcodeServerPromise = null
let transcodeServerPort = 0
/** @type {Map<string, Buffer>} */
const subtitleCache = new Map()
/** @type {Map<string, Array<{ start: number, end: number, text: string }>>} */
const subtitleCueLists = new Map()
/** @type {Map<string, { done: boolean, error: string | null, cueCount: number, retryable?: boolean }>} */
const subtitleJobs = new Map()
/** @type {Map<string, any>} */
const subtitleSources = new Map()
/** @type {Map<string, { kill: () => void }>} */
const subtitleExtractors = new Map()
/** @type {Map<string, 'file' | 'embedded'>} */
const subtitleKinds = new Map()
/** @type {Map<string, string>} HTTP webtorrent URL for embedded softsub ffmpeg -i */
const subtitleHttpSources = new Map()
/** @type {Map<string, number>} infoHash:fileIndex → probed runtime seconds */
const torrentFileRuntimeSeconds = new Map()
/** @type {Map<string, Promise<boolean>>} de-dupe concurrent mid-title seek waits */
const remuxSeekWaitPromises = new Map()

function localTorrentSourceOk(source) {
  return /^http:\/\/127\.0\.0\.1:\d+\//.test(source)
}

function srtToVtt(srt) {
  const body = String(srt || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
  return `WEBVTT\n\n${body}\n`
}

function resolveFfmpegPath() {
  try {
    return require('ffmpeg-static')
  } catch {
    return null
  }
}

/** Parse `Duration: HH:MM:SS.mm` from ffmpeg -i stderr. */
function parseFfmpegDurationSeconds(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(String(stderr || ''))
  if (!m) return 0
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(total) && total >= 30 ? Math.round(total) : 0
}

/**
 * Probe real media length via ffmpeg -i (no full decode). Uses the local
 * torrent HTTP URL once opening bytes exist — not a full download.
 */
function probeMediaDurationSeconds(sourceUrl, timeoutMs = 22000) {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath || !sourceUrl) {
      resolve(0)
      return
    }
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-probesize', '2M', '-analyzeduration', '2000000', '-i', sourceUrl],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let err = ''
    const finish = () => {
      try {
        if (!proc.killed) proc.kill()
      } catch {
        /* ignore */
      }
      resolve(parseFfmpegDurationSeconds(err))
    }
    const timer = setTimeout(finish, timeoutMs)
    proc.stderr.on('data', (chunk) => {
      err += String(chunk)
      if (/Duration:\s*\d+:\d+:\d+/i.test(err)) {
        clearTimeout(timer)
        finish()
      }
    })
    proc.once('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    proc.once('close', () => {
      clearTimeout(timer)
      resolve(parseFfmpegDurationSeconds(err))
    })
  })
}

const TEXT_SUBTITLE_CODECS = new Set([
  'ass',
  'ssa',
  'subrip',
  'srt',
  'webvtt',
  'mov_text',
  'text',
  'subtitle',
])

function isTextSubtitleCodec(codec) {
  const c = String(codec || '').toLowerCase()
  if (!c) return false
  if (TEXT_SUBTITLE_CODECS.has(c)) return true
  // Some builds report "ass (ssa)" style tokens after normalization.
  return /^(ass|ssa|subrip|srt|webvtt|mov_text)/.test(c)
}

function isImageSubtitleCodec(codec) {
  const c = String(codec || '').toLowerCase()
  return /pgs|hdmv|dvd_sub|dvdsub|dvb_sub|xsub|vobsub/.test(c)
}

/**
 * FFmpeg 6+ often prints `Stream #0:3[0x0](eng): Subtitle: ass`.
 * Older builds omit the `[…]` id — accept both.
 */
const FFMPEG_STREAM_LINE_RE =
  /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?:\s*(Audio|Subtitle|Video|Attachment):\s*([^\s,(]+)/i

/** Parse `ffmpeg -i` stderr into subtitle stream descriptors. */
function parseFfmpegSubtitleStreams(stderr) {
  const tracks = []
  const lines = String(stderr || '').split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const stream = FFMPEG_STREAM_LINE_RE.exec(line)
    if (stream && /^Subtitle$/i.test(stream[3])) {
      if (current) tracks.push(current)
      current = {
        index: Number(stream[1]),
        language: (stream[2] || '').trim().toLowerCase(),
        codec: stream[4].trim().toLowerCase(),
        title: '',
        isDefault: /\(default\)/i.test(line),
        isForced: /\(forced\)/i.test(line),
        isHearingImpaired: /\(hearing\s*impaired\)/i.test(line),
      }
      continue
    }
    if (stream) {
      // Hit a non-subtitle stream — close the previous subtitle descriptor.
      if (current) {
        tracks.push(current)
        current = null
      }
      continue
    }
    if (current) {
      const title = /^\s*title\s*:\s*(.+)\s*$/i.exec(line)
      if (title) current.title = title[1].trim()
    }
  }
  if (current) tracks.push(current)
  return tracks
}

/** Parse `ffmpeg -i` stderr into audio stream descriptors (absolute stream index). */
function parseFfmpegAudioStreams(stderr) {
  const tracks = []
  const lines = String(stderr || '').split(/\r?\n/)
  let current = null
  let audioOrdinal = -1
  for (const line of lines) {
    const stream = FFMPEG_STREAM_LINE_RE.exec(line)
    if (stream && /^Audio$/i.test(stream[3])) {
      if (current) tracks.push(current)
      audioOrdinal += 1
      current = {
        index: Number(stream[1]),
        audioOrdinal,
        language: (stream[2] || '').trim().toLowerCase(),
        codec: stream[4].trim().toLowerCase(),
        title: '',
        isDefault: /\(default\)/i.test(line),
      }
      continue
    }
    if (stream) {
      if (current) {
        tracks.push(current)
        current = null
      }
      continue
    }
    if (current) {
      const title = /^\s*title\s*:\s*(.+)\s*$/i.exec(line)
      if (title) current.title = title[1].trim()
    }
  }
  if (current) tracks.push(current)
  return tracks
}

function scoreAudioTrack(track) {
  if (!track) return -Infinity
  let score = 0
  const lang = track.language || ''
  const title = (track.title || '').toLowerCase()

  if (/^(eng?|en)$/i.test(lang) || lang.startsWith('en')) score += 80
  else if (!lang || lang === 'und' || lang === 'unknown') score += 15
  else if (/^(fre?|fr|fra)$/i.test(lang) || lang.startsWith('fr')) score -= 60
  else if (/^(spa|es|ger|de|deu|ita|jpn|ja|rus|hin)/i.test(lang)) score -= 40

  if (/\b(english|eng|original)\b/i.test(title)) score += 40
  if (/\b(french|fran[cç]ais|vff|vfq|truefrench|deutsch|german|latino)\b/i.test(title))
    score -= 50
  if (/\b(commentary|descriptive|ad\b|director)\b/i.test(title)) score -= 70
  if (track.isDefault) score += 5
  // Prefer earlier tracks when language is equal (usually main mix).
  score -= track.audioOrdinal * 0.1

  return score
}

function pickBestAudioTrack(tracks) {
  const ranked = [...(tracks || [])]
    .map((track) => ({ track, score: scoreAudioTrack(track) }))
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.track || null
}

/**
 * Prefer English audio on MULTI packs (track 0 is often French).
 * Returns the audio stream ordinal for `-map 0:a:N` (not absolute stream index).
 */
function probePreferredAudioOrdinal(httpSource) {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath || !httpSource) {
      resolve(0)
      return
    }
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-probesize',
        '4M',
        '-analyzeduration',
        '3000000',
        '-i',
        httpSource,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill()
      } catch {
        /* ignore */
      }
    }, 12000)
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.once('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    proc.once('close', () => {
      clearTimeout(timer)
      const tracks = parseFfmpegAudioStreams(stderr)
      const best = pickBestAudioTrack(tracks)
      if (best && tracks.length > 1) {
        console.log('[torrent audio] preferred track', {
          ordinal: best.audioOrdinal,
          language: best.language || 'und',
          title: best.title || '',
          total: tracks.length,
        })
      }
      resolve(best && Number.isFinite(best.audioOrdinal) ? best.audioOrdinal : 0)
    })
  })
}

function scoreSubtitleTrack(track) {
  if (!track) return -Infinity
  let score = 0
  const lang = track.language || ''
  const title = (track.title || '').toLowerCase()
  const codec = track.codec || ''

  if (isTextSubtitleCodec(codec)) score += 100
  else if (isImageSubtitleCodec(codec)) score -= 200
  else score += 10

  if (/^(eng?|en)$/i.test(lang) || lang.startsWith('en')) score += 50
  else if (!lang || lang === 'und' || lang === 'unknown') score += 5
  else if (/^(jpn?|ja|chi|zho|kor|ko|spa|es|fre|fr)/i.test(lang)) score -= 15

  if (/\b(full|dialogue|dialog|english)\b/i.test(title)) score += 25
  if (/\b(signs?|songs?|forced|commentary)\b/i.test(title)) score -= 40
  if (/\b(sdh|hearing\s*impaired|cc)\b/i.test(title)) score -= 20
  if (track.isHearingImpaired) score -= 20
  if (track.isForced) score -= 35
  if (track.isDefault) score += 8

  return score
}

function pickBestTextSubtitleTrack(tracks) {
  const ranked = [...(tracks || [])]
    .map((track) => ({ track, score: scoreSubtitleTrack(track) }))
    .filter((entry) => entry.score > 0 && isTextSubtitleCodec(entry.track.codec))
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.track || null
}

/**
 * Absolute on-disk path for a WebTorrent file when pieces have been written.
 * Prefer this for softsub probe/extract — HTTP /torrent-file often misses MKV
 * subtitle tracks even when the same file on disk lists them clearly.
 */
function resolveTorrentFileDiskPath(file) {
  if (!file) return null
  try {
    const rel = String(file.path || '')
    const name = String(file.name || '')
    const torrent = file._torrent || file.torrent || null
    const roots = []
    if (torrent?.path) roots.push(torrent.path)
    roots.push(torrentDownloadRoot())
    const candidates = []
    if (rel && path.isAbsolute(rel)) candidates.push(rel)
    for (const root of roots) {
      if (!root) continue
      if (rel) candidates.push(path.join(root, rel))
      if (name) candidates.push(path.join(root, name))
      if (torrent?.name && name) candidates.push(path.join(root, torrent.name, name))
    }
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * @param {'probe' | 'extract'} mode
 * Probe can use a partial on-disk file (MKV headers live near the start).
 * Extract must NOT — sparse torrent files make ffmpeg die mid-track on holes,
 * freezing subs halfway. Use HTTP until the file is mostly complete.
 */
function ffmpegInputForSubtitles(file, httpSource, mode = 'extract') {
  try {
    const local = resolveTorrentFileDiskPath(file)
    if (local) {
      const size = fs.statSync(local).size
      if (size < 2 * 1024 * 1024) return httpSource
      if (mode === 'probe') return local
      if (mode === 'extract' && torrentFileMostlyComplete(file)) return local
    }
  } catch {
    /* fall through */
  }
  return httpSource
}

/**
 * Probe subtitle streams via ffmpeg -i (local path preferred over HTTP).
 * @returns {Promise<Array<{ index: number, language: string, codec: string, title: string, isDefault: boolean }>>}
 */
function probeSubtitleTracks(inputSource) {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath || !inputSource) {
      resolve([])
      return
    }
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-probesize',
        '32M',
        '-analyzeduration',
        '20000000',
        '-i',
        inputSource,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill()
      } catch {
        /* ignore */
      }
    }, 45000)
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.once('error', () => {
      clearTimeout(timer)
      resolve([])
    })
    proc.once('close', () => {
      clearTimeout(timer)
      const tracks = parseFfmpegSubtitleStreams(stderr)
      if (tracks.length === 0) {
        if (/Subtitle:/i.test(stderr)) {
          const hint = stderr
            .split(/\r?\n/)
            .filter((line) => /Subtitle:/i.test(line))
            .slice(0, 4)
          console.warn('[torrent subs] subtitle lines not parsed', hint)
        } else {
          const hint = stderr
            .split(/\r?\n/)
            .filter((line) => /Stream #|error|Invalid|404|Connection/i.test(line))
            .slice(0, 8)
          console.warn('[torrent subs] empty probe stderr', {
            input: String(inputSource).slice(0, 160),
            hint,
          })
        }
      }
      resolve(tracks)
    })
  })
}

function assTimeToSeconds(value) {
  const match = String(value)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,2})$/)
  if (!match) return NaN
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = Number(match[4]) / (match[4].length === 1 ? 10 : 100)
  return hours * 3600 + minutes * 60 + seconds + fraction
}

function formatVttTimestamp(totalSeconds) {
  const msTotal = Math.max(0, Math.round(totalSeconds * 1000))
  const hours = Math.floor(msTotal / 3_600_000)
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000)
  const seconds = Math.floor((msTotal % 60_000) / 1000)
  const ms = msTotal % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function parseAssDialogueLine(line) {
  if (!/^Dialogue:/i.test(line)) return null
  const rest = line.replace(/^Dialogue:\s*/i, '')
  const parts = rest.split(',')
  if (parts.length < 10) return null
  const start = assTimeToSeconds(parts[1])
  const end = assTimeToSeconds(parts[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const text = parts
    .slice(9)
    .join(',')
    .replace(/\\[nN]/g, '\n')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+$/g, '')
    .trim()
  if (!text) return null
  return { start, end, text }
}

function cuesToVttBuffer(cues) {
  let out = 'WEBVTT\n\n'
  for (const cue of cues) {
    out += `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}\n\n`
  }
  return Buffer.from(out, 'utf8')
}

function sourceLooksLikeSubtitleFile(source) {
  try {
    return SUBTITLE_FILE_RE.test(decodeURIComponent(new URL(source).pathname))
  } catch {
    return SUBTITLE_FILE_RE.test(source)
  }
}

async function extractWebVttFromSource(source) {
  const isSubFile = sourceLooksLikeSubtitleFile(source)
  if (!isSubFile) throw new Error('Embedded HTTP extract disabled — use progressive torrent extract')

  const response = await fetch(source)
  if (!response.ok) throw new Error(`Subtitle download failed (HTTP ${response.status})`)
  const raw = await response.text()
  if (/\.srt$/i.test(source)) return Buffer.from(srtToVtt(raw), 'utf8')
  if (/\.vtt$/i.test(source)) return Buffer.from(raw, 'utf8')

  const { Readable } = require('stream')
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) throw new Error('FFmpeg is unavailable')
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'ass', 'pipe:1'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const cues = []
    let buf = ''
    Readable.from([Buffer.from(raw)]).pipe(ffmpeg.stdin)
    ffmpeg.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) {
        const cue = parseAssDialogueLine(line)
        if (cue) cues.push(cue)
      }
    })
    ffmpeg.once('error', reject)
    ffmpeg.once('close', () => {
      if (!cues.length) reject(new Error('No subtitle cues'))
      else resolve(cuesToVttBuffer(cues))
    })
  })
}

function cachedSubtitleUrl(cacheKey) {
  return `http://127.0.0.1:${transcodeServerPort}/subs-cache/${encodeURIComponent(cacheKey)}.vtt`
}

function dedupeSubtitleCues(cues) {
  const seen = new Set()
  const out = []
  for (const cue of cues) {
    const key = `${cue.start}\0${cue.end}\0${cue.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cue)
  }
  return out
}

function publishSubtitleCues(cacheKey, cues, job) {
  const unique = dedupeSubtitleCues(cues)
  if (!unique.length) return
  // Keep caller arrays compact when they share the same reference.
  cues.length = 0
  cues.push(...unique)
  subtitleCueLists.set(cacheKey, unique.slice())
  subtitleCache.set(cacheKey, cuesToVttBuffer(unique))
  if (job) job.cueCount = unique.length
}

function torrentFileMostlyComplete(file) {
  if (!file) return false
  if (file.done) return true
  const progress = Number(file.progress) || 0
  if (progress >= 0.97) return true
  const length = Number(file.length) || 0
  const downloaded = Number(file.downloaded) || 0
  return length > 0 && downloaded >= length * 0.97
}

function abortSubtitleExtractors(exceptKey = null) {
  for (const [key, handle] of subtitleExtractors) {
    if (exceptKey && key === exceptKey) continue
    try {
      handle.kill()
    } catch {
      /* ignore */
    }
    subtitleExtractors.delete(key)
    const job = subtitleJobs.get(key)
    // Keep successful caches; never finalize incomplete progressive jobs here —
    // that made the player stop polling while cues were still only halfway in.
    if (!job) continue
    if (!subtitleCache.has(key)) {
      subtitleJobs.delete(key)
    } else {
      job.done = false
      job.retryable = true
    }
  }
}

/** Don't steal torrent pieces from remux until the opening is buffered. */
const SUBTITLE_EXTRACT_MIN_BYTES = 12 * 1024 * 1024
const subtitleExtractDeferred = new Map()

/** Companion .srt/.ass files are tiny — never gate them on the 12MB video buffer. */
function subtitleSourceReadyForExtract(file) {
  if (!file) return false
  if (SUBTITLE_FILE_RE.test(file.name || '')) return true
  const downloaded = Number(file.downloaded) || 0
  const progress = Number(file.progress) || 0
  return downloaded >= SUBTITLE_EXTRACT_MIN_BYTES || progress >= 0.12
}

function scheduleSubtitleExtractWhenReady(file, cacheKey) {
  if (!file || !cacheKey) return
  subtitleSources.set(cacheKey, file)
  if (subtitleExtractDeferred.has(cacheKey)) return
  const sidecar = SUBTITLE_FILE_RE.test(file.name || '')
  console.log('[torrent subs] defer extract (need buffer first)', {
    file: file.name,
    downloaded: Number(file.downloaded) || 0,
    need: SUBTITLE_EXTRACT_MIN_BYTES,
  })
  const timer = setTimeout(() => {
    subtitleExtractDeferred.delete(cacheKey)
    const source = subtitleSources.get(cacheKey) || file
    startProgressiveSubtitleExtract(source, cacheKey)
  }, sidecar ? 1_500 : 8_000)
  subtitleExtractDeferred.set(cacheKey, timer)
}

function startProgressiveSubtitleExtract(file, cacheKey) {
  if (!file) return
  subtitleSources.set(cacheKey, file)

  const downloaded = Number(file.downloaded) || 0
  const sidecar = SUBTITLE_FILE_RE.test(file.name || '')
  // Sidecar subs: select + read immediately (a 100KB .srt never hits 12MB).
  // Embedded: wait for opening buffer so extract can't starve remux.
  if (!sidecar && !subtitleSourceReadyForExtract(file)) {
    scheduleSubtitleExtractWhenReady(file, cacheKey)
    return
  }
  if (sidecar) {
    try {
      file.select()
    } catch {
      /* ignore */
    }
  }

  const existing = subtitleJobs.get(cacheKey)
  if (existing && !existing.done && subtitleExtractors.has(cacheKey)) return
  if (existing?.done && !existing.retryable && existing.error && !subtitleCache.has(cacheKey)) {
    // A/V-only files used to re-probe forever via retryFalseNegative once 12MB was on disk.
    if (existing.confirmedMissing || /no subtitle track/i.test(String(existing.error || ''))) {
      return
    }
    if (downloaded < 8 * 1024 * 1024) {
      subtitleJobs.delete(cacheKey)
    } else {
      return
    }
  }
  if (
    existing?.done &&
    !existing.retryable &&
    subtitleCache.has(cacheKey) &&
    torrentFileMostlyComplete(file)
  ) {
    return
  }

  const deferred = subtitleExtractDeferred.get(cacheKey)
  if (deferred) {
    clearTimeout(deferred)
    subtitleExtractDeferred.delete(cacheKey)
  }

  // Focus bandwidth on the episode currently being watched.
  abortSubtitleExtractors(cacheKey)

  const job = { done: false, error: null, cueCount: 0, retryable: false }
  subtitleJobs.set(cacheKey, job)

  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) {
    job.done = true
    job.error = 'FFmpeg is unavailable'
    return
  }

  try {
    file.select()
  } catch {
    /* ignore */
  }

  console.log('[torrent subs] extract start', {
    file: file.name,
    kind: SUBTITLE_FILE_RE.test(file.name) ? 'file' : 'embedded',
    downloaded: Number(file.downloaded) || 0,
  })

  // Small external subtitle files — read fully, convert, publish.
  if (SUBTITLE_FILE_RE.test(file.name)) {
    const chunks = []
    const stream = file.createReadStream()
    const kill = () => {
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
    }
    subtitleExtractors.set(cacheKey, { kill })
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', (err) => {
      subtitleExtractors.delete(cacheKey)
      job.done = true
      job.retryable = true
      job.error = err?.message || 'Subtitle read failed'
    })
    stream.on('end', () => {
      subtitleExtractors.delete(cacheKey)
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (/\.srt$/i.test(file.name)) {
          const body = Buffer.from(srtToVtt(raw), 'utf8')
          subtitleCache.set(cacheKey, body)
          job.cueCount = (body.toString('utf8').match(/-->/g) || []).length
          job.done = true
          return
        }
        if (/\.vtt$/i.test(file.name)) {
          subtitleCache.set(cacheKey, Buffer.from(raw, 'utf8'))
          job.cueCount = (raw.match(/-->/g) || []).length
          job.done = true
          return
        }
        const cues = []
        for (const line of raw.split(/\r?\n/)) {
          const cue = parseAssDialogueLine(line)
          if (cue) cues.push(cue)
        }
        if (!cues.length) throw new Error('No subtitle cues in companion file')
        publishSubtitleCues(cacheKey, cues, job)
        job.done = true
      } catch (err) {
        job.done = true
        job.error = err?.message || 'Subtitle convert failed'
        console.warn('[torrent subs]', job.error)
      }
    })
    return
  }

  // Embedded softsubs: probe this file's tracks, then extract the best text option.
  const httpSource = subtitleHttpSources.get(cacheKey) || ''
  const cues = [...(subtitleCueLists.get(cacheKey) || [])]
  let activeFfmpeg = null
  let selectedTrack = null

  const killActive = () => {
    try {
      if (activeFfmpeg && !activeFfmpeg.killed) activeFfmpeg.kill()
    } catch {
      /* ignore */
    }
    activeFfmpeg = null
  }
  subtitleExtractors.set(cacheKey, { kill: killActive })

  const markRetryable = (message) => {
    killActive()
    subtitleExtractors.delete(cacheKey)
    job.done = true
    job.retryable = true
    job.error = message
    console.warn('[torrent subs] retryable:', message)
    setTimeout(() => {
      if (!subtitleCache.has(cacheKey) && subtitleJobs.get(cacheKey)?.retryable) {
        subtitleJobs.delete(cacheKey)
      }
    }, 2000)
  }

  const finishMissing = (message) => {
    killActive()
    subtitleExtractors.delete(cacheKey)
    job.done = true
    job.retryable = false
    job.confirmedMissing = true
    job.error = message
    console.warn('[torrent subs]', message, { file: file.name })
  }

  const extractTrack = (track, options = {}) => {
    const inputSource = ffmpegInputForSubtitles(file, httpSource, 'extract')
    if (!inputSource || !track) {
      markRetryable('Subtitle source URL missing')
      return
    }
    selectedTrack = track
    killActive()
    const startAt = Math.max(0, Number(options.startAt) || 0)
    const beforeCount = cues.length
    console.log('[torrent subs] extracting track', {
      index: track.index,
      language: track.language || 'und',
      codec: track.codec,
      title: track.title || '',
      score: scoreSubtitleTrack(track),
      via: path.isAbsolute(String(inputSource)) ? 'disk' : 'http',
      startAt: startAt > 0 ? Math.round(startAt) : 0,
      haveCues: beforeCount,
    })

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-probesize',
      '32M',
      '-analyzeduration',
      '20000000',
    ]
    // Skip cues we already have — critical when resuming after a sparse-file stall.
    if (startAt >= 1) {
      args.push('-ss', startAt.toFixed(3))
    }
    args.push(
      '-i',
      inputSource,
      '-map',
      `0:${track.index}`,
      '-c:s',
      'ass',
      '-flush_packets',
      '1',
      '-f',
      'ass',
      'pipe:1',
    )

    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    activeFfmpeg = ffmpeg
    let buf = ''
    let sawCue = false
    let lastLoggedCount = beforeCount

    ffmpeg.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      let grew = false
      for (const line of lines) {
        const cue = parseAssDialogueLine(line)
        if (!cue) continue
        // Ignore overlap from -ss restarts.
        if (startAt > 0 && cue.end <= startAt + 0.05) continue
        cues.push(cue)
        sawCue = true
        grew = true
      }
      if (grew) {
        publishSubtitleCues(cacheKey, cues, job)
        if (job.cueCount > lastLoggedCount) {
          lastLoggedCount = job.cueCount
          console.log('[torrent subs] cues', job.cueCount)
        }
      }
    })

    ffmpeg.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) console.warn('[torrent subs]', message)
    })

    ffmpeg.once('error', (err) => {
      console.warn('[torrent subs] ffmpeg error:', err?.message || err)
      if (!sawCue && cues.length === 0) {
        markRetryable(err?.message || 'Subtitle extract failed')
      } else {
        publishSubtitleCues(cacheKey, cues, job)
        subtitleExtractors.delete(cacheKey)
        scheduleSubtitleExtractResume()
      }
    })

    ffmpeg.once('close', (code) => {
      if (subtitleExtractors.get(cacheKey)?.kill !== killActive) return
      if (!sawCue && cues.length === 0) {
        const downloaded = Number(file.downloaded) || 0
        const progress = Number(file.progress) || 0
        if (downloaded < 8 * 1024 * 1024 && progress < 0.08) {
          markRetryable('Subtitles not ready')
        } else {
          finishMissing('No subtitle cues in selected track')
        }
        return
      }
      publishSubtitleCues(cacheKey, cues, job)
      subtitleExtractors.delete(cacheKey)
      if (torrentFileMostlyComplete(file) && !(code && code !== 0)) {
        job.done = true
        job.retryable = false
      } else {
        scheduleSubtitleExtractResume()
      }
      if (code && code !== 0) {
        console.warn('[torrent subs] ffmpeg exit', code, `(${cues.length} cues kept)`)
      }
    })
  }

  const scheduleSubtitleExtractResume = () => {
    job.done = false
    job.retryable = true
    const lastEnd = cues.reduce((max, cue) => Math.max(max, cue.end || 0), 0)
    const downloadedAtPause = Number(file.downloaded) || 0
    console.warn(
      '[torrent subs] extract paused early with',
      cues.length,
      'cues — will resume',
      { lastEnd: Math.round(lastEnd), downloaded: downloadedAtPause },
    )

    let attempts = 0
    const tryResume = () => {
      attempts += 1
      const current = subtitleJobs.get(cacheKey)
      if (!current || current.done || subtitleExtractors.has(cacheKey)) return
      if (!selectedTrack) return

      if (torrentFileMostlyComplete(file)) {
        // Finished downloading — one clean disk pass from the last cue.
        extractTrack(selectedTrack, { startAt: Math.max(0, lastEnd - 1) })
        return
      }

      const downloadedNow = Number(file.downloaded) || 0
      const progress = Number(file.progress) || 0
      // Wait until more pieces arrive so we don't hammer the same sparse hole.
      const grew =
        downloadedNow >= downloadedAtPause + 6 * 1024 * 1024 || progress >= 0.97
      if (!grew && attempts < 60) {
        setTimeout(tryResume, 5000)
        return
      }
      extractTrack(selectedTrack, { startAt: Math.max(0, lastEnd - 1) })
    }
    setTimeout(tryResume, 5000)
  }

  void (async () => {
    const probeSource = ffmpegInputForSubtitles(file, httpSource, 'probe')
    if (!probeSource) {
      markRetryable('Subtitle source URL missing')
      return
    }
    const downloaded = Number(file.downloaded) || 0
    const progress = Number(file.progress) || 0
    if (downloaded < 2 * 1024 * 1024 && progress < 0.02) {
      markRetryable('Subtitles not ready')
      return
    }

    const tracks = await probeSubtitleTracks(probeSource)
    if (subtitleExtractors.get(cacheKey)?.kill !== killActive) return

    console.log('[torrent subs] probed', {
      via: path.isAbsolute(String(probeSource)) ? 'disk' : 'http',
      tracks: tracks.map((t) => ({
        index: t.index,
        lang: t.language || 'und',
        codec: t.codec,
        title: t.title || '',
        score: scoreSubtitleTrack(t),
      })),
    })

    if (tracks.length === 0) {
      const local = resolveTorrentFileDiskPath(file)
      let localSize = 0
      try {
        localSize = local ? fs.statSync(local).size : 0
      } catch {
        localSize = 0
      }
      // HTTP probes often miss softsubs; disk probes with enough header bytes are definitive.
      const probedDisk = path.isAbsolute(String(probeSource))
      if (probedDisk && localSize >= 8 * 1024 * 1024) {
        finishMissing('No subtitle track found')
      } else if (!probedDisk || localSize < 20 * 1024 * 1024 || progress < 0.35) {
        markRetryable('Subtitles not ready')
      } else {
        finishMissing('No subtitle track found')
      }
      return
    }

    const bestText = pickBestTextSubtitleTrack(tracks)
    if (bestText) {
      extractTrack(bestText)
      return
    }

    // Only image/PGS tracks (or unusable codecs) — cannot overlay those yet.
    const imageOnly = tracks.every((t) => isImageSubtitleCodec(t.codec))
    finishMissing(
      imageOnly
        ? 'Only image subtitles (PGS) in this file — pick a text-sub release'
        : 'No usable text subtitle track in this file',
    )
  })()
}

async function materializeSubtitleUrl(torrent, videoFile, options = {}) {
  const start = options.start !== false
  await getTranscodeServer()
  const cacheKey = `${torrent.infoHash}:${videoFile.path || videoFile.name}`
  if (subtitleCache.has(cacheKey)) {
    return {
      subtitleUrl: cachedSubtitleUrl(cacheKey),
      subtitleKind: subtitleKinds.get(cacheKey) || 'file',
    }
  }

  const companion = findCompanionSubtitle(torrent, videoFile)
  const sourceFile = companion || (EMBEDDED_SUBS_RE.test(videoFile.name) ? videoFile : null)
  if (!sourceFile) return { subtitleUrl: undefined, subtitleKind: undefined }

  const subtitleKind = companion ? 'file' : 'embedded'
  subtitleKinds.set(cacheKey, subtitleKind)

  if (companion) {
    try {
      companion.select()
    } catch {
      /* ignore */
    }
  }

  subtitleSources.set(cacheKey, sourceFile)
  // Embedded extract uses the same local HTTP file URL as video remux.
  if (!companion) {
    await getTranscodeServer()
    subtitleHttpSources.set(cacheKey, torrentRawFileUrl(torrent, videoFile))
  } else {
    subtitleHttpSources.delete(cacheKey)
  }
  if (start) startProgressiveSubtitleExtract(sourceFile, cacheKey)
  return { subtitleUrl: cachedSubtitleUrl(cacheKey), subtitleKind }
}

/** Wait for torrent pieces near a mid-title -ss seek so ffmpeg doesn't emit an empty MP4.
 *  @returns {Promise<boolean>} true when pieces look ready (or source isn't a torrent file).
 */
async function waitForRemuxSeekPoint(source, startAtSec, options = {}) {
  if (!source || !(startAtSec >= 1)) return true
  const signal = options.signal
  const isAborted = () => Boolean(signal?.aborted)
  try {
    const u = new URL(source)
    const m = /^\/torrent-file\/([a-f0-9]{40})\/(\d+)\/?/i.exec(u.pathname)
    if (!m) return true
    const infoHash = m[1].toLowerCase()
    const fileIndex = Number(m[2])
    const waitKey = `${infoHash}:${fileIndex}:${Math.floor(startAtSec)}`
    const inflight = remuxSeekWaitPromises.get(waitKey)
    if (inflight) return inflight

    const run = (async () => {
      if (isAborted()) return false
      const client = await getTorrentClient()
      const got = client.get(infoHash)
      const torrent = got && typeof got.then === 'function' ? await got : got
      const file = torrent?.files?.[fileIndex]
      if (!file || !file.length) return true
      const runtimeKey = `${infoHash}:${fileIndex}`
      const knownRuntime = torrentFileRuntimeSeconds.get(runtimeKey) || 0
      // Prefer probed runtime; fall back to a conservative 2h assumption.
      const assumedDuration = Math.max(
        knownRuntime > 60 ? knownRuntime : 0,
        startAtSec + 45 * 60,
        2 * 60 * 60,
      )
      const offset = Math.min(
        Math.max(0, Number(file.length) - 1),
        Math.floor((startAtSec / assumedDuration) * Number(file.length)),
      )
      const downloaded = Number(file.downloaded) || 0
      // Slow / cold swarm: fail the seek wait so the player can pause & retry
      // at the same playhead (not fall back to t=0).
      const timeoutMs = downloaded < 2 * 1024 * 1024 ? 28_000 : 120_000
      console.log('[torrent audio] waiting for seek point', {
        startAtSec: Math.floor(startAtSec),
        offset,
        assumedDuration: Math.floor(assumedDuration),
        timeoutMs,
        downloaded,
        file: file.name,
      })
      // Prefer the seek window over the opening while Resume is waiting —
      // opening-only critical was starving mid-title continues.
      try {
        if (torrent?.pieceLength) {
          const piece = torrent.pieceLength
          const fileStart = Number(file.offset)
          const fileEnd = fileStart + Number(file.length) - 1
          const seekFirst = Math.floor((fileStart + offset) / piece)
          const seekLast = Math.min(
            Math.floor((fileStart + offset + Math.min(12 * 1024 * 1024, Number(file.length) - offset)) / piece),
            Math.floor(fileEnd / piece),
          )
          torrent.select(seekFirst, seekLast, 10)
          torrent.critical(seekFirst, Math.min(seekFirst + 12, seekLast))
        }
      } catch {
        /* ignore */
      }
      if (isAborted()) return false
      return waitForTorrentFileBytesAt(file, offset, timeoutMs, signal)
    })().finally(() => {
      remuxSeekWaitPromises.delete(waitKey)
    })

    remuxSeekWaitPromises.set(waitKey, run)
    return run
  } catch (err) {
    console.warn('[torrent audio] seek wait failed', err?.message || err)
    return false
  }
}

async function handleAudioTranscode(req, res, source) {
  let startAt = 0
  let exact = false
  let forceHevcTranscode = false
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    startAt = Math.max(0, Number(url.searchParams.get('t')) || 0)
    exact = url.searchParams.get('exact') === '1'
    forceHevcTranscode =
      url.searchParams.get('hevc') === '1' || HEVC_VIDEO_RE.test(decodeURIComponent(source || ''))
  } catch {
    startAt = 0
    exact = false
    forceHevcTranscode = HEVC_VIDEO_RE.test(String(source || ''))
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*',
    })
    res.end()
    return
  }

  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) {
    res.writeHead(500)
    res.end('FFmpeg is unavailable')
    return
  }

  const abortCtl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const onClientGone = () => {
    try {
      abortCtl?.abort()
    } catch {
      /* ignore */
    }
  }
  req.once('close', onClientGone)
  res.once('close', onClientGone)

  // Resume / mid-title continue: wait for pieces first. Seeking into a hole
  // made ffmpeg exit with "Output file is empty" and the player fall back to t=0.
  if (startAt >= 1) {
    const ready = await waitForRemuxSeekPoint(source, startAt, { signal: abortCtl?.signal })
    if (abortCtl?.signal?.aborted || req.aborted) {
      return
    }
    if (!ready) {
      console.warn('[torrent audio] seek point not ready — 503', {
        startAt: Math.floor(startAt),
      })
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '8',
        'Access-Control-Allow-Origin': '*',
      })
      res.end('Seek point not ready')
      return
    }
  }

  // MULTI packs often put French on a:0 — pick English when tagged.
  const audioOrdinal = await probePreferredAudioOrdinal(source)

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
  })

  // Default: copy video, re-encode audio to AAC for Chromium.
  // HEVC/x265 copy → black screen in Electron; re-encode those to H.264.
  // Softsubs stay on the VTT overlay (ffmpeg subtitles filter can't reliably
  // read progressive HTTP torrent sources).
  //
  // A/V sync notes:
  // - Never use input-only -ss with -c:v copy (video lands on a keyframe,
  //   audio on the exact time → permanent offset).
  // - Don't use aresample=async=* — continuous stretch drifts against copied
  //   video timestamps in fragmented MP4.
  // - muxdelay/muxpreload 0 also breaks interleaving for fMP4 in Chromium.
  if (forceHevcTranscode) {
    console.log('[torrent audio] HEVC source — transcoding video to H.264', {
      startAt: Math.floor(startAt),
    })
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-fflags',
    '+genpts+igndts',
    // Smaller probe on cold start so the first fMP4 fragment arrives sooner
    // while the torrent head is still filling (1080p MKV was timing out at 25s).
    '-probesize',
    exact || forceHevcTranscode ? '5M' : '1M',
    '-analyzeduration',
    exact || forceHevcTranscode ? '5000000' : '1000000',
  ]
  if (startAt >= 1) {
    // Coarse input seek for speed, then a short accurate output seek so
    // copied video and re-encoded audio share the same cut point.
    // exact=1 / HEVC re-encode: decode-seek only for clean timestamps.
    if (exact || forceHevcTranscode) {
      args.push('-i', source, '-ss', startAt.toFixed(3))
    } else {
      const coarse = Math.max(0, startAt - 3)
      if (coarse >= 1) args.push('-ss', coarse.toFixed(3))
      args.push('-i', source, '-ss', (startAt - coarse).toFixed(3))
    }
  } else {
    args.push('-i', source)
  }
  // Require an audio stream — optional `0:a:N?` produced silent video when the
  // torrent head hadn't exposed audio yet (Chromium then plays picture-only).
  args.push('-map', '0:v:0', '-map', `0:a:${audioOrdinal}`)
  if (forceHevcTranscode) {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'main',
    )
  } else {
    args.push('-c:v', 'copy')
  }
  args.push(
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    // Reset audio timeline to 0 without continuous time-stretching.
    '-af',
    'aresample=first_pts=0',
    '-avoid_negative_ts',
    'make_zero',
    '-max_muxing_queue_size',
    '2048',
    '-max_interleave_delta',
    '0',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  )

  const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let bytesOut = 0
  ffmpeg.stdout.on('data', (chunk) => {
    bytesOut += chunk.length
  })
  ffmpeg.stdout.pipe(res)
  ffmpeg.stderr.on('data', (chunk) => {
    const message = String(chunk).trim()
    if (message) console.warn('[torrent audio]', message)
  })
  ffmpeg.once('error', (err) => {
    console.error('[torrent audio] ffmpeg failed:', err?.message || err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  ffmpeg.once('close', () => {
    if (bytesOut === 0 && startAt >= 1) {
      console.warn('[torrent audio] empty remux after seek', { startAt: Math.floor(startAt) })
    }
    if (!res.writableEnded) res.end()
  })
  res.once('close', () => {
    if (!ffmpeg.killed) ffmpeg.kill()
  })
}

function sendVtt(res, body, options = {}) {
  const done = Boolean(options.done)
  res.writeHead(200, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Jiyu-Subs-Done',
    'X-Jiyu-Subs-Done': done ? '1' : '0',
  })
  res.end(body)
}

async function handleSubtitleRequest(req, res, source, cacheKey) {
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    res.end()
    return
  }
  try {
    if (cacheKey && subtitleCache.has(cacheKey)) {
      sendVtt(res, subtitleCache.get(cacheKey))
      return
    }
    // Brief wait for progressive extract to publish the first cues.
    if (cacheKey) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (subtitleCache.has(cacheKey)) {
          sendVtt(res, subtitleCache.get(cacheKey))
          return
        }
        const job = subtitleJobs.get(cacheKey)
        if (job?.done && !subtitleCache.has(cacheKey)) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (sourceLooksLikeSubtitleFile(source)) {
      const body = await extractWebVttFromSource(source)
      if (body.length) {
        if (cacheKey) subtitleCache.set(cacheKey, body)
        sendVtt(res, body)
        return
      }
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    res.end(subtitleJobs.get(cacheKey)?.error || 'Subtitles not ready')
  } catch (err) {
    console.warn('[torrent subs]', err?.message || err)
    if (!res.headersSent) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      res.end(err?.message || 'No subtitles')
    }
  }
}

async function handleCachedSubtitleRequest(req, res, cacheKey) {
  let force = false
  try {
    force = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('force') === '1'
  } catch {
    force = false
  }
  const sourceFile = subtitleSources.get(cacheKey)
  const existing = subtitleJobs.get(cacheKey)
  const sidecar = sourceFile && SUBTITLE_FILE_RE.test(sourceFile.name || '')
  const bufferReady = subtitleSourceReadyForExtract(sourceFile)

  // Subs button / manual retry: re-read companion .srt immediately.
  if (force && sourceFile && sidecar) {
    try {
      subtitleExtractors.get(cacheKey)?.kill()
    } catch {
      /* ignore */
    }
    subtitleExtractors.delete(cacheKey)
    subtitleJobs.delete(cacheKey)
    if (!subtitleCache.has(cacheKey)) {
      /* keep any prior cues if present; extract will overwrite */
    }
    startProgressiveSubtitleExtract(sourceFile, cacheKey)
  } else if (sourceFile && bufferReady) {
    // Sidecar .srt: kick immediately. Embedded: wait for opening buffer so the
    // player's sub poll storm cannot starve remux on a 1-peer swarm.
    if (!existing || (existing.done && existing.retryable)) {
      startProgressiveSubtitleExtract(sourceFile, cacheKey)
    }
  } else if (sourceFile && !existing) {
    scheduleSubtitleExtractWhenReady(sourceFile, cacheKey)
  }

  // Give the new episode's extractor a moment to publish the first cues.
  for (let attempt = 0; attempt < (bufferReady ? 12 : 2); attempt += 1) {
    if (subtitleCache.has(cacheKey)) break
    const job = subtitleJobs.get(cacheKey)
    if (job?.done && !job.retryable) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const body = subtitleCache.get(cacheKey)
  const job = subtitleJobs.get(cacheKey)
  const extractDone = Boolean(job?.done && !job.retryable && body)
  if (!body) {
    const message =
      job?.done && job.error
        ? job.error
        : job?.done
          ? 'No subtitle track found'
          : 'Subtitles not ready'
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    res.end(message)
    return
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Jiyu-Subs-Done',
      'X-Jiyu-Subs-Done': extractDone ? '1' : '0',
    })
    res.end()
    return
  }
  sendVtt(res, body, { done: extractDone })
}

/** Prioritize / wait for pieces covering a byte offset inside a torrent file. */
function waitForTorrentFileBytesAt(file, byteOffset, timeoutMs = 45000, signal) {
  const torrent = file?._torrent || file?.torrent
  if (!file || !torrent || !torrent.pieceLength) {
    return Promise.resolve(false)
  }
  const abs = Math.max(0, Number(file.offset) + Math.max(0, byteOffset))
  const lastFileByte = Number(file.offset) + Number(file.length) - 1
  const first = Math.floor(abs / torrent.pieceLength)
  const last = Math.min(
    first + 48,
    Math.floor(Math.max(abs, lastFileByte) / torrent.pieceLength),
  )
  try {
    torrent.select(first, last, 12)
    torrent.critical(first, Math.min(first + 16, last))
  } catch {
    /* ignore */
  }

  const bitfield = torrent.bitfield
  const hasPiece = (index) => {
    try {
      return Boolean(bitfield && typeof bitfield.get === 'function' && bitfield.get(index))
    } catch {
      return false
    }
  }
  if (hasPiece(first) && hasPiece(Math.min(first + 1, last))) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const started = Date.now()
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const onAbort = () => finish(false)
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true })
    } catch {
      /* ignore */
    }
    if (signal?.aborted) {
      finish(false)
      return
    }
    timer = setInterval(() => {
      if (signal?.aborted) {
        finish(false)
        return
      }
      // Only trust the pieces at the seek point. Global download growth used to
      // return true while the hole at `offset` was still empty — ffmpeg then hung
      // and the player looked "stuck".
      if (hasPiece(first) && hasPiece(Math.min(first + 1, last))) {
        finish(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        finish(false)
      }
    }, 250)
  })
}

/**
 * Pipe a torrent file range to an HTTP response, resuming across download gaps.
 * WebTorrent's createReadStream errors when it hits undownloaded pieces; ending
 * the response there kills ffmpeg mid-movie ("Stream ends prematurely").
 */
function pipeTorrentFileResilient(file, res, start, end) {
  let offset = Math.max(0, start)
  let closed = false
  /** @type {import('stream').Readable | null} */
  let active = null
  let resumes = 0
  const maxResumes = 40

  const cleanup = () => {
    closed = true
    try {
      active?.destroy?.()
    } catch {
      /* ignore */
    }
    active = null
  }
  res.once('close', cleanup)

  const finish = () => {
    cleanup()
    if (!res.writableEnded) res.end()
  }

  const pump = () => {
    if (closed || res.writableEnded) return
    if (offset > end) {
      finish()
      return
    }
    const stream = file.createReadStream({ start: offset, end })
    active = stream
    stream.on('data', (chunk) => {
      offset += chunk.length
    })
    stream.on('error', (err) => {
      console.warn('[torrent file]', err?.message || err, { offset, resumes })
      try {
        stream.destroy?.()
      } catch {
        /* ignore */
      }
      if (active === stream) active = null
      if (closed || res.writableEnded) return
      if (resumes >= maxResumes) {
        finish()
        return
      }
      resumes += 1
      void waitForTorrentFileBytesAt(file, offset, 45000).then((ok) => {
        if (closed || res.writableEnded) return
        if (!ok) {
          console.warn('[torrent file] give up waiting for bytes', { offset })
          finish()
          return
        }
        console.log('[torrent file] resume after gap', { offset, resumes })
        pump()
      })
    })
    stream.on('end', () => {
      if (active === stream) active = null
      if (closed || res.writableEnded) return
      // Finished the requested range (or file).
      if (offset > end || offset >= Number(file.length)) {
        finish()
        return
      }
      // Ended early without error — wait and continue (same gap case).
      if (resumes >= maxResumes) {
        finish()
        return
      }
      resumes += 1
      void waitForTorrentFileBytesAt(file, offset, 45000).then((ok) => {
        if (closed || res.writableEnded) return
        if (!ok) {
          finish()
          return
        }
        console.log('[torrent file] resume after short end', { offset, resumes })
        pump()
      })
    })
    stream.pipe(res, { end: false })
  }

  pump()
}

/**
 * Serve a torrent file by infoHash + index. Avoids WebTorrent path 404s on
 * batch folders with brackets / odd characters (SubsPlease packs).
 */
async function handleTorrentFileByIndex(req, res, infoHash, fileIndex) {
  try {
    const client = await getTorrentClient()
    const got = client.get(infoHash)
    const torrent = got && typeof got.then === 'function' ? await got : got
    const file = torrent?.files?.[fileIndex]
    if (!file) {
      res.writeHead(404)
      res.end('Torrent file not found')
      return
    }
    const size = Number(file.length) || 0
    const type = /\.mkv$/i.test(file.name)
      ? 'video/x-matroska'
      : /\.mp4$/i.test(file.name)
        ? 'video/mp4'
        : 'application/octet-stream'

    let start = 0
    let end = Math.max(0, size - 1)
    const range = req.headers.range
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(String(range))
      if (m) {
        if (m[1] !== '') start = Number(m[1])
        if (m[2] !== '') end = Number(m[2])
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= size) end = size - 1
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
      }
    }
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      })
    }
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    // Warm the opening pieces for this range before ffmpeg starts reading.
    await waitForTorrentFileBytesAt(file, start, 20000)
    pipeTorrentFileResilient(file, res, start, end)
  } catch (err) {
    console.warn('[torrent file]', err?.message || err)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('Torrent file failed')
    }
  }
}

async function getTranscodeServer() {
  if (!transcodeServerPromise) {
    transcodeServerPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let pathname = '/'
        let source = ''
        let cacheKey = ''
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          pathname = url.pathname
          source = url.searchParams.get('source') || ''
          cacheKey = url.searchParams.get('cacheKey') || ''
        } catch {
          /* invalid request */
        }
        if (pathname.startsWith('/subs-cache/')) {
          const key = decodeURIComponent(pathname.slice('/subs-cache/'.length).replace(/\.vtt$/i, ''))
          void handleCachedSubtitleRequest(req, res, key)
          return
        }
        const fileMatch = /^\/torrent-file\/([a-f0-9]{40})\/(\d+)\/?$/i.exec(pathname)
        if (fileMatch) {
          void handleTorrentFileByIndex(req, res, fileMatch[1].toLowerCase(), Number(fileMatch[2]))
          return
        }
        // Remux / legacy subs endpoints may only read Jiyu local torrent URLs.
        if (!localTorrentSourceOk(source)) {
          res.writeHead(400)
          res.end('Invalid source')
          return
        }
        if (pathname === '/subs.vtt') {
          void handleSubtitleRequest(req, res, source, cacheKey)
          return
        }
        void handleAudioTranscode(req, res, source)
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        transcodeServerPort = server.address().port
        resolve(server)
      })
    }).catch((err) => {
      transcodeServerPromise = null
      throw err
    })
  }
  await transcodeServerPromise
  return transcodeServerPort
}

function torrentRawFileUrl(torrent, file) {
  // Prefer index-based URL on our transcode server — WebTorrent's path router
  // 404s on many SubsPlease batch folder names ([Batch], brackets, etc.).
  const index = Math.max(0, torrent.files.indexOf(file))
  if (transcodeServerPort && torrent.infoHash) {
    return `http://127.0.0.1:${transcodeServerPort}/torrent-file/${torrent.infoHash}/${index}`
  }
  try {
    const streamPath = file.streamURL
    if (streamPath) return `http://127.0.0.1:${torrentServerPort}${streamPath}`
  } catch {
    /* fall through */
  }
  const encoded = file.path.split(/[\\/]/).map(encodeURIComponent).join('/')
  return `http://127.0.0.1:${torrentServerPort}/webtorrent/${torrent.infoHash}/${encoded}`
}

function findCompanionSubtitle(torrent, videoFile) {
  const subs = torrent.files.filter((file) => SUBTITLE_FILE_RE.test(file.name))
  if (subs.length === 0) return null

  const base = videoFile.name.replace(/\.[^.]+$/, '').toLowerCase()
  const videoDir = videoFile.path.replace(/[\\/][^\\/]+$/, '').toLowerCase()

  const ranked = subs
    .map((file) => {
      const name = file.name.toLowerCase()
      const stem = name.replace(/\.[^.]+$/, '')
      const dir = file.path.replace(/[\\/][^\\/]+$/, '').toLowerCase()
      let score = 0
      if (stem === base) score += 100
      else if (stem.startsWith(base) || base.startsWith(stem)) score += 80
      else if (stem.includes(base) || base.includes(stem)) score += 45
      if (dir && dir === videoDir) score += 25
      if (/(^|[._\-\s[(])(en|eng|english)([._\-\s\])]|$)/i.test(name)) score += 40
      if (/\.(ass|ssa)$/i.test(name)) score += 10
      if (/\.srt$/i.test(name)) score += 6
      if (/(^|[._\-\s[(])(forced|signs?|songs?|commentary)([._\-\s\])]|$)/i.test(name)) score -= 35
      if (/(^|[._\-\s[(])(jp|jpn|japanese|chi|zho|kor)([._\-\s\])]|$)/i.test(name)) score -= 10
      return { file, score }
    })
    .sort((a, b) => b.score - a.score)

  console.log(
    '[torrent subs] companion candidates',
    ranked.slice(0, 5).map((r) => ({ name: r.file.name, score: r.score })),
  )

  if (ranked[0]?.score >= 45) return ranked[0].file
  if (subs.length === 1) return subs[0]
  return ranked[0]?.score > 0 ? ranked[0].file : null
}

async function torrentSubtitleUrl(torrent, videoFile, options = {}) {
  return materializeSubtitleUrl(torrent, videoFile, options)
}

function magnetInfoHash(magnet) {
  const m = /urn:btih:([a-z0-9]{32,40})/i.exec(magnet)
  return m ? m[1].toLowerCase() : null
}

/** Fetch .torrent bytes by info-hash so we don't depend only on magnet metadata peers. */
async function fetchTorrentMetadataByHash(hash) {
  if (!hash || (hash.length !== 40 && hash.length !== 32)) return null
  const hex = hash.length === 40 ? hash : null
  // itorrents expects uppercase hex SHA-1
  const urls = []
  if (hex) {
    urls.push(`https://itorrents.org/torrent/${hex.toUpperCase()}.torrent`)
    urls.push(`https://torrage.info/torrent.php?h=${hex.toUpperCase()}`)
  }
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': STREAM_UA, Accept: 'application/x-bittorrent,*/*' },
      })
      if (!response.ok) continue
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength < 32 || bytes.byteLength > 25 * 1024 * 1024) continue
      // Bencoded torrent files start with 'd'
      if (bytes[0] !== 0x64) continue
      console.log('[torrent] metadata from cache', url)
      return bytes
    } catch {
      /* try next mirror */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

function describeTorrent(torrent) {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || '',
    progress: torrent.progress,
    downloadSpeed: torrent.downloadSpeed,
    numPeers: torrent.numPeers,
    downloaded: torrent.downloaded,
    length: torrent.length,
  }
}

function naturalVideoCompare(a, b) {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function playableTorrentFiles(torrent) {
  const videos = torrent.files.filter((file) => VIDEO_FILE_RE.test(file.name))
  if (videos.length <= 1) return videos

  const notExtras = videos.filter(
    (file) => !/(^|[._\s-])(sample|trailer|featurette|behind[._\s-]*the[._\s-]*scenes)([._\s-]|$)/i.test(file.name),
  )
  const candidates = notExtras.length ? notExtras : videos
  const largest = Math.max(...candidates.map((file) => file.length))
  const substantial = candidates.filter(
    (file) => file.length >= 20 * 1024 * 1024 && file.length >= largest * 0.05,
  )
  return (substantial.length ? substantial : candidates).sort(naturalVideoCompare)
}

/** Torrentio season packs send fileIdx / filename — honor them so S01E10 isn't file 0. */
function parseJiyuMagnetHints(uri) {
  const idxMatch = /[?&]_jiyuFileIdx=(\d+)/i.exec(String(uri || ''))
  const nameMatch = /[?&]_jiyuFileName=([^&]+)/i.exec(String(uri || ''))
  let fileName
  if (nameMatch) {
    try {
      fileName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
    } catch {
      fileName = nameMatch[1]
    }
  }
  const fileIndex = idxMatch ? Number(idxMatch[1]) : NaN
  return {
    fileIndex: Number.isFinite(fileIndex) && fileIndex >= 0 ? fileIndex : undefined,
    fileName: fileName || undefined,
  }
}

function pickTorrentVideoFile(torrent, hints = {}) {
  const playlistFiles = playableTorrentFiles(torrent)
  if (!playlistFiles.length) return { file: null, playlistFiles }

  const fileIndex =
    Number.isFinite(hints.fileIndex) && hints.fileIndex >= 0 ? hints.fileIndex : undefined
  if (fileIndex != null && torrent.files?.[fileIndex]) {
    const byIdx = torrent.files[fileIndex]
    if (VIDEO_FILE_RE.test(byIdx.name)) {
      return { file: byIdx, playlistFiles }
    }
  }

  const want = String(hints.fileName || '')
    .trim()
    .toLowerCase()
  if (want) {
    const byName =
      playlistFiles.find((f) => f.name.toLowerCase() === want) ||
      playlistFiles.find((f) => f.name.toLowerCase().endsWith(want)) ||
      torrent.files.find(
        (f) => VIDEO_FILE_RE.test(f.name) && f.name.toLowerCase().includes(want),
      )
    if (byName) return { file: byName, playlistFiles }
  }

  return { file: playlistFiles[0], playlistFiles }
}

async function torrentFilePlaybackUrl(torrent, file) {
  // Ensure index-based /torrent-file URLs are available before building source.
  await getTranscodeServer()
  const sourceUrl = torrentRawFileUrl(torrent, file)
  if (!AUDIO_TRANSCODE_RE.test(file.name)) return sourceUrl

  const port = transcodeServerPort
  const hevc = HEVC_VIDEO_RE.test(file.name || '') ? '&hevc=1' : ''
  return `http://127.0.0.1:${port}/stream.mp4?source=${encodeURIComponent(sourceUrl)}${hevc}`
}

const MAX_CONCURRENT_TORRENTS = 4

ipcMain.handle('torrent:stream', async (_event, input, options) => {
  try {
    if (typeof input !== 'string') {
      return { ok: false, error: 'Invalid torrent link' }
    }
    const uri = input.trim()
    const keepOthers = Boolean(options && options.keepOthers)
    const magnetHints = {
      ...parseJiyuMagnetHints(uri),
      ...(Number.isFinite(options?.fileIndex) ? { fileIndex: Number(options.fileIndex) } : {}),
      ...(typeof options?.fileName === 'string' && options.fileName.trim()
        ? { fileName: options.fileName.trim() }
        : {}),
    }
    const isMagnet = /^magnet:\?/i.test(uri)
    let isTorrentUrl = false
    try {
      const parsed = new URL(uri)
      isTorrentUrl = /^https?:$/i.test(parsed.protocol) && /\.torrent$/i.test(parsed.pathname)
    } catch {
      /* validated below */
    }
    if (!isMagnet && !isTorrentUrl) {
      return { ok: false, error: 'Use a magnet link or an HTTP(S) .torrent link' }
    }

    const client = await getTorrentClient()

    let torrent = null
    let addedHere = false
    const hash = isMagnet ? magnetInfoHash(uri) : null
    if (hash) {
      const got = client.get(hash)
      torrent = got && typeof got.then === 'function' ? await got : got
    }

    // Single-play: drop other swarms so a stuck prior episode cannot starve this
    // one. Multi-view passes keepOthers so tile A keeps downloading while B starts.
    if (!keepOthers) {
      for (const other of [...client.torrents]) {
        if (hash && other.infoHash === hash) continue
        releaseTorrent(other)
      }
    } else {
      const others = client.torrents.filter((t) => !hash || t.infoHash !== hash)
      const overflow = others.length + 1 - MAX_CONCURRENT_TORRENTS
      if (overflow > 0) {
        for (const other of others.slice(0, overflow)) {
          releaseTorrent(other)
        }
      }
    }

    let usedCachedTorrent = false
    if (!torrent) {
      addedHere = true
      // Keep magnet trackers even when we swap in a cached .torrent buffer —
      // itorrents metadata often has a thin/empty announce list, which made
      // every EZTV play look "dead" after a short peer probe.
      const announce = isMagnet ? announceListForTorrent(uri) : [...DEFAULT_TORRENT_TRACKERS]
      let torrentId = isMagnet ? magnetWithDefaultTrackers(uri) : uri

      if (isTorrentUrl) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        try {
          const response = await fetch(uri, {
            signal: controller.signal,
            headers: { 'User-Agent': STREAM_UA, Accept: 'application/x-bittorrent,*/*' },
          })
          if (!response.ok) {
            throw new Error(`Torrent download failed (HTTP ${response.status})`)
          }
          const bytes = await response.arrayBuffer()
          if (bytes.byteLength === 0) throw new Error('Downloaded torrent file is empty')
          if (bytes.byteLength > 25 * 1024 * 1024) {
            throw new Error('Torrent metadata file is unexpectedly large')
          }
          torrentId = Buffer.from(bytes)
        } finally {
          clearTimeout(timer)
        }
      }

      // Magnets: try the URI first (trackers + DHT). Only pull itorrents if
      // metadata doesn't arrive — cached .torrent alone often sits at 0 peers.
      if (isMagnet && hash) {
        console.log('[torrent] add', {
          fromCache: false,
          announceCount: announce.length,
          infoHash: hash,
        })
        try {
          const addedMagnet = client.add(torrentId, {
            path: torrentDownloadRoot(),
            destroyStoreOnDestroy: true,
            announce,
            strategy: 'sequential',
          })
          torrent = await Promise.race([
            waitForTorrentReady(addedMagnet),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('magnet-metadata-timeout')), MAGNET_METADATA_MS),
            ),
          ])
        } catch (err) {
          console.log('[torrent] magnet metadata slow — trying itorrents cache', {
            infoHash: hash,
            error: err?.message || String(err),
          })
          try {
            const stuck = client.get(hash)
            const existing = stuck && typeof stuck.then === 'function' ? await stuck : stuck
            if (existing) releaseTorrent(existing)
          } catch {
            /* ignore */
          }
          const cached = await fetchTorrentMetadataByHash(hash)
          if (cached) {
            torrentId = cached
            usedCachedTorrent = true
          }
        }
      }

      if (!torrent) {
        console.log('[torrent] add', {
          fromCache: Buffer.isBuffer(torrentId),
          announceCount: announce.length,
          infoHash: hash,
          retry: usedCachedTorrent ? 'itorrents' : undefined,
        })
        const added = client.add(torrentId, {
          path: torrentDownloadRoot(),
          destroyStoreOnDestroy: true,
          announce,
          strategy: 'sequential',
        })
        torrent = await waitForTorrentReady(added)
      }
    } else if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
      torrent = await waitForTorrentReady(torrent)
    }

    async function selectAndProbe(activeTorrent, options = {}) {
      const probeMs = Number(options.probeMs) > 0 ? Number(options.probeMs) : PEER_PROBE_MS
      forgetPartialTorrent(activeTorrent.infoHash)
      const files = [...activeTorrent.files].sort((a, b) => b.length - a.length)
      const { file, playlistFiles } = pickTorrentVideoFile(activeTorrent, magnetHints)
      if (!file) {
        return {
          ok: false,
          error: `Torrent has no playable video file (largest file: ${files[0]?.name ?? 'none'})`,
        }
      }
      if (magnetHints.fileIndex != null || magnetHints.fileName) {
        console.log('[torrent] selected episode file', {
          infoHash: activeTorrent.infoHash,
          file: file.name,
          fileIndex: magnetHints.fileIndex,
          wantedName: magnetHints.fileName || '',
        })
      }

      // Deselect extras, then fully select the active video so WebTorrent keeps
      // downloading ahead of the remux. Range-only selection was starving mid-play
      // (endless Chromium spinner once the small head buffer ran out).
      for (const f of activeTorrent.files) {
        try {
          f.deselect()
        } catch {
          /* ignore */
        }
      }
      try {
        file.select()
      } catch {
        /* ignore */
      }

      const firstPiece = Math.floor(file.offset / activeTorrent.pieceLength)
      const lastFilePiece = Math.floor(
        (file.offset + file.length - 1) / activeTorrent.pieceLength,
      )
      const criticalSpan = performanceKnobs.torrentCriticalPieces || 16
      const prefetchSpan = performanceKnobs.torrentPrefetchPieces || 120
      const criticalLastPiece = Math.min(firstPiece + criticalSpan, lastFilePiece)
      // Hot-start a larger opening window; sequential strategy fills the rest.
      const prefetchLastPiece = Math.min(firstPiece + prefetchSpan, lastFilePiece)
      activeTorrent.select(firstPiece, lastFilePiece, 5)
      activeTorrent.select(firstPiece, prefetchLastPiece, 12)
      activeTorrent.critical(firstPiece, criticalLastPiece)

      // Keep companion subtitle files selected — they are tiny and needed for softsubs.
      for (const entry of playlistFiles) {
        const companion = findCompanionSubtitle(activeTorrent, entry)
        if (companion) {
          try {
            companion.select()
          } catch {
            /* ignore */
          }
        }
      }

      // Wait for swarm activity, but don't hard-fail solely on numPeers — DHT can
      // stay at 0 briefly while still finding peers. Prefer "got opening bytes".
      let foundPeer = activeTorrent.downloaded > 0 || activeTorrent.numPeers > 0
      if (!foundPeer) {
        console.log('[torrent] probing for peers', {
          infoHash: activeTorrent.infoHash,
          name: activeTorrent.name,
          waitMs: probeMs,
        })
        foundPeer = await new Promise((resolve) => {
          const deadline = setTimeout(() => finish(false), probeMs)
          const poll = setInterval(() => {
            if (activeTorrent.downloaded > 0 || activeTorrent.numPeers > 0) finish(true)
          }, 250)
          function finish(ok) {
            clearTimeout(deadline)
            clearInterval(poll)
            resolve(ok)
          }
        })
        console.log('[torrent] peer probe result', {
          infoHash: activeTorrent.infoHash,
          foundPeer,
          numPeers: activeTorrent.numPeers,
          downloaded: activeTorrent.downloaded,
        })
      }

      // Dead swarm: skip the long opening-byte wait so the UI isn't stuck on
      // "Starting…" for another 35s after a failed peer probe.
      if (!foundPeer && activeTorrent.downloaded === 0 && activeTorrent.numPeers === 0) {
        return { ok: true, file, playlistFiles, gotOpening: false, swarmIdle: true }
      }

      const gotOpening = await waitForFileBytes(file, 256 * 1024, OPENING_BYTES_WAIT_MS)
      return { ok: true, file, playlistFiles, gotOpening, swarmIdle: false }
    }

    let prepared = await selectAndProbe(torrent)
    if (!prepared.ok) {
      if (addedHere) releaseTorrent(torrent)
      return { ok: false, error: prepared.error }
    }

    // Cached .torrent + announce opts can sit at 0 peers; rebuild from the magnet
    // (trackers in the URI) before declaring the swarm dead — keep this short.
    if (
      !prepared.gotOpening &&
      torrent.downloaded === 0 &&
      torrent.numPeers === 0 &&
      usedCachedTorrent &&
      isMagnet &&
      addedHere
    ) {
      console.log('[torrent] cache swarm idle — retrying as magnet', {
        infoHash: torrent.infoHash,
      })
      releaseTorrent(torrent)
      const announce = announceListForTorrent(uri)
      console.log('[torrent] add', {
        fromCache: false,
        announceCount: announce.length,
        infoHash: hash,
        retry: 'magnet',
      })
      try {
        const added = client.add(magnetWithDefaultTrackers(uri), {
          path: torrentDownloadRoot(),
          destroyStoreOnDestroy: true,
          announce,
          strategy: 'sequential',
        })
        torrent = await waitForTorrentReady(added, MAGNET_RETRY_READY_MS)
        prepared = await selectAndProbe(torrent, { probeMs: PEER_PROBE_RETRY_MS })
        if (!prepared.ok) {
          releaseTorrent(torrent)
          return { ok: false, error: prepared.error }
        }
      } catch (err) {
        console.log('[torrent] magnet retry failed', {
          infoHash: hash,
          error: err?.message || String(err),
        })
        return { ok: false, error: NO_PEERS_ERROR }
      }
    }

    const { file, playlistFiles, gotOpening } = prepared
    if (!gotOpening && torrent.downloaded === 0 && torrent.numPeers === 0) {
      console.log('[torrent] no peers/bytes after opening wait', {
        infoHash: torrent.infoHash,
        name: torrent.name,
        swarmIdle: Boolean(prepared.swarmIdle),
      })
      if (addedHere) releaseTorrent(torrent)
      return {
        ok: false,
        error: NO_PEERS_ERROR,
      }
    }
    if (!gotOpening) {
      // Peers exist but slow — still hand off; player can buffer.
      console.log('[torrent] proceeding with slow swarm', {
        infoHash: torrent.infoHash,
        numPeers: torrent.numPeers,
        downloaded: torrent.downloaded,
      })
    }

    // Stop any prior episode's subtitle extractor so it cannot starve playback.
    abortSubtitleExtractors(null)

    const playlist = await Promise.all(
      playlistFiles.map(async (entry) => {
        // Register sub URLs now; kick off extract after remux is handed to the player.
        const subs = await torrentSubtitleUrl(torrent, entry, { start: false })
        return {
          title: entry.name.replace(/\.[^.]+$/, ''),
          fileName: entry.name,
          url: await torrentFilePlaybackUrl(torrent, entry),
          subtitleUrl: subs.subtitleUrl,
          // 'file' = companion .srt/.ass/.vtt; 'embedded' = softsub probe inside mkv/mp4
          subtitleKind: subs.subtitleKind,
        }
      }),
    )
    const playbackUrl = playlist[0].url
    const subtitleUrl = playlist[0].subtitleUrl
    const subtitleKind = playlist[0].subtitleKind
    const audioTranscoded = AUDIO_TRANSCODE_RE.test(file.name)

    // Probe real runtime from the raw file URL (not remux). Cheap metadata read.
    let runtimeSeconds = 0
    try {
      const probeUrl = torrentRawFileUrl(torrent, file)
      runtimeSeconds = await probeMediaDurationSeconds(probeUrl, gotOpening ? 18000 : 8000)
      if (runtimeSeconds > 0) {
        console.log('[torrent] probed runtime', {
          file: file.name,
          runtimeSeconds,
        })
        try {
          const idx = torrent.files.indexOf(file)
          if (idx >= 0) {
            torrentFileRuntimeSeconds.set(`${torrent.infoHash}:${idx}`, runtimeSeconds)
          }
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn('[torrent] runtime probe failed', err?.message || err)
    }

    // Embedded softsubs: let remux claim the swarm first. Companion .srt/.ass
    // files are tiny — start almost immediately (the old 12MB gate blocked them forever).
    const primarySubKey = `${torrent.infoHash}:${file.path || file.name}`
    if (playlist[0]?.subtitleUrl) {
      const sidecar = playlist[0].subtitleKind === 'file'
      setTimeout(() => {
        const sourceFile = subtitleSources.get(primarySubKey)
        if (sourceFile) startProgressiveSubtitleExtract(sourceFile, primarySubKey)
      }, sidecar ? 2_000 : 45_000)
    }

    // Single-play: drop leftover swarms after this one is ready. Multi-view keeps them.
    if (!keepOthers && torrent.infoHash) {
      for (const other of [...client.torrents]) {
        if (other.infoHash !== torrent.infoHash) releaseTorrent(other)
      }
    }

    return {
      ok: true,
      url: playbackUrl,
      subtitleUrl,
      subtitleKind,
      fileName: file.name,
      audioTranscoded,
      playlist,
      runtimeSeconds: runtimeSeconds || undefined,
      ...describeTorrent(torrent),
    }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not start torrent stream' }
  }
})

ipcMain.handle('torrent:status', async (_event, infoHash) => {
  if (!torrentClientPromise) return { ok: true, torrents: [] }
  try {
    const client = await getTorrentClient()
    const list = infoHash
      ? client.torrents.filter((t) => t.infoHash === infoHash)
      : client.torrents
    return { ok: true, torrents: list.map(describeTorrent) }
  } catch (err) {
    return { ok: false, torrents: [], error: err?.message || 'Status failed' }
  }
})

/**
 * Keep the active video file selected and prioritize pieces ahead of the playhead.
 * Used while paused so resume isn't into an empty gap — does not force a full download.
 */
ipcMain.handle('torrent:ensureDownloading', async (_event, infoHash, playheadSec, runtimeSec) => {
  try {
    if (!infoHash || !torrentClientPromise) return { ok: false, error: 'No torrent' }
    const client = await getTorrentClient()
    const got = client.get(String(infoHash).toLowerCase())
    const torrent = got && typeof got.then === 'function' ? await got : got
    if (!torrent?.files?.length) return { ok: false, error: 'Torrent not found' }
    const files = playableTorrentFiles(torrent)
    const file = files[0]
    if (!file) return { ok: false, error: 'No video file' }
    try {
      file.select()
    } catch {
      /* ignore */
    }
    const head = Math.max(0, Number(playheadSec) || 0)
    const assumed = Math.max(Number(runtimeSec) || 0, head + 45 * 60, 90 * 60)
    const offset = Math.min(
      Math.max(0, Number(file.length) - 1),
      Math.floor((head / assumed) * Number(file.length)),
    )
    const first = Math.floor((Number(file.offset) + offset) / torrent.pieceLength)
    const lastFile = Math.floor(
      (Number(file.offset) + Number(file.length) - 1) / torrent.pieceLength,
    )
    const prefetchSpan = Math.max(32, Math.floor((performanceKnobs.torrentPrefetchPieces || 120) * 0.8))
    const criticalSpan = performanceKnobs.torrentCriticalPieces || 16
    const prefetchLast = Math.min(first + prefetchSpan, lastFile)
    const criticalLast = Math.min(first + criticalSpan, lastFile)
    try {
      torrent.select(first, lastFile, 6)
      torrent.select(first, prefetchLast, 14)
      torrent.critical(first, criticalLast)
    } catch {
      /* ignore */
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || 'ensureDownloading failed' }
  }
})

ipcMain.handle('torrent:stop', async (_event, infoHash) => {
  if (!torrentClientPromise) return { ok: true }
  try {
    const client = await getTorrentClient()
    const targets = infoHash
      ? client.torrents.filter((t) => t.infoHash === infoHash)
      : [...client.torrents]
    await Promise.all(targets.map((t) => new Promise((resolve) => releaseTorrent(t, resolve))))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || 'Stop failed' }
  }
})
