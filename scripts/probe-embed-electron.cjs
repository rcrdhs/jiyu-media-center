/**
 * Load a Streamed embed.st URL in Electron with Referer stripped (Jiyu path).
 * Usage: node scripts/run-embed-probe.cjs
 * Or: electron scripts/probe-embed-electron.cjs <embedUrl>
 */
const { app, BrowserWindow, session } = require('electron')

const EMBED =
  process.argv[2] ||
  'https://embed.st/embed/delta/live-event_dana-white-s-contender-series-season-10-week-5-live-stream/1'

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('probe-embed')
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    try {
      const host = new URL(details.url).hostname.replace(/^www\./i, '').toLowerCase()
      if (
        (host === 'embed.st' || host.endsWith('.embed.st')) &&
        (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')
      ) {
        delete headers.Referer
        delete headers.referer
      }
    } catch {
      /* ignore */
    }
    callback({ requestHeaders: headers })
  })

  const win = new BrowserWindow({
    width: 960,
    height: 540,
    show: true,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )

  const mediaHits = []
  ses.webRequest.onCompleted((details) => {
    if (/strmd\.st|m3u8|\.ts\b|embed\.st\/.*stream/i.test(details.url)) {
      mediaHits.push({ status: details.statusCode, url: details.url.slice(0, 100) })
    }
  })
  ses.webRequest.onErrorOccurred((details) => {
    if (/strmd\.st|m3u8|embed\.st/i.test(details.url)) {
      mediaHits.push({ error: details.error, url: details.url.slice(0, 100) })
    }
  })

  await win.loadURL(EMBED)
  await new Promise((r) => setTimeout(r, 4000))
  const htmlLen = await win.webContents.executeJavaScript(
    `document.documentElement.outerHTML.length`,
  )
  await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    const btn = document.querySelector(
      '.vjs-big-play-button, .play-wrapper, button[aria-label*="Play" i], #player, .jw-icon-display, .vjs-poster'
    );
    try { btn && btn.click(); } catch (_) {}
    try { document.getElementById('player')?.click(); } catch (_) {}
    try {
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    } catch (_) {}
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 20000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return {
      htmlLen: document.documentElement.outerHTML.length,
      ready: v && v.readyState,
      paused: v && v.paused,
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      t: v && v.currentTime,
      text: (document.body && document.body.innerText || '').slice(0, 120),
    };
  })()`)
  console.log(JSON.stringify({ embed: EMBED, htmlLenAtLoad: htmlLen, afterPlay: state, mediaHits: mediaHits.slice(-12) }))
  app.exit(state && state.w > 0 ? 0 : 2)
})

app.on('window-all-closed', () => app.exit(0))
