/**
 * For each PPV mirror API, grab live iframe and check HLS .ts via Electron player path.
 */
const { app, BrowserWindow, session } = require('electron')

const MIRRORS = [
  'https://ppv.st',
  'https://ppvs.pk',
  'https://ppv.ug',
]

try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
} catch {
  /* ignore */
}

async function pickFrom(origin) {
  const apiBase = origin.replace(/^(https?:\/\/)/, '$1api.')
  const res = await fetch(`${apiBase}/api/streams`, {
    headers: { Accept: 'application/json', Referer: origin + '/' },
  })
  const json = await res.json()
  const now = Math.floor(Date.now() / 1000)
  for (const cat of json.streams || []) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      if (end && end - now < 20 * 60) continue
      if (/Reds|Dodgers|vs\.|vs /i.test(s.name)) {
        return {
          origin,
          name: s.name,
          iframe: s.iframe,
          embedHost: new URL(s.iframe).host,
          left: end ? end - now : null,
        }
      }
    }
  }
  return { origin, error: 'no pick' }
}

async function probeEmbed(pick) {
  if (!pick.iframe) return { ...pick, error: pick.error || 'no iframe' }

  const ses = session.fromPartition(`ppv-mirror-${pick.origin.replace(/\W+/g, '')}-${Date.now()}`)
  const tally = { m3u8: 0, tsOk: 0, ts404: 0, ts403: 0 }
  let sampleTs = ''
  let sampleM3u8 = ''

  ses.webRequest.onCompleted((details) => {
    if (/\.m3u8(\?|$)/i.test(details.url) && details.statusCode === 200) {
      tally.m3u8 += 1
      if (!sampleM3u8) sampleM3u8 = details.url
    }
    if (/\.ts(\?|$)/i.test(details.url)) {
      if (details.statusCode === 200) tally.tsOk += 1
      else if (details.statusCode === 404) tally.ts404 += 1
      else if (details.statusCode === 403) tally.ts403 += 1
      if (!sampleTs) sampleTs = `${details.statusCode} ${details.url.slice(0, 100)}`
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

  try {
    await win.loadURL(pick.iframe, { httpReferrer: pick.origin + '/' })
  } catch (err) {
    try {
      win.destroy()
    } catch {
      /* ignore */
    }
    return {
      origin: pick.origin,
      name: pick.name,
      embedHost: pick.embedHost,
      loadError: err instanceof Error ? err.message : String(err),
      tally,
    }
  }
  await new Promise((r) => setTimeout(r, 2000))
  try {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.jw-icon-display,#player,video').forEach((el)=>{try{el.click()}catch(_){}});
      const v=document.querySelector('video'); try{if(v){v.muted=true;v.play().catch(()=>{})}}catch(_){}
    })()`)
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 14000))
  let state = null
  try {
    state = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return { w: v && v.videoWidth, ready: v && v.readyState, paused: v && v.paused };
    })()`)
  } catch (err) {
    state = { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    win.destroy()
  } catch {
    /* ignore */
  }

  return {
    origin: pick.origin,
    name: pick.name,
    embedHost: pick.embedHost,
    left: pick.left,
    tally,
    state,
    sampleM3u8: sampleM3u8.slice(0, 120),
    sampleTs,
  }
}

app.whenReady().then(async () => {
  const picks = []
  for (const origin of MIRRORS) {
    picks.push(await pickFrom(origin))
  }

  // Deduplicate identical embed URLs — still probe one per mirror if iframe differs
  const results = []
  for (const pick of picks) {
    process.stdout.write(`play ${pick.origin}...\n`)
    results.push(await probeEmbed(pick))
  }

  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  const anyOk = results.some((r) => r.state && r.state.w > 0)
  app.exit(anyOk ? 0 : 3)
})
