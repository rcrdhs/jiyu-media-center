/**
 * Probe PPV.st → embedindia.st playback path (Referer + media).
 */
const { app, BrowserWindow, session } = require('electron')

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

async function pickLiveEmbed() {
  const api = await (
    await fetch('https://api.ppv.st/api/streams', {
      headers: { Accept: 'application/json', Referer: 'https://ppv.st/' },
    })
  ).json()
  const now = Math.floor(Date.now() / 1000)
  for (const cat of api.streams || []) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      return {
        name: s.name,
        iframe: s.iframe,
        page: s.uri_name ? `https://ppv.st/live/${s.uri_name}` : 'https://ppv.st/',
      }
    }
  }
  return null
}

app.whenReady().then(async () => {
  const pick = await pickLiveEmbed()
  if (!pick) {
    console.log(JSON.stringify({ ok: false, error: 'no live ppv embed' }))
    app.exit(2)
    return
  }

  const mode = process.argv[2] || 'with-ref' // with-ref | no-ref
  const ses = session.fromPartition(`probe-ppv-${mode}`)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    try {
      const host = new URL(details.url).hostname.replace(/^www\./i, '').toLowerCase()
      if (host === 'embedindia.st' || host.endsWith('.embedindia.st')) {
        if (mode === 'no-ref') {
          delete headers.Referer
          delete headers.referer
        } else if (
          details.resourceType === 'mainFrame' ||
          details.resourceType === 'subFrame'
        ) {
          headers.Referer = 'https://ppv.st/'
        }
      }
    } catch {
      /* ignore */
    }
    callback({ requestHeaders: headers })
  })

  const media = []
  ses.webRequest.onCompleted((details) => {
    if (/m3u8|\.ts\b|nresystems|embedindia|ppv\.st\/api|token|playlist/i.test(details.url)) {
      media.push({ status: details.statusCode, type: details.resourceType, url: details.url.slice(0, 140) })
    }
  })
  ses.webRequest.onErrorOccurred((details) => {
    if (/m3u8|nresystems|embedindia/i.test(details.url)) {
      media.push({ error: details.error, url: details.url.slice(0, 140) })
    }
  })

  const win = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )

  const loadOpts = mode === 'with-ref' ? { httpReferrer: 'https://ppv.st/' } : undefined
  await win.loadURL(pick.iframe, loadOpts)
  await new Promise((r) => setTimeout(r, 3000))
  const htmlLen = await win.webContents.executeJavaScript(
    'document.documentElement.outerHTML.length',
  )

  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector(
      '.vjs-big-play-button, .play-wrapper, button[aria-label*="Play" i], #player, .jw-icon-display, .vjs-poster, video'
    );
    try { btn && btn.click(); } catch (_) {}
    const v = document.querySelector('video');
    try { if (v) { v.muted = true; v.play().catch(()=>{}); } } catch (_) {}
    return true;
  })()`)

  await new Promise((r) => setTimeout(r, 18000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return {
      htmlLen: document.documentElement.outerHTML.length,
      ready: v && v.readyState,
      paused: v && v.paused,
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      err: v && v.error && v.error.code,
      src: v && (v.currentSrc || v.src || '').slice(0, 160),
      text: (document.body && document.body.innerText || '').slice(0, 180),
    };
  })()`)

  console.log(
    JSON.stringify(
      {
        mode,
        name: pick.name,
        iframeHost: new URL(pick.iframe).host,
        htmlLenAtLoad: htmlLen,
        afterPlay: state,
        mediaHits: media.slice(-20),
      },
      null,
      2,
    ),
  )
  app.exit(state && state.w > 0 ? 0 : 3)
})

app.on('window-all-closed', () => app.exit(0))
