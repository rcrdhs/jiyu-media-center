const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, powerMonitor } =
  require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const http = require('http')
const { spawn } = require('child_process')
const { promisify } = require('util')

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

loadDotEnvFile(path.join(__dirname, '..', '.env'))
try {
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
const STREAM_UA = `${BROWSER_UA} JiyuMedia/${APP_VERSION}`
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
    const probe = await fetchViaSystemBrowser(
      `${origin}/showlist/ajax/?page=1&letter=all&status=all`,
    )
    if (probe.ok) {
      try {
        const json = JSON.parse(probe.content)
        if (Array.isArray(json.shows) && json.shows.length > 0) return true
      } catch {
        /* continue relaunch */
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

  const warmUrl = /eztv/i.test(origin) ? `${origin}/showlist/` : `${origin}/`
  const profileDir = path.join(app.getPath('userData'), 'cf-system-browser-profile')
  console.log('[cf-unlock] launching system browser', exe, { serverMode: cfServerMode() })

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
    try {
      await page.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    } catch (err) {
      console.log('[cf-unlock] system browser goto', err instanceof Error ? err.message : err)
    }

    // Persistent profile may already be cleared — succeed silently (no dialog).
    if (await probeShowlistAjax(page, origin)) {
      activeSystemBrowser = { browser, page, origin }
      scheduleSystemBrowserIdleClose()
      console.log('[cf-unlock] system browser ready from saved profile')
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

      const ok = await probeShowlistAjax(page, origin)
      console.log('[cf-unlock] system browser probe', { ok, url: page.url() })
      if (ok) {
        activeSystemBrowser = { browser, page, origin }
        scheduleSystemBrowserIdleClose()
        console.log('[cf-unlock] system browser ready — Show List fetches will use Chrome')
        // Minimize (do not close) — closing would drop the CF session the server needs.
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
        return true
      }

      if (!prompted && Date.now() - waitStarted >= 12_000) {
        prompted = true
        if (cfServerMode()) {
          console.log(
            '[cf-unlock] server mode: still blocked — auto-click ran; complete Verify once in Chrome if a checkbox is visible',
          )
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          void dialog.showMessageBox(mainWindow, {
            type: 'info',
            buttons: ['OK'],
            title: 'EZTV security check',
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
  const isEztv = /eztv/i.test(origin)

  // EZTV Show List must use a live system Chrome page. A prior "warmed" flag or
  // a lucky session.fetch must not skip launching Chrome — that produced
  // "System browser not unlocked" during sync.
  if (isEztv) {
    if (activeSystemBrowser?.page && activeSystemBrowser.browser?.connected) {
      if (activeSystemBrowser.origin === origin || !activeSystemBrowser.origin) {
        scrapeWarmedOrigins.add(origin)
        return true
      }
    }
    if (!allowVisible) return false
    console.log('[cf-unlock] EZTV → system Chrome unlock (Electron stealth skipped)')
    eztvElectronSessionOk.delete(origin)
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
 */
async function fetchViaScrapeBrowser(targetUrl) {
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

  const warmed = await warmScrapeOrigin(origin, { allowVisible: true })
  if (!warmed) {
    return {
      ok: false,
      status: 403,
      content: '',
      error:
        'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.',
    }
  }

  if (/eztv/i.test(origin)) {
    let result = await fetchViaSystemBrowser(targetUrl)
    if (!result.ok || looksLikeCloudflareChallenge(result.content)) {
      scrapeWarmedOrigins.delete(origin)
      const rewarmed = await warmScrapeOrigin(origin, { allowVisible: true })
      if (rewarmed) result = await fetchViaSystemBrowser(targetUrl)
    }
    if (looksLikeCloudflareChallenge(result.content)) {
      return {
        ok: false,
        status: result.status || 403,
        content: result.content || '',
        error: 'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.',
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
    const rewarmed = await warmScrapeOrigin(origin, { allowVisible: true })
    if (rewarmed) result = await sessionFetchText(targetUrl)
  }

  if (looksLikeCloudflareChallenge(result.content)) {
    return {
      ok: false,
      status: result.status || 403,
      content: result.content || '',
      error:
        'Cloudflare blocked this site. Complete Verify in the Chrome window, then sync again.',
    }
  }
  return {
    ok: Boolean(result.ok),
    status: result.status || 0,
    content: result.content || '',
    error: result.ok ? '' : result.error || `Server returned ${result.status}`,
  }
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
    destroyWebBrowser()
    destroyScrapeWindow()
    if (mainWindow === win) mainWindow = null
  })

  win.on('resize', () => {
    // Renderer will re-send bounds; keep last bounds if still visible
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

  webBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void webBrowserView.webContents.loadURL(url)
    }
    return { action: 'deny' }
  })

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
  webBrowserView.webContents.on('did-stop-loading', emitNav)
  webBrowserView.webContents.on('page-title-updated', emitNav)
  webBrowserView.webContents.on('dom-ready', emitNav)
  webBrowserView.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (!mainWindow || mainWindow.isDestroyed() || !webBrowserView) return
    mainWindow.webContents.send('browser:nav', {
      url: validatedURL || webBrowserView.webContents.getURL(),
      title: `Failed to load (${errorDescription || errorCode})`,
      canGoBack: navCanGoBack(webBrowserView.webContents),
      canGoForward: navCanGoForward(webBrowserView.webContents),
      loading: false,
    })
  })

  return webBrowserView
}

function applyBounds(view, bounds) {
  if (!bounds) return
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  })
}

function showWebBrowser(bounds) {
  const view = ensureWebBrowser()
  if (!view || !mainWindow || mainWindow.isDestroyed()) return false
  if (!webBrowserAttached) {
    mainWindow.contentView.addChildView(view)
    webBrowserAttached = true
  } else {
    // Re-add to ensure it's the topmost child view
    mainWindow.contentView.addChildView(view)
  }
  applyBounds(view, bounds)
  view.setVisible(true)
  webBrowserVisible = true
  return true
}

function hideWebBrowser(options = {}) {
  const blank = Boolean(options && options.blank)
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
      void contents
        .executeJavaScript(
          `(() => { try { document.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.muted = true; }); } catch (_) {} })();`,
          true,
        )
        .catch(() => {})
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
  loadDotEnvFile(path.join(__dirname, '..', '.env'))
  loadDotEnvFile(path.join(app.getPath('userData'), '.env'))

  recoverCatalogFromLegacyApps()

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
      callback({ requestHeaders: headers })
    })
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
      if (contents.getType?.() !== 'webview') return
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
      } catch {
        /* ignore */
      }
      void contents
        .executeJavaScript(
          `(() => { try { document.exitFullscreen?.(); document.webkitExitFullscreen?.(); } catch (_) {} })();`,
          true,
        )
        .catch(() => {})
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
    const headers = withDesktopChromeClientHints({
      ...details.requestHeaders,
      'User-Agent': STREAM_UA,
    })
    if (!headers.Accept && !headers.accept) headers.Accept = '*/*'
    // CVM Vimeo live: player config + CDN segments expect the official site origin
    if (/vimeocdn\.com|player\.vimeo\.com|vimeo\.com\/live\//i.test(details.url || '')) {
      headers.Referer = 'https://site.cvmtv.com/'
      headers.Origin = 'https://site.cvmtv.com'
    }
    callback({ requestHeaders: headers })
  })

  // Vimeo HLS returns ACAO: https://vimeo.com — rewrite so hls.js in the app can preview/play
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || ''
    if (!/vimeocdn\.com|player\.vimeo\.com/i.test(url)) {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

ipcMain.handle('app:getVersion', async () => APP_VERSION)

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
 * TMDB TV lists with IMDb ids.
 * kind: 'popular' (discover 2010+) | 'on_the_air' (currently airing)
 * Key from .env — never sent to the renderer except as results.
 */
async function fetchTmdbTvCatalog(kind = 'popular', limit = 3000) {
  const apiKey = process.env.TMDB_API_KEY || process.env.TMDB_KEY || ''
  if (!apiKey) {
    return { ok: false, shows: [], error: 'TMDB_API_KEY missing from .env' }
  }
  const mode = kind === 'on_the_air' ? 'on_the_air' : 'popular'
  const defaultLimit = mode === 'on_the_air' ? 500 : 3000
  const target = Math.max(1, Math.min(5000, Number(limit) || defaultLimit))
  const pageSize = 20
  const pagesNeeded = Math.ceil(target / pageSize)
  const shows = []
  try {
    await awaitTmdbFetchControl()
    emitTmdbProgress({ phase: 'discover', kind: mode, page: 0, pagesNeeded, done: 0, total: target })
    for (let page = 1; page <= pagesNeeded; page += 1) {
      await awaitTmdbFetchControl()
      const url =
        mode === 'on_the_air'
          ? new URL('https://api.themoviedb.org/3/tv/on_the_air')
          : new URL('https://api.themoviedb.org/3/discover/tv')
      url.searchParams.set('api_key', apiKey)
      url.searchParams.set('language', 'en-US')
      url.searchParams.set('page', String(page))
      if (mode === 'popular') {
        url.searchParams.set('sort_by', 'popularity.desc')
        url.searchParams.set('first_air_date.gte', '2010-01-01')
        url.searchParams.set('include_null_first_air_dates', 'false')
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
      shows.push(...results)
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
    const top = shows.slice(0, target)
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
        out[idx] = {
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
        }
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
ipcMain.handle('tmdb:tvCatalog', async (_event, kind, limit) => fetchTmdbTvCatalog(kind, limit))
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

ipcMain.handle('browser:setBounds', async (_event, bounds) => {
  if (!webBrowserView || !bounds) return false
  applyBounds(webBrowserView, bounds)
  return true
})

ipcMain.handle('browser:navigate', async (_event, url) => {
  const target = normalizeBrowserUrl(url)
  if (!target) return { ok: false, error: 'Invalid URL' }
  const view = ensureWebBrowser()
  if (!view) return { ok: false, error: 'Browser unavailable' }
  if (!webBrowserAttached || !webBrowserVisible) showWebBrowser()
  try {
    // Start navigation immediately — do not wait for YouTube to finish loading
    // (loadURL can take many seconds and made PiP feel broken/slow).
    void view.webContents.loadURL(target).catch((err) => {
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

ipcMain.handle('browser:execute', async (_event, code) => {
  if (!webBrowserView || webBrowserView.webContents.isDestroyed()) {
    return { ok: false, error: 'Browser unavailable' }
  }
  try {
    const result = await webBrowserView.webContents.executeJavaScript(String(code || ''), true)
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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

ipcMain.handle('desktop:isDesktop', async () => true)

ipcMain.handle('app:quit', () => {
  app.quit()
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
ipcMain.handle('cf:closeSystemBrowser', async (_event, options) => {
  const soon = !options || options.soon !== false
  if (soon) scheduleSystemBrowserCloseSoon(options?.reason || 'requested')
  else closeActiveSystemBrowser()
  return { ok: true }
})

// Fetch an HTML/JSON page as if from a real browser (for torrent-site scraping).
// Plain fetch first; Cloudflare-guarded EZTV HTML uses the Chrome helper.
ipcMain.handle('page:fetchHtml', async (_event, url) => {
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
    } catch {
      return { ok: false, status: 0, content: '', error: 'Invalid page URL' }
    }

    // Show List / show pages are CF-bound. /api/get-torrents stays on plain fetch.
    if (eztvNeedsSystemBrowser(target)) {
      return await fetchViaScrapeBrowser(target)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(target, {
        redirect: 'follow',
        signal: controller.signal,
        headers: withDesktopChromeClientHints({
          'User-Agent': BROWSER_UA,
          Accept: isEztvApiPath(target)
            ? 'application/json,text/plain,*/*'
            : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Upgrade-Insecure-Requests': '1',
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

    // API-only sync must never open Chrome — return the failure as-is.
    if (isEztvApiPath(target)) {
      return {
        ok: false,
        status: response.status,
        content,
        error: challenged
          ? 'EZTV API looked blocked (unexpected)'
          : `Server returned ${response.status}`,
      }
    }

    if (challenged || !response.ok) {
      return await fetchViaScrapeBrowser(target)
    }

    return {
      ok: false,
      status: response.status,
      content,
      error: `Server returned ${response.status}`,
    }
  } catch (err) {
    const failedUrl = String(url || '').trim()
    if (isEztvApiPath(failedUrl)) {
      return {
        ok: false,
        status: 0,
        content: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    try {
      return await fetchViaScrapeBrowser(failedUrl)
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
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 JiyuMedia/${APP_VERSION}`,
    Accept: '*/*',
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

  const looksHls = /\.m3u8(\?|$)/i.test(target) || /[?&]output=hls\b/i.test(target)

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
        try {
          torrent.destroy()
        } catch {
          /* ignore */
        }
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
    roots.push(path.join(os.tmpdir(), 'webtorrent'))
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

function scheduleSubtitleExtractWhenReady(file, cacheKey) {
  if (!file || !cacheKey) return
  subtitleSources.set(cacheKey, file)
  if (subtitleExtractDeferred.has(cacheKey)) return
  const timer = setTimeout(() => {
    subtitleExtractDeferred.delete(cacheKey)
    const source = subtitleSources.get(cacheKey) || file
    startProgressiveSubtitleExtract(source, cacheKey)
  }, 8_000)
  subtitleExtractDeferred.set(cacheKey, timer)
}

function startProgressiveSubtitleExtract(file, cacheKey) {
  if (!file) return
  subtitleSources.set(cacheKey, file)

  const downloaded = Number(file.downloaded) || 0
  const progress = Number(file.progress) || 0
  // Slow swarms: remux needs the head pieces first. Defer ffmpeg probe/extract
  // so "Subs..." polling cannot starve playback into a load timeout.
  if (downloaded < SUBTITLE_EXTRACT_MIN_BYTES && progress < 0.12) {
    console.log('[torrent subs] defer extract (need buffer first)', {
      file: file.name,
      downloaded,
      need: SUBTITLE_EXTRACT_MIN_BYTES,
    })
    scheduleSubtitleExtractWhenReady(file, cacheKey)
    return
  }

  const existing = subtitleJobs.get(cacheKey)
  if (existing && !existing.done && subtitleExtractors.has(cacheKey)) return
  if (existing?.done && !existing.retryable && existing.error && !subtitleCache.has(cacheKey)) {
    // Allow another attempt once more of the file has arrived, or when a prior
    // HTTP-only probe falsely reported "no subtitle track" but disk now has the file.
    const local = resolveTorrentFileDiskPath(file)
    let localSize = 0
    try {
      localSize = local ? fs.statSync(local).size : 0
    } catch {
      localSize = 0
    }
    const retryFalseNegative =
      /no subtitle track/i.test(String(existing.error || '')) && localSize >= 12 * 1024 * 1024
    if (downloaded < 8 * 1024 * 1024 || retryFalseNegative) {
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
      // HTTP probes often miss softsubs; only declare missing after a large on-disk probe.
      const probedDisk = path.isAbsolute(String(probeSource))
      if (!probedDisk || localSize < 20 * 1024 * 1024 || progress < 0.35) {
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

/** Wait for torrent pieces near a mid-title -ss seek so ffmpeg doesn't emit an empty MP4. */
async function waitForRemuxSeekPoint(source, startAtSec) {
  if (!source || !(startAtSec >= 1)) return
  try {
    const u = new URL(source)
    const m = /^\/torrent-file\/([a-f0-9]{40})\/(\d+)\/?/i.exec(u.pathname)
    if (!m) return
    const client = await getTorrentClient()
    const got = client.get(m[1].toLowerCase())
    const torrent = got && typeof got.then === 'function' ? await got : got
    const file = torrent?.files?.[Number(m[2])]
    if (!file || !file.length) return
    // Rough byte offset from a ~2h title; clamp so we never ask past EOF.
    const assumedDuration = Math.max(startAtSec + 45 * 60, 2 * 60 * 60)
    const offset = Math.min(
      Math.max(0, Number(file.length) - 1),
      Math.floor((startAtSec / assumedDuration) * Number(file.length)),
    )
    console.log('[torrent audio] waiting for seek point', {
      startAtSec: Math.floor(startAtSec),
      offset,
      file: file.name,
    })
    await waitForTorrentFileBytesAt(file, offset, 90_000)
  } catch (err) {
    console.warn('[torrent audio] seek wait failed', err?.message || err)
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

  // Resume / mid-title continue: wait for pieces first. Seeking into a hole
  // made ffmpeg exit with "Output file is empty" and the player fall back to t=0.
  if (startAt >= 1) {
    await waitForRemuxSeekPoint(source, startAt)
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
  args.push('-map', '0:v:0', '-map', `0:a:${audioOrdinal}?`)
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
  const sourceFile = subtitleSources.get(cacheKey)
  const existing = subtitleJobs.get(cacheKey)
  const downloaded = Number(sourceFile?.downloaded) || 0
  const progress = Number(sourceFile?.progress) || 0
  const bufferReady = downloaded >= SUBTITLE_EXTRACT_MIN_BYTES || progress >= 0.12
  // Only kick extract from HTTP once the opening buffer exists — otherwise
  // Player's sub poll storm competes with remux on a 1-peer swarm.
  if (sourceFile && bufferReady) {
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
function waitForTorrentFileBytesAt(file, byteOffset, timeoutMs = 45000) {
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

  const baseline = Number(file.downloaded) || 0
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (
        (hasPiece(first) && hasPiece(Math.min(first + 1, last))) ||
        (Number(file.downloaded) || 0) >= baseline + 512 * 1024
      ) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
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
        try {
          other.destroy({ destroyStore: true })
        } catch {
          /* ignore */
        }
      }
    } else {
      const others = client.torrents.filter((t) => !hash || t.infoHash !== hash)
      const overflow = others.length + 1 - MAX_CONCURRENT_TORRENTS
      if (overflow > 0) {
        for (const other of others.slice(0, overflow)) {
          try {
            other.destroy({ destroyStore: true })
          } catch {
            /* ignore */
          }
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
            if (existing) existing.destroy({ destroyStore: true })
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
      if (addedHere) torrent.destroy()
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
      try {
        torrent.destroy({ destroyStore: true })
      } catch {
        /* ignore */
      }
      const announce = announceListForTorrent(uri)
      console.log('[torrent] add', {
        fromCache: false,
        announceCount: announce.length,
        infoHash: hash,
        retry: 'magnet',
      })
      try {
        const added = client.add(magnetWithDefaultTrackers(uri), {
          destroyStoreOnDestroy: true,
          announce,
          strategy: 'sequential',
        })
        torrent = await waitForTorrentReady(added, MAGNET_RETRY_READY_MS)
        prepared = await selectAndProbe(torrent, { probeMs: PEER_PROBE_RETRY_MS })
        if (!prepared.ok) {
          torrent.destroy()
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
      if (addedHere) torrent.destroy()
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
      }
    } catch (err) {
      console.warn('[torrent] runtime probe failed', err?.message || err)
    }

    // Let remux attach and buffer first — early softsub extract steals the same
    // HTTP/torrent pieces and commonly stalls 1080p MKV starts past 25s.
    const primarySubKey = `${torrent.infoHash}:${file.path || file.name}`
    if (playlist[0]?.subtitleUrl) {
      // Wait for a real head buffer before softsub extract (was 12s — too early
      // on slow SubsPlease swarms and caused player load timeouts).
      setTimeout(() => {
        const sourceFile = subtitleSources.get(primarySubKey)
        if (sourceFile) startProgressiveSubtitleExtract(sourceFile, primarySubKey)
      }, 45_000)
    }

    // Single-play: drop leftover swarms after this one is ready. Multi-view keeps them.
    if (!keepOthers && torrent.infoHash) {
      for (const other of [...client.torrents]) {
        if (other.infoHash !== torrent.infoHash) {
          try {
            other.destroy({ destroyStore: true })
          } catch {
            /* ignore */
          }
        }
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
    await Promise.all(
      targets.map(
        (t) =>
          new Promise((resolve) => {
            client.remove(t.infoHash, { destroyStore: true }, () => resolve())
          }),
      ),
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || 'Stop failed' }
  }
})
