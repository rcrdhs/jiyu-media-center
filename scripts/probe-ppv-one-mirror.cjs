
const { app, BrowserWindow, session } = require('electron')
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') } catch {}
app.whenReady().then(async () => {
  const origin = process.argv[2]
  const api = origin.replace('://', '://api.')
  const j = await (await fetch(api + '/api/streams', {
    headers: { Accept: 'application/json', Referer: origin + '/' },
  })).json()
  const now = Math.floor(Date.now() / 1000)
  let iframe = '', name = ''
  for (const cat of j.streams || []) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      if (end && end - now < 20 * 60) continue
      if (/vs/i.test(s.name)) { iframe = s.iframe; name = s.name; break }
    }
    if (iframe) break
  }
  if (!iframe) { console.log(JSON.stringify({ origin, error: 'none' })); app.exit(2); return }
  const ses = session.fromPartition('one-' + Date.now())
  const tally = { m3u8: 0, tsOk: 0, ts404: 0, tsOther: 0 }
  ses.webRequest.onCompleted((d) => {
    if (/\.m3u8(\?|$)/i.test(d.url) && d.statusCode === 200) tally.m3u8++
    if (/\.ts(\?|$)/i.test(d.url)) {
      if (d.statusCode === 200) tally.tsOk++
      else if (d.statusCode === 404) tally.ts404++
      else tally.tsOther++
    }
  })
  const win = new BrowserWindow({ width: 800, height: 450, show: false, webPreferences: { session: ses, backgroundThrottling: false } })
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')
  try { await win.loadURL(iframe, { httpReferrer: origin + '/' }) }
  catch (e) { console.log(JSON.stringify({ origin, name, loadError: String(e.message || e) })); app.exit(3); return }
  await new Promise((r) => setTimeout(r, 2000))
  try {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.jw-icon-display,#player,video').forEach((el) => { try { el.click() } catch (_) {} })
      const v = document.querySelector('video'); try { if (v) { v.muted = true; v.play().catch(() => {}) } } catch (_) {}
    })()`)
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 12000))
  let state = {}
  try {
    state = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return { w: v && v.videoWidth, ready: v && v.readyState };
    })()`)
  } catch (e) { state = { error: String(e.message || e) } }
  console.log(JSON.stringify({ origin, name, embed: new URL(iframe).host, tally, state }))
  app.exit(state.w > 0 ? 0 : 3)
})
