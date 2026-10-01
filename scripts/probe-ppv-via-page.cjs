/**
 * Try PPV via site page first (cookies), then click into embed — vs direct iframe.
 */
const { app, BrowserWindow, session } = require('electron')

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

async function pick() {
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
      if (!live || !s.iframe || !s.uri_name) continue
      // Prefer games with >20 minutes left so we don't test dying feeds.
      if (end && end - now < 20 * 60) continue
      if (/vs\.|vs /i.test(s.name)) {
        return {
          name: s.name,
          iframe: s.iframe,
          page: `https://ppv.st/live/${s.uri_name}`,
          start,
          end,
          now,
        }
      }
    }
  }
  return null
}

app.whenReady().then(async () => {
  const item = await pick()
  if (!item) {
    console.log(JSON.stringify({ error: 'none' }))
    app.exit(2)
    return
  }

  const mode = process.argv[2] || 'via-page' // via-page | direct
  const ses = session.fromPartition(`probe-ppv-path-${mode}`)
  const tally = { m3u8: 0, tsOk: 0, ts404: 0 }

  ses.webRequest.onCompleted((details) => {
    if (/\.m3u8(\?|$)/i.test(details.url) && details.statusCode === 200) tally.m3u8 += 1
    if (/\.ts(\?|$)/i.test(details.url)) {
      if (details.statusCode === 200) tally.tsOk += 1
      if (details.statusCode === 404) tally.ts404 += 1
    }
  })

  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )

  if (mode === 'via-page') {
    await win.loadURL(item.page)
    await new Promise((r) => setTimeout(r, 4000))
    // Navigate to iframe URL while keeping cookies from page
    await win.loadURL(item.iframe, { httpReferrer: item.page })
  } else {
    await win.loadURL(item.iframe, { httpReferrer: 'https://ppv.st/' })
  }

  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.jw-icon-display, #player, video, .vjs-big-play-button').forEach((el) => {
      try { el.click(); } catch (_) {}
    });
    const v = document.querySelector('video');
    try { if (v) { v.muted = true; v.play().catch(()=>{}); } } catch (_) {}
  })()`)
  await new Promise((r) => setTimeout(r, 18000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return {
      url: location.href.slice(0, 120),
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      ready: v && v.readyState,
      paused: v && v.paused,
      t: v && v.currentTime,
    };
  })()`)

  console.log(JSON.stringify({ mode, name: item.name, tally, state }, null, 2))
  app.exit(state && state.w > 0 ? 0 : 3)
})
