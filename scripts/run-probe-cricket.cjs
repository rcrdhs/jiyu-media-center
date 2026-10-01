const { spawn } = require('child_process')
const electron = require('electron')
const fs = require('fs')
const path = require('path')

const script = path.join(__dirname, '_probe-cricket.cjs')
fs.writeFileSync(
  script,
  `
const { app, BrowserWindow, session } = require('electron')
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') } catch {}

async function pick(nameRe) {
  const j = await (await fetch('https://api.ppv.st/api/streams', {
    headers: { Accept: 'application/json', Referer: 'https://ppv.st/' },
  })).json()
  for (const cat of j.streams || []) {
    for (const s of cat.streams || []) {
      if (nameRe.test(String(s.name || ''))) return s
    }
  }
  return null
}

app.whenReady().then(async () => {
  const nameRe = new RegExp(process.argv[2] || 'Fox Cricket', 'i')
  const s = await pick(nameRe)
  if (!s?.iframe) {
    console.log(JSON.stringify({ error: 'not found' }))
    app.exit(2)
    return
  }
  const ses = session.fromPartition('cricket-' + Date.now())
  // Match Jiyu: force ppv referer for embedindia document
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    try {
      const host = new URL(details.url).hostname.replace(/^www\\./i, '').toLowerCase()
      if ((host === 'embedindia.st' || host.endsWith('.embedindia.st')) &&
          (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
        headers.Referer = 'https://ppv.st/'
      }
    } catch {}
    callback({ requestHeaders: headers })
  })
  const tally = { m3u8: 0, tsOk: 0, ts404: 0, tsOther: 0 }
  let lastTs = ''
  ses.webRequest.onCompleted((d) => {
    if (/\\.m3u8(\\?|$)/i.test(d.url) && d.statusCode === 200) tally.m3u8++
    if (/\\.ts(\\?|$)/i.test(d.url)) {
      if (d.statusCode === 200) tally.tsOk++
      else if (d.statusCode === 404) tally.ts404++
      else tally.tsOther++
      lastTs = d.statusCode + ' ' + d.url.slice(0, 110)
    }
  })
  const win = new BrowserWindow({
    width: 960, height: 540, show: false,
    webPreferences: { session: ses, backgroundThrottling: false },
  })
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')
  try {
    await win.loadURL(s.iframe, { httpReferrer: 'https://ppv.st/' })
  } catch (e) {
    console.log(JSON.stringify({ name: s.name, loadError: String(e.message || e) }))
    app.exit(3)
    return
  }
  const htmlLen = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length')
  await new Promise((r) => setTimeout(r, 2000))
  await win.webContents.executeJavaScript(\`(() => {
    document.querySelectorAll('.jw-icon-display,#player,video,.vjs-big-play-button').forEach((el)=>{try{el.click()}catch(_){}});
    const v=document.querySelector('video'); try{if(v){v.muted=true;v.play().catch(()=>{})}}catch(_){}
  })()\`)
  await new Promise((r) => setTimeout(r, 16000))
  const state = await win.webContents.executeJavaScript(\`(() => {
    const v = document.querySelector('video');
    return {
      htmlLen: document.documentElement.outerHTML.length,
      ready: v && v.readyState,
      paused: v && v.paused,
      w: v && v.videoWidth,
      h: v && v.videoHeight,
      err: v && v.error && v.error.code,
      text: (document.body && document.body.innerText || '').slice(0, 160),
    };
  })()\`)
  console.log(JSON.stringify({
    name: s.name,
    path: new URL(s.iframe).pathname,
    htmlLenAtLoad: htmlLen,
    tally,
    lastTs,
    state,
  }))
  app.exit(state && state.w > 0 ? 0 : 3)
})
`,
)

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(electron, [script, name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ name, timeout: true, out: out.slice(-400) })
    }, 45000)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolve({ name, code, out: out.trim() })
    })
  })
}

;(async () => {
  for (const name of ['Fox Cricket', '^Willow$']) {
    const r = await run(name)
    console.log(r.out || JSON.stringify(r))
  }
})()
