/**
 * From a YMovies origin page, fetch sources+embed in-page then open embed with referer.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const ORIGIN = 'https://ww.ymovies.vip'

function findChrome() {
  for (const c of [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const media = []
  page.on('request', (req) => {
    const u = req.url()
    if (/\.m3u8|\.mp4(\?|$)|getSources|fstream365/i.test(u)) {
      console.log('>>', req.method(), u.slice(0, 200))
      media.push({ type: 'req', url: u })
    }
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!/\.m3u8|\.mp4(\?|$)|getSources|fstream365\/ajax/i.test(u)) return
    let body = ''
    try {
      body = (await res.text()).slice(0, 600)
    } catch {}
    console.log('<<', res.status(), u.slice(0, 200), body.slice(0, 150))
    media.push({ type: 'res', status: res.status(), url: u, body })
  })

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  console.log('home', await page.title())

  const embed = await page.evaluate(async () => {
    const id = 's6ptq'
    const s = await fetch(`/ajax/movie/episode/servers/${id}_1_1`).then((r) => r.json())
    const token = s.html.match(/data-id="([^"]+)"/)[1]
    const name = s.html.match(/data-name="(\d+)"/)[1]
    const src = await fetch(`/ajax/movie/episode/server/sources/${token}_${name}`).then((r) =>
      r.json(),
    )
    return src.src
  })
  console.log('embed', embed)

  // Open embed in same tab with referer
  await page.setExtraHTTPHeaders({ Referer: ORIGIN + '/' })
  await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 60000 })
  console.log('embed title', await page.title())
  const has = await page.evaluate(() => !!window.vConfig)
  console.log('vConfig?', has)
  if (has) {
    const out = await page.evaluate(async () => {
      const c = window.vConfig
      const paths = [
        `/ajax/getSources?id=${encodeURIComponent(c.id)}`,
        `/ajax/getSources?id=${encodeURIComponent(c.id)}&hash=${encodeURIComponent(c.hash)}`,
        `/ajax/getSources?id=${encodeURIComponent(c.mid)}`,
      ]
      const results = []
      for (const p of paths) {
        const r = await fetch(p, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        const t = await r.text()
        results.push({ p, status: r.status, len: t.length, t: t.slice(0, 400) })
      }
      // also try calling whatever global the player exposes
      return { cfg: { id: c.id.slice(0, 32), hash: c.hash, mid: c.mid, server: c.server }, results }
    })
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log('html', (await page.content()).slice(0, 800))
  }

  await new Promise((r) => setTimeout(r, 12000))
  console.log('media events', media.length)
  fs.writeFileSync('D:/app/scripts/fstream-media.json', JSON.stringify(media, null, 2))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
