/**
 * Probe a specific PPV MLB embed for real segment success.
 */
const { app, BrowserWindow, session } = require('electron')

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

async function pickMlb() {
  const api = await (
    await fetch('https://api.ppv.st/api/streams', {
      headers: { Accept: 'application/json', Referer: 'https://ppv.st/' },
    })
  ).json()
  const now = Math.floor(Date.now() / 1000)
  const picks = []
  for (const cat of api.streams || []) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      if (/mlb|baseball/i.test(String(cat.category || s.category_name || s.name))) {
        picks.push({ name: s.name, iframe: s.iframe, tag: s.source_tag })
      }
    }
  }
  // Prefer a major match over 24/7 channels
  return picks.find((p) => /vs\.|vs /i.test(p.name)) || picks[0] || null
}

app.whenReady().then(async () => {
  const pick = await pickMlb()
  if (!pick) {
    console.log(JSON.stringify({ ok: false, error: 'no mlb' }))
    app.exit(2)
    return
  }

  const ses = session.fromPartition('probe-ppv-mlb')
  // Match Jiyu: force ppv.st referer for embedindia
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    try {
      const host = new URL(details.url).hostname.replace(/^www\./i, '').toLowerCase()
      if (
        (host === 'embedindia.st' || host.endsWith('.embedindia.st')) &&
        (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')
      ) {
        headers.Referer = 'https://ppv.st/'
      }
    } catch {
      /* ignore */
    }
    callback({ requestHeaders: headers })
  })

  const media = []
  const tally = { m3u8ok: 0, tsOk: 0, ts404: 0, otherErr: 0 }
  ses.webRequest.onCompleted((details) => {
    const u = details.url
    if (/\.m3u8(\?|$)/i.test(u)) {
      if (details.statusCode === 200) tally.m3u8ok += 1
      media.push({ kind: 'm3u8', status: details.statusCode, url: u.slice(0, 120) })
    } else if (/\.ts(\?|$)/i.test(u)) {
      if (details.statusCode === 200) tally.tsOk += 1
      else if (details.statusCode === 404) tally.ts404 += 1
      if (media.length < 30) media.push({ kind: 'ts', status: details.statusCode, url: u.slice(0, 120) })
    }
  })
  ses.webRequest.onErrorOccurred((details) => {
    if (/\.ts|\.m3u8|indianservers|embedindia/i.test(details.url)) {
      tally.otherErr += 1
      media.push({ kind: 'err', error: details.error, url: details.url.slice(0, 120) })
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

  await win.loadURL(pick.iframe, { httpReferrer: 'https://ppv.st/' })
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`(() => {
    const sels = ['.jw-icon-display','.vjs-big-play-button','#player','video','.play-wrapper'];
    for (const s of sels) {
      const el = document.querySelector(s);
      try { el && el.click(); } catch (_) {}
    }
    const v = document.querySelector('video');
    try { if (v) { v.muted = true; v.play().catch(()=>{}); } } catch (_) {}
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 22000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return {
      ready: v && v.readyState,
      paused: v && v.paused,
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      t: v && v.currentTime,
      src: v && (v.currentSrc || v.src || '').slice(0, 120),
      text: (document.body && document.body.innerText || '').slice(0, 160),
    };
  })()`)

  console.log(JSON.stringify({ pick, tally, state, mediaTail: media.slice(-15) }, null, 2))
  app.exit(state && state.w > 0 ? 0 : 3)
})

app.on('window-all-closed', () => app.exit(0))
