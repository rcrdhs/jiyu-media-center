const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const http = require('http')
const { spawn } = require('child_process')
const { promisify } = require('util')

const gunzipAsync = promisify(zlib.gunzip)

const isDev = !app.isPackaged

/** Keep in lockstep with package.json (also injected into the UI as __JIYU_VERSION__). */
let APP_VERSION = '0.3.0'
try {
  APP_VERSION = require('../package.json').version || APP_VERSION
} catch {
  /* packaged layouts still expose app.getVersion() below */
}
// Must match Electron's embedded Chromium — a stale Chrome/122 UA makes
// Cloudflare invalidate the Verify widget as soon as the real mouse moves.
const CHROME_VERSION = process.versions.chrome || '122.0.0.0'
const BROWSER_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
const STREAM_UA = `${BROWSER_UA} JiyuMedia/${APP_VERSION}`
const DEV_URL = 'http://localhost:5173'
const WEB_SESSION = 'persist:jiyu-web'

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
      headers: {
        // Prefer the session's real Chromium UA (Client Hints stay consistent).
        'User-Agent': ses
          .getUserAgent()
          .replace(/\s*Electron\/[\d.]+/i, '')
          .replace(/\s*jiyu-media-center\/[\d.]+/i, '')
          .replace(/\s*JiyuMedia\/[\d.]+/i, ''),
        Accept: 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
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

function closeActiveSystemBrowser() {
  const current = activeSystemBrowser
  activeSystemBrowser = null
  if (!current?.browser) return
  void current.browser.close().catch(() => {})
}

/**
 * @param {string} targetUrl
 */
/** @type {ReturnType<typeof setTimeout> | null} */
let systemBrowserIdleTimer = null

function scheduleSystemBrowserIdleClose() {
  if (systemBrowserIdleTimer) clearTimeout(systemBrowserIdleTimer)
  // Keep Chrome around for the multi-page Show List sync, then close.
  systemBrowserIdleTimer = setTimeout(() => {
    console.log('[cf-unlock] closing idle system browser')
    closeActiveSystemBrowser()
    for (const origin of [...scrapeWarmedOrigins]) {
      if (/eztv/i.test(origin)) scrapeWarmedOrigins.delete(origin)
    }
  }, 20 * 60 * 1000)
}

async function fetchViaSystemBrowser(targetUrl) {
  const active = activeSystemBrowser
  if (!active?.page || !active.browser?.connected) {
    return { ok: false, status: 0, content: '', error: 'System browser not unlocked' }
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
  console.log('[cf-unlock] launching system browser', exe)

  if (mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['OK'],
      title: 'EZTV security check',
      message: 'Complete Verify in Chrome/Edge',
      detail:
        'Cloudflare cannot finish inside Jiyu’s own window.\n\nA Chrome window will open on eztvx.to — click “Verify you are human” there. Leave Chrome open while Jiyu fills the full TV Series library; it will close when sync finishes.',
    })
  }

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

    const ajaxUrl = `${origin}/showlist/ajax/?page=1&letter=all&status=all`
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (!browser.connected) {
        console.log('[cf-unlock] system browser closed by user')
        return false
      }
      let ok = false
      try {
        ok = await page.evaluate(async (url) => {
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
        ok = false
      }

      console.log('[cf-unlock] system browser probe', { ok, url: page.url() })
      if (ok) {
        activeSystemBrowser = { browser, page, origin }
        console.log('[cf-unlock] system browser ready — Show List fetches will use Chrome')
        // Minimize so it doesn't block the desktop during the long sync.
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
  if (scrapeWarmedOrigins.has(origin)) return true

  if (await originAjaxUnlocked(origin, { verbose: true })) {
    scrapeWarmedOrigins.add(origin)
    return true
  }

  if (!allowVisible) return false

  // EZTV: Electron cannot complete Cloudflare (WebGL). Use real Chrome/Edge
  // and keep that browser for Show List fetches (do not rely on cookie copy).
  if (/eztv/i.test(origin)) {
    const unlocked = await warmViaSystemBrowser(origin)
    if (unlocked) {
      scrapeWarmedOrigins.add(origin)
      return true
    }
    return false
  }

  // Drop stale clearance for non-EZTV interactive unlock.
  await clearCfCookies(origin)

  // Non-EZTV fallback: plain in-app window (rarely needed).
  if (unlockWindow && !unlockWindow.isDestroyed()) {
    const unlocked = await waitForManualUnlock(unlockWindow, origin, 180_000)
    if (unlocked) {
      scrapeWarmedOrigins.add(origin)
      destroyUnlockWindow()
      return true
    }
    destroyUnlockWindow()
    return false
  }

  const warmUrl = `${origin}/`
  const ses = webSession()
  unlockWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'Jiyu — click Verify you are human (window closes when done)',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  const win = unlockWindow
  win.on('closed', () => {
    if (unlockWindow === win) unlockWindow = null
  })
  win.focus()
  try {
    await win.loadURL(warmUrl)
  } catch {
    /* ignore */
  }

  const unlocked = await waitForManualUnlock(win, origin, 180_000)
  destroyUnlockWindow()
  if (unlocked) {
    scrapeWarmedOrigins.add(origin)
    return true
  }
  return false
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
  recoverCatalogFromLegacyApps()

  // Strip Electron + app-name tokens from the shared web session UA. Logs showed
  // `jiyu-media-center/0.3.0` in the UA, which Cloudflare treats as non-browser.
  try {
    const ses = webSession()
    const ua = ses
      .getUserAgent()
      .replace(/\s*Electron\/[\d.]+/i, '')
      .replace(/\s*jiyu-media-center\/[\d.]+/i, '')
      .replace(/\s*JiyuMedia\/[\d.]+/i, '')
    ses.setUserAgent(ua)
    console.log('[cf-unlock] session UA =', ua)
  } catch {
    /* ignore */
  }

  // Block popup windows + guest HTML-fullscreen (YouTube auto-max on play).
  // Cloudflare Turnstile MUST be allowed to open challenge windows — denying
  // every window.open left EZTV stuck on "Verifying…" after clicking Verify.
  app.on('web-contents-created', (_event, contents) => {
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

  // Many IPTV CDNs reject Electron's default UA or empty clients
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders, 'User-Agent': STREAM_UA }
    if (!headers.Accept) headers.Accept = '*/*'
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

// Fetch an HTML/JSON page as if from a real browser (for torrent-site scraping).
// Plain fetch first; EZTV always goes through the unlocked system Chrome helper.
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

    const hostIsEztv = /(^|\.)eztv[a-z0-9]*\.[a-z.]+$/i.test(host.replace(/^www\./i, ''))
    // EZTV Show List / HTML is CF-bound to the Chrome session — never use plain fetch.
    if (hostIsEztv) {
      return await fetchViaScrapeBrowser(target)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(target, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Upgrade-Insecure-Requests': '1',
        },
      })
    } finally {
      clearTimeout(timer)
    }

    const content = await response.text()
    const challenged = looksLikeCloudflareChallenge(content)
    if (response.ok && !challenged) {
      return { ok: true, status: response.status, content, error: '' }
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
    try {
      return await fetchViaScrapeBrowser(String(url || '').trim())
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
  const concurrency = 24
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
      const client = new WebTorrent({ utp: false, maxConns: 100 })
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
/** Only used to spot clearly dead swarms — never wait on bytes before play. */
const PEER_PROBE_MS = 4000
const DEFAULT_TORRENT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
]

function magnetWithDefaultTrackers(magnet) {
  let out = magnet.trim()
  for (const tracker of DEFAULT_TORRENT_TRACKERS) {
    const encoded = encodeURIComponent(tracker)
    if (out.includes(encoded) || out.includes(tracker)) continue
    out += `${out.includes('?') ? '&' : '?'}tr=${encoded}`
  }
  return out
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
          'No peers found for this episode — it may be dead. Try another episode or a more popular title.',
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
// video with no sound. Video is copied; only audio is re-encoded to AAC.
const AUDIO_TRANSCODE_RE = /\.(mp4|m4v|mov|mkv|avi|ts|mts|m2ts|mpg|mpeg)$/i
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

/** Parse `ffmpeg -i` stderr into subtitle stream descriptors. */
function parseFfmpegSubtitleStreams(stderr) {
  const tracks = []
  const lines = String(stderr || '').split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const stream = /^\s*Stream #0:(\d+)(?:\(([^)]*)\))?: Subtitle:\s*([^\s,(]+)/i.exec(line)
    if (stream) {
      if (current) tracks.push(current)
      current = {
        index: Number(stream[1]),
        language: (stream[2] || '').trim().toLowerCase(),
        codec: stream[3].trim().toLowerCase(),
        title: '',
        isDefault: /\(default\)/i.test(line),
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
 * Probe subtitle streams on a local WebTorrent HTTP URL via ffmpeg -i.
 * @returns {Promise<Array<{ index: number, language: string, codec: string, title: string, isDefault: boolean }>>}
 */
function probeSubtitleTracks(httpSource) {
  return new Promise((resolve) => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath || !httpSource) {
      resolve([])
      return
    }
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-probesize',
        '16M',
        '-analyzeduration',
        '15000000',
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
      resolve(parseFfmpegSubtitleStreams(stderr))
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
    // Keep successful caches; allow incomplete jobs to be restarted later.
    if (!job) continue
    if (!subtitleCache.has(key)) {
      subtitleJobs.delete(key)
    } else {
      job.done = true
      job.retryable = false
    }
  }
}

function startProgressiveSubtitleExtract(file, cacheKey) {
  if (!file) return
  subtitleSources.set(cacheKey, file)

  const existing = subtitleJobs.get(cacheKey)
  if (existing && !existing.done && subtitleExtractors.has(cacheKey)) return
  if (existing?.done && !existing.retryable && existing.error && !subtitleCache.has(cacheKey)) {
    // Allow another attempt once more of the file has arrived.
    if ((Number(file.downloaded) || 0) < 8 * 1024 * 1024) {
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

  const extractTrack = (track) => {
    if (!httpSource || !track) {
      markRetryable('Subtitle source URL missing')
      return
    }
    selectedTrack = track
    killActive()
    console.log('[torrent subs] extracting track', {
      index: track.index,
      language: track.language || 'und',
      codec: track.codec,
      title: track.title || '',
      score: scoreSubtitleTrack(track),
    })

    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '16M',
        '-analyzeduration',
        '15000000',
        '-i',
        httpSource,
        '-map',
        `0:${track.index}`,
        '-c:s',
        'ass',
        '-flush_packets',
        '1',
        '-f',
        'ass',
        'pipe:1',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    activeFfmpeg = ffmpeg
    let buf = ''
    let sawCue = false

    ffmpeg.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      let grew = false
      for (const line of lines) {
        const cue = parseAssDialogueLine(line)
        if (!cue) continue
        cues.push(cue)
        sawCue = true
        grew = true
      }
      if (grew) {
        publishSubtitleCues(cacheKey, cues, job)
        console.log('[torrent subs] cues', job.cueCount)
      }
    })

    ffmpeg.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) console.warn('[torrent subs]', message)
    })

    ffmpeg.once('error', (err) => {
      console.warn('[torrent subs] ffmpeg error:', err?.message || err)
      if (!sawCue) markRetryable(err?.message || 'Subtitle extract failed')
      else {
        publishSubtitleCues(cacheKey, cues, job)
        job.done = true
        subtitleExtractors.delete(cacheKey)
      }
    })

    ffmpeg.once('close', (code) => {
      if (subtitleExtractors.get(cacheKey)?.kill !== killActive) return
      if (!sawCue) {
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
      if (torrentFileMostlyComplete(file)) {
        job.done = true
        job.retryable = false
      } else {
        job.done = false
        job.retryable = true
        console.warn('[torrent subs] extract paused early with', cues.length, 'cues — will resume')
        setTimeout(() => {
          const current = subtitleJobs.get(cacheKey)
          if (!current || current.done || subtitleExtractors.has(cacheKey)) return
          if (subtitleCache.has(cacheKey) && torrentFileMostlyComplete(file)) {
            current.done = true
            current.retryable = false
            return
          }
          if (selectedTrack) extractTrack(selectedTrack)
        }, 4000)
      }
      if (code && code !== 0) {
        console.warn('[torrent subs] ffmpeg exit', code, `(${cues.length} cues kept)`)
      }
    })
  }

  void (async () => {
    if (!httpSource) {
      markRetryable('Subtitle source URL missing')
      return
    }
    const downloaded = Number(file.downloaded) || 0
    const progress = Number(file.progress) || 0
    if (downloaded < 2 * 1024 * 1024 && progress < 0.02) {
      markRetryable('Subtitles not ready')
      return
    }

    const tracks = await probeSubtitleTracks(httpSource)
    if (subtitleExtractors.get(cacheKey)?.kill !== killActive) return

    console.log(
      '[torrent subs] probed',
      tracks.map((t) => ({
        index: t.index,
        lang: t.language || 'und',
        codec: t.codec,
        title: t.title || '',
        score: scoreSubtitleTrack(t),
      })),
    )

    if (tracks.length === 0) {
      if (downloaded < 10 * 1024 * 1024 && progress < 0.1) {
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

function handleAudioTranscode(req, res, source) {
  let startAt = 0
  let exact = false
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    startAt = Math.max(0, Number(url.searchParams.get('t')) || 0)
    exact = url.searchParams.get('exact') === '1'
  } catch {
    startAt = 0
    exact = false
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

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
  })

  // Video is stream-copied; audio is re-encoded to AAC for Chromium.
  // Softsubs stay on the VTT overlay (ffmpeg subtitles filter can't reliably
  // read progressive HTTP torrent sources).
  //
  // A/V sync notes:
  // - Never use input-only -ss with -c:v copy (video lands on a keyframe,
  //   audio on the exact time → permanent offset).
  // - Don't use aresample=async=* — continuous stretch drifts against copied
  //   video timestamps in fragmented MP4.
  // - muxdelay/muxpreload 0 also breaks interleaving for fMP4 in Chromium.
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-fflags',
    '+genpts+igndts',
    '-probesize',
    exact ? '5M' : '2M',
    '-analyzeduration',
    exact ? '5000000' : '2000000',
  ]
  if (startAt >= 1) {
    // Coarse input seek for speed, then a short accurate output seek so
    // copied video and re-encoded audio share the same cut point.
    // exact=1 (Skip Intro): decode-seek only for frame-accurate cut.
    if (exact) {
      args.push('-i', source, '-ss', startAt.toFixed(3))
    } else {
      const coarse = Math.max(0, startAt - 3)
      if (coarse >= 1) args.push('-ss', coarse.toFixed(3))
      args.push('-i', source, '-ss', (startAt - coarse).toFixed(3))
    }
  } else {
    args.push('-i', source)
  }
  args.push(
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
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
  if (sourceFile && (!existing || (existing.done && existing.retryable))) {
    startProgressiveSubtitleExtract(sourceFile, cacheKey)
  } else if (sourceFile && !existing) {
    startProgressiveSubtitleExtract(sourceFile, cacheKey)
  }

  // Give the new episode's extractor a moment to publish the first cues.
  for (let attempt = 0; attempt < 12; attempt += 1) {
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
    const stream = file.createReadStream({ start, end })
    stream.on('error', (err) => {
      console.warn('[torrent file]', err?.message || err)
      if (!res.writableEnded) res.end()
    })
    stream.pipe(res)
    res.on('close', () => {
      try {
        stream.destroy?.()
      } catch {
        /* ignore */
      }
    })
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
        handleAudioTranscode(req, res, source)
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

async function torrentFilePlaybackUrl(torrent, file) {
  // Ensure index-based /torrent-file URLs are available before building source.
  await getTranscodeServer()
  const sourceUrl = torrentRawFileUrl(torrent, file)
  if (!AUDIO_TRANSCODE_RE.test(file.name)) return sourceUrl

  const port = transcodeServerPort
  return `http://127.0.0.1:${port}/stream.mp4?source=${encodeURIComponent(sourceUrl)}`
}

ipcMain.handle('torrent:stream', async (_event, input) => {
  try {
    if (typeof input !== 'string') {
      return { ok: false, error: 'Invalid torrent link' }
    }
    const uri = input.trim()
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

    // Drop other active torrents first so a stuck prior episode cannot starve
    // metadata / peers for the one the user just clicked.
    for (const other of [...client.torrents]) {
      if (hash && other.infoHash === hash) continue
      try {
        other.destroy({ destroyStore: true })
      } catch {
        /* ignore */
      }
    }

    if (!torrent) {
      addedHere = true
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
      } else if (hash) {
        // Magnets often stall waiting for metadata peers; pull the .torrent first.
        const cached = await fetchTorrentMetadataByHash(hash)
        if (cached) torrentId = cached
      }

      const added = client.add(torrentId, {
        destroyStoreOnDestroy: true,
        announce: DEFAULT_TORRENT_TRACKERS,
        strategy: 'sequential',
      })
      torrent = await waitForTorrentReady(added)
    } else if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
      torrent = await waitForTorrentReady(torrent)
    }

    const files = [...torrent.files].sort((a, b) => b.length - a.length)
    const playlistFiles = playableTorrentFiles(torrent)
    const file = playlistFiles[0]
    if (!file) {
      if (addedHere) torrent.destroy()
      return {
        ok: false,
        error: `Torrent has no playable video file (largest file: ${files[0]?.name ?? 'none'})`,
      }
    }

    // Deselect extras, then fully select the active video so WebTorrent keeps
    // downloading ahead of the remux. Range-only selection was starving mid-play
    // (endless Chromium spinner once the small head buffer ran out).
    for (const f of torrent.files) {
      f.deselect()
    }
    try {
      file.select()
    } catch {
      /* ignore */
    }

    const firstPiece = Math.floor(file.offset / torrent.pieceLength)
    const lastFilePiece = Math.floor((file.offset + file.length - 1) / torrent.pieceLength)
    const criticalLastPiece = Math.min(firstPiece + 16, lastFilePiece)
    // Hot-start a larger opening window; sequential strategy fills the rest.
    const prefetchLastPiece = Math.min(firstPiece + 120, lastFilePiece)
    torrent.select(firstPiece, lastFilePiece, 5)
    torrent.select(firstPiece, prefetchLastPiece, 12)
    torrent.critical(firstPiece, criticalLastPiece)

    // Keep companion subtitle files selected — they are tiny and needed for softsubs.
    for (const entry of playlistFiles) {
      const companion = findCompanionSubtitle(torrent, entry)
      if (companion) {
        try {
          companion.select()
        } catch {
          /* ignore */
        }
      }
    }

    // Hand the URL to the player immediately. Only bail early when the swarm
    // is clearly empty after a short probe — never block on downloaded bytes.
    if (torrent.downloaded === 0 && torrent.numPeers === 0) {
      const foundPeer = await new Promise((resolve) => {
        const deadline = setTimeout(() => finish(false), PEER_PROBE_MS)
        const poll = setInterval(() => {
          if (torrent.downloaded > 0 || torrent.numPeers > 0) finish(true)
        }, 200)
        function finish(ok) {
          clearTimeout(deadline)
          clearInterval(poll)
          resolve(ok)
        }
      })
      if (!foundPeer) {
        if (addedHere) torrent.destroy()
        return {
          ok: false,
          error: 'No seeds found — this torrent appears to be dead. Try another link.',
        }
      }
    }

    // Give the remux a head start on opening bytes before competing readers attach.
    await waitForFileBytes(file, 2 * 1024 * 1024, 30000)

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

    // Let remux attach first, then pull softsubs over the same local HTTP file URL.
    const primarySubKey = `${torrent.infoHash}:${file.path || file.name}`
    if (playlist[0]?.subtitleUrl) {
      setTimeout(() => {
        const sourceFile = subtitleSources.get(primarySubKey)
        if (sourceFile) startProgressiveSubtitleExtract(sourceFile, primarySubKey)
      }, 2000)
    }

    // Drop other torrents in the background so the next play stays lean.
    if (torrent.infoHash) {
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
