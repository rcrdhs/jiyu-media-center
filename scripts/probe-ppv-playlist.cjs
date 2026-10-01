const { app, BrowserWindow, session } = require('electron')

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

async function pickLive() {
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
      if (/vs\.|vs /i.test(s.name)) {
        return { name: s.name, iframe: s.iframe, start, end, now }
      }
    }
  }
  return null
}

app.whenReady().then(async () => {
  const pick = await pickLive()
  if (!pick) {
    console.log(JSON.stringify({ error: 'none' }))
    app.exit(2)
    return
  }

  const ses = session.fromPartition('probe-ppv-m3u8')
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

  let playlist = null
  ses.webRequest.onCompleted(async (details) => {
    if (!/\.m3u8(\?|$)/i.test(details.url) || details.statusCode !== 200) return
    if (playlist) return
    try {
      const r = await ses.fetch(details.url, {
        headers: {
          Referer: 'https://embedindia.st/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
      })
      playlist = {
        url: details.url.slice(0, 160),
        status: r.status,
        body: (await r.text()).slice(0, 800),
      }
    } catch (e) {
      playlist = { url: details.url.slice(0, 160), error: String(e) }
    }
  })

  const win = new BrowserWindow({
    width: 800,
    height: 450,
    show: false,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )
  await win.loadURL(pick.iframe, { httpReferrer: 'https://ppv.st/' })
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.jw-icon-display, #player, video').forEach((el) => { try { el.click(); } catch (_) {} });
    const v = document.querySelector('video');
    try { if (v) { v.muted = true; v.play().catch(()=>{}); } } catch (_) {}
  })()`)
  await new Promise((r) => setTimeout(r, 12000))
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return { w: v && v.videoWidth, ready: v && v.readyState, paused: v && v.paused, text: (document.body?.innerText||'').slice(0,120) };
  })()`)
  console.log(JSON.stringify({ pick, state, playlist }, null, 2))
  app.exit(0)
})
