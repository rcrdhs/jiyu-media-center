const YM = 'https://ww.ymovies.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const puppeteer = require('puppeteer-core')
const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

;(async () => {
  const servers = await fetch(`${YM}/ajax/movie/episode/servers/soft_1_1`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  const token = String(servers.html).match(/data-id="([^"]+)"/)[1]
  const embed = (
    await fetch(`${YM}/ajax/movie/episode/server/sources/${token}_11`, {
      headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
    }).then((r) => r.json())
  ).src

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  const errors = []
  const media = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)))
  page.on('response', async (res) => {
    const u = res.url()
    if (!/getSources|m3u8|\.mp4/i.test(u)) return
    const ct = res.headers()['content-type'] || ''
    let head = ''
    try {
      head = (await res.text()).slice(0, 80)
    } catch {
      /* ignore */
    }
    media.push({ status: res.status(), ct: ct.slice(0, 40), u: u.slice(0, 100), head })
  })

  // Referer only on document navigation (like loadURL httpReferrer) — not on XHR
  await page.goto(embed, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
    referer: YM + '/',
  })
  await new Promise((r) => setTimeout(r, 12000))
  const state = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      title: document.title,
      src: v ? (v.currentSrc || v.src || '').slice(0, 160) : null,
      ready: v ? v.readyState : null,
      paused: v ? v.paused : null,
      err: v && v.error ? v.error.code : null,
    }
  })
  console.log(JSON.stringify({ state, errors, media }, null, 2))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
