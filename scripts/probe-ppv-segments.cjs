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
      if (!live || !s.iframe) continue
      if (end && end - now < 30 * 60) continue
      if (/vs\.|vs /i.test(s.name)) return { name: s.name, iframe: s.iframe, end, now }
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

  const ses = session.fromPartition('probe-ppv-seg')
  let mediaPlaylistUrl = ''
  let segmentUrl = ''

  ses.webRequest.onCompleted((details) => {
    if (/mono\.ts\.m3u8/i.test(details.url) && details.statusCode === 200 && !mediaPlaylistUrl) {
      mediaPlaylistUrl = details.url
    }
    if (/\.ts(\?|$)/i.test(details.url) && !segmentUrl) {
      segmentUrl = details.url
    }
  })

  const win = new BrowserWindow({
    width: 900,
    height: 500,
    show: false,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )
  await win.loadURL(item.iframe, { httpReferrer: 'https://ppv.st/' })
  await new Promise((r) => setTimeout(r, 2000))
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.jw-icon-display,#player,video').forEach((el)=>{try{el.click()}catch(_){}});
    const v=document.querySelector('video'); try{if(v){v.muted=true;v.play().catch(()=>{})}}catch(_){}
  })()`)
  await new Promise((r) => setTimeout(r, 10000))

  const out = { item, mediaPlaylistUrl: mediaPlaylistUrl.slice(0, 180), segmentUrl: segmentUrl.slice(0, 180) }
  if (mediaPlaylistUrl) {
    const r = await ses.fetch(mediaPlaylistUrl, {
      headers: { Referer: 'https://embedindia.st/', Origin: 'https://embedindia.st' },
    })
    const body = await r.text()
    out.mediaPlaylist = { status: r.status, body: body.slice(0, 600) }
    const lines = body.split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
    out.segmentLines = lines.slice(0, 5)
    if (lines[0]) {
      const abs = new URL(lines[0], mediaPlaylistUrl).toString()
      const tries = [
        { Referer: 'https://embedindia.st/' },
        { Referer: 'https://embedindia.st/', Origin: 'https://embedindia.st' },
        { Referer: mediaPlaylistUrl },
        {},
      ]
      out.segmentFetches = []
      for (const headers of tries) {
        const sr = await ses.fetch(abs, { headers })
        out.segmentFetches.push({
          headers,
          status: sr.status,
          len: Number(sr.headers.get('content-length') || 0),
          type: sr.headers.get('content-type'),
        })
      }
    }
  }

  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
