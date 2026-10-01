/**
 * Load fstream embed in real Chromium and capture console + failed requests.
 */
const YM = 'https://ww.ymovies.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function resolveEmbed() {
  const servers = await fetch(`${YM}/ajax/movie/episode/servers/soft_1_1`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  const token = String(servers.html).match(/data-id="([^"]+)"/)[1]
  const src = await fetch(`${YM}/ajax/movie/episode/server/sources/${token}_11`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  return src.src
}

;(async () => {
  const embed = await resolveEmbed()
  console.log('embed', embed)

  let puppeteer
  try {
    puppeteer = require('puppeteer-core')
  } catch (e) {
    console.error('no puppeteer', e.message)
    process.exit(1)
  }

  const exe =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  page.on('console', (msg) => console.log('console', msg.type(), msg.text().slice(0, 200)))
  page.on('pageerror', (err) => console.log('pageerror', err.message.slice(0, 200)))
  page.on('requestfailed', (req) =>
    console.log('fail', req.failure()?.errorText, req.url().slice(0, 140)),
  )

  const media = []
  page.on('response', async (res) => {
    const u = res.url()
    const ct = (res.headers()['content-type'] || '').toLowerCase()
    if (
      /m3u8|mp4|getSources|video|mpegurl/i.test(u + ct) ||
      ct.includes('mpegurl') ||
      ct.includes('video')
    ) {
      media.push({ status: res.status(), ct, u: u.slice(0, 160) })
    }
  })

  await page.setExtraHTTPHeaders({ Referer: YM + '/' })
  await page.goto(embed, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) =>
    console.log('goto', e.message),
  )
  await new Promise((r) => setTimeout(r, 8000))
  const state = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      title: document.title,
      video: v
        ? {
            src: v.currentSrc || v.src,
            readyState: v.readyState,
            networkState: v.networkState,
            error: v.error && v.error.code,
            paused: v.paused,
          }
        : null,
      vConfig: window.vConfig
        ? { title: window.vConfig.title, server: window.vConfig.server }
        : null,
    }
  })
  console.log('state', JSON.stringify(state, null, 2))
  console.log('media', media.slice(0, 20))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
