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
const STREAM_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 JiyuMedia/${APP_VERSION}`
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const DEV_URL = 'http://localhost:5173'

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {WebContentsView | null} */
let webBrowserView = null
let webBrowserAttached = false
let webBrowserVisible = false

/**
 * Hidden BrowserWindow used to clear Cloudflare challenges for scrape fetches.
 * Shares the in-app browser session so a manual visit can unlock the same cookies.
 */
/** @type {BrowserWindow | null} */
let scrapeWindow = null
/** @type {Set<string>} */
const scrapeWarmedOrigins = new Set()

function looksLikeCloudflareChallenge(content, title = '') {
  const sample = `${title}\n${String(content || '').slice(0, 2500)}`
  return (
    /just a moment|cf-browser-verification|attention required|checking your browser|enable javascript and cookies to continue|cdn-cgi\/challenge/i.test(
      sample,
    ) ||
    (/cloudflare/i.test(sample) && /performing security verification|challenge-platform/i.test(sample))
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function destroyScrapeWindow() {
  if (!scrapeWindow || scrapeWindow.isDestroyed()) {
    scrapeWindow = null
    return
  }
  try {
    scrapeWindow.destroy()
  } catch {
    /* ignore */
  }
  scrapeWindow = null
}

function ensureScrapeWindow() {
  if (scrapeWindow && !scrapeWindow.isDestroyed()) return scrapeWindow

  // Reuse the same partition as the in-app web browser so Cloudflare clearance
  // from a normal visit also unlocks background scrapes.
  const scrapeSession = session.fromPartition('persist:jiyu-web')
  scrapeWindow = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    title: 'Jiyu — website check',
    autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: scrapeSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  scrapeWindow.webContents.setUserAgent(BROWSER_UA)
  scrapeWindow.webContents.setBackgroundThrottling(false)
  scrapeWindow.on('closed', () => {
    scrapeWindow = null
  })
  return scrapeWindow
}

async function originAjaxUnlocked(origin) {
  const win = ensureScrapeWindow()
  if (/eztv/i.test(origin)) {
    return Boolean(
      await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${origin}/showlist/ajax/?page=1&letter=all&status=all`)}, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }).then(async (r) => {
          if (!r.ok) return false
          const text = await r.text()
          try {
            const json = JSON.parse(text)
            return Array.isArray(json.shows) && json.shows.length > 0
          } catch {
            return false
          }
        }).catch(() => false)`,
        true,
      ),
    )
  }
  const title = win.webContents.getTitle()
  return !looksLikeCloudflareChallenge('', title) && !/just a moment/i.test(title)
}

async function warmScrapeOrigin(origin, { allowVisible = true } = {}) {
  if (scrapeWarmedOrigins.has(origin)) return true
  const win = ensureScrapeWindow()
  const warmUrl = /eztv/i.test(origin) ? `${origin}/showlist/` : `${origin}/`

  const waitForClearance = async (attempts) => {
    for (let i = 0; i < attempts; i++) {
      if (await originAjaxUnlocked(origin)) return true
      const title = win.webContents.getTitle()
      const hasUi = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('#showlist-table, .letter-filter, a.thread_link, body')) && !/just a moment/i.test(document.title || '')`,
        true,
      ).catch(() => false)
      if (hasUi && !looksLikeCloudflareChallenge('', title) && (await originAjaxUnlocked(origin))) {
        return true
      }
      await sleep(500)
    }
    return false
  }

  try {
    await win.loadURL(warmUrl, { userAgent: BROWSER_UA })
  } catch {
    /* load errors are handled by the wait loop */
  }

  if (await waitForClearance(40)) {
    scrapeWarmedOrigins.add(origin)
    if (win.isVisible()) win.hide()
    return true
  }

  // Interactive Cloudflare checks need a visible window once.
  if (allowVisible) {
    win.setTitle('Jiyu — complete the security check, then this window will close')
    win.show()
    win.focus()
    if (await waitForClearance(120)) {
      scrapeWarmedOrigins.add(origin)
      win.hide()
      return true
    }
    win.hide()
  }
  return false
}

/**
 * Fetch URL text through a real Chromium session (needed for Cloudflare-guarded
 * EZTV HTML / showlist AJAX). Callers should try plain fetch first.
 */
async function fetchViaScrapeBrowser(targetUrl) {
  let origin
  try {
    origin = new URL(targetUrl).origin
  } catch {
    return { ok: false, status: 0, content: '', error: 'Invalid page URL' }
  }

  const win = ensureScrapeWindow()
  const warmed = await warmScrapeOrigin(origin, { allowVisible: true })
  if (!warmed) {
    return {
      ok: false,
      status: 403,
      content: '',
      error:
        'Cloudflare blocked this site. Open it once in Jiyu’s Web Browser tab, finish the check, then sync again.',
    }
  }

  const script = `fetch(${JSON.stringify(targetUrl)}, {
    credentials: 'include',
    headers: { Accept: 'application/json,text/html,*/*;q=0.8' },
  }).then(async (r) => ({
    ok: r.ok,
    status: r.status,
    content: await r.text(),
  })).catch((err) => ({
    ok: false,
    status: 0,
    content: '',
    error: err instanceof Error ? err.message : String(err),
  }))`

  let result = await win.webContents.executeJavaScript(script, true)
  if (
    result &&
    typeof result === 'object' &&
    (!result.ok || looksLikeCloudflareChallenge(result.content))
  ) {
    scrapeWarmedOrigins.delete(origin)
    const rewarmed = await warmScrapeOrigin(origin, { allowVisible: true })
    if (rewarmed) {
      result = await win.webContents.executeJavaScript(script, true)
    }
  }

  if (!result || typeof result !== 'object') {
    return { ok: false, status: 0, content: '', error: 'Browser fetch returned nothing' }
  }
  if (looksLikeCloudflareChallenge(result.content)) {
    return {
      ok: false,
      status: result.status || 403,
      content: result.content || '',
      error:
        'Cloudflare blocked this site. Open it once in Jiyu’s Web Browser tab, finish the check, then sync again.',
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

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
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

  // Block popup windows + guest HTML-fullscreen (YouTube auto-max on play).
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
// Plain fetch first; Cloudflare-guarded hosts fall back to an offscreen Chromium session.
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

    // Cloudflare often answers 403/503 with a challenge page for EZTV HTML/AJAX.
    const hostIsEztv = /(^|\.)eztv[a-z0-9]*\.[a-z.]+$/i.test(host.replace(/^www\./i, ''))
    if (challenged || (hostIsEztv && !response.ok)) {
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
const METADATA_TIMEOUT_MS = 90000
const METADATA_PEER_GRACE_MS = 45000
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
      finish(new Error('Timed out loading torrent metadata or connecting to peers'))
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
    return
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

  // Embedded softsubs: stream ASS events as the torrent file downloads.
  // Publishing cues incrementally avoids waiting for the whole episode.
  const maps = ['0:s:m:language:eng', '0:s:m:language:en', '0:s:0']
  const cues = [...(subtitleCueLists.get(cacheKey) || [])]
  let activeStream = null
  let activeFfmpeg = null

  const killActive = () => {
    try {
      activeStream?.destroy?.()
    } catch {
      /* ignore */
    }
    try {
      if (activeFfmpeg && !activeFfmpeg.killed) activeFfmpeg.kill()
    } catch {
      /* ignore */
    }
    activeStream = null
    activeFfmpeg = null
  }
  subtitleExtractors.set(cacheKey, { kill: killActive })

  const markRetryable = (message) => {
    killActive()
    subtitleExtractors.delete(cacheKey)
    job.done = true
    job.retryable = true
    job.error = message
    // Clear soon so the next player poll can restart extraction.
    setTimeout(() => {
      if (!subtitleCache.has(cacheKey) && subtitleJobs.get(cacheKey)?.retryable) {
        subtitleJobs.delete(cacheKey)
      }
    }, 1500)
  }

  const tryMap = (mapIndex) => {
    if (job.done && !job.retryable) return
    if (mapIndex >= maps.length) {
      const downloaded = Number(file.downloaded) || 0
      const progress = Number(file.progress) || 0
      // FFmpeg often exits empty before the next episode has any pieces — retry later.
      if (downloaded < 5 * 1024 * 1024 && progress < 0.03) {
        markRetryable('Subtitles not ready')
        return
      }
      killActive()
      subtitleExtractors.delete(cacheKey)
      job.done = true
      job.retryable = false
      job.error = 'No subtitle track found'
      return
    }

    killActive()

    let stream
    try {
      stream = file.createReadStream()
    } catch (err) {
      markRetryable(err?.message || 'Could not read video for subtitles')
      return
    }

    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '32M',
        '-analyzeduration',
        '20000000',
        '-i',
        'pipe:0',
        '-map',
        maps[mapIndex],
        '-c:s',
        'ass',
        '-flush_packets',
        '1',
        '-f',
        'ass',
        'pipe:1',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    activeStream = stream
    activeFfmpeg = ffmpeg

    let buf = ''
    let sawCue = false
    stream.on('error', (err) => {
      console.warn('[torrent subs] stream error:', err?.message || err)
    })
    stream.pipe(ffmpeg.stdin)

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
      if (grew) publishSubtitleCues(cacheKey, cues, job)
    })

    ffmpeg.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) console.warn('[torrent subs]', message)
    })

    ffmpeg.once('error', (err) => {
      console.warn('[torrent subs] ffmpeg error:', err?.message || err)
      if (!sawCue) tryMap(mapIndex + 1)
      else {
        publishSubtitleCues(cacheKey, cues, job)
        job.done = true
        subtitleExtractors.delete(cacheKey)
      }
    })

    ffmpeg.once('close', (code) => {
      if (subtitleExtractors.get(cacheKey)?.kill !== killActive) {
        // Aborted in favor of another episode.
        return
      }
      if (!sawCue) {
        tryMap(mapIndex + 1)
        return
      }
      publishSubtitleCues(cacheKey, cues, job)
      subtitleExtractors.delete(cacheKey)
      if (torrentFileMostlyComplete(file)) {
        job.done = true
        job.retryable = false
      } else {
        // Pipe often ends early while the episode is still downloading.
        // Keep the cues we have and resume extraction shortly.
        job.done = false
        job.retryable = true
        console.warn(
          '[torrent subs] extract paused early with',
          cues.length,
          'cues — will resume (file still downloading)',
        )
        setTimeout(() => {
          const current = subtitleJobs.get(cacheKey)
          if (!current || current.done || subtitleExtractors.has(cacheKey)) return
          if (subtitleCache.has(cacheKey) && torrentFileMostlyComplete(file)) {
            current.done = true
            current.retryable = false
            return
          }
          tryMap(0)
        }, 4000)
      }
      if (code && code !== 0) {
        console.warn('[torrent subs] ffmpeg exit', code, `(${cues.length} cues kept)`)
      }
    })
  }

  tryMap(0)
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
        // This endpoint may only read from Jiyu's own local torrent server.
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
  let streamPath = file.streamURL
  if (!streamPath) {
    const encoded = file.path.split(/[\\/]/).map(encodeURIComponent).join('/')
    streamPath = `/webtorrent/${torrent.infoHash}/${encoded}`
  }
  return `http://127.0.0.1:${torrentServerPort}${streamPath}`
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
      if (/(^|[._\-\s[(])(en|eng|english)([._\-\s\])]|$)/i.test(name)) score += 35
      if (/(^|[._\-\s[(])(forced|signs?|songs?)([._\-\s\])]|$)/i.test(name)) score -= 20
      return { file, score }
    })
    .sort((a, b) => b.score - a.score)

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
  const sourceUrl = torrentRawFileUrl(torrent, file)
  if (!AUDIO_TRANSCODE_RE.test(file.name)) return sourceUrl

  const port = await getTranscodeServer()
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

    // Do not select any whole file for background download. WebTorrent's HTTP
    // server requests only the byte ranges the video element reads, so playback
    // begins from available pieces and stops fetching when playback stops.
    for (const f of torrent.files) {
      f.deselect()
    }

    // Prioritize the opening pieces so the player can start as soon as it mounts.
    // The remainder stays on-demand through WebTorrent's range iterator.
    const firstPiece = Math.floor(file.offset / torrent.pieceLength)
    const lastFilePiece = Math.floor((file.offset + file.length - 1) / torrent.pieceLength)
    const criticalLastPiece = Math.min(firstPiece + 8, lastFilePiece)
    const prefetchLastPiece = Math.min(firstPiece + 48, lastFilePiece)
    torrent.select(firstPiece, prefetchLastPiece, 10)
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
    await waitForFileBytes(file, 256 * 1024, 10000)

    // Stop any prior episode's subtitle extractor so it cannot starve playback.
    abortSubtitleExtractors(null)

    const playlist = await Promise.all(
      playlistFiles.map(async (entry) => {
        // Register the sub URL but do NOT start extraction yet — remux needs
        // the opening pieces first or episode switches hang on Buffering.
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
