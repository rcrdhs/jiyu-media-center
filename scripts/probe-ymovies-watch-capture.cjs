/**
 * Open YMovies watching page in Chrome and capture media requests.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const ORIGIN = 'https://ww.ymovies.vip'
const WATCH = `${ORIGIN}/film/chernobyl-inside-the-meltdown-s6ptq/watching.html?ep=1_1`

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
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const hits = []
  page.on('request', (req) => {
    const u = req.url()
    if (/\.m3u8|\.mp4(\?|$)|getSources|getSource|fstream365|\/ajax\/.*sourc/i.test(u)) {
      console.log('>>', req.method(), u.slice(0, 180))
      hits.push({ t: 'req', m: req.method(), u })
    }
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!/\.m3u8|\.mp4(\?|$)|getSources|getSource|fstream365.*ajax|\/api\//i.test(u)) return
    let body = ''
    try {
      body = (await res.text()).slice(0, 500)
    } catch {}
    console.log('<<', res.status(), u.slice(0, 180))
    console.log('   ', body.slice(0, 200))
    hits.push({ t: 'res', s: res.status(), u, body })
  })

  console.log('goto', WATCH)
  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await new Promise((r) => setTimeout(r, 5000))

  // click Server A1 / play
  for (const sel of ['#watch-11', 'a.link-item', '.eps-item', 'iframe', 'video']) {
    try {
      await page.click(sel, { timeout: 1500 })
      console.log('clicked', sel)
      await new Promise((r) => setTimeout(r, 2000))
    } catch {}
  }

  // frames
  for (const frame of page.frames()) {
    const url = frame.url()
    if (/fstream|embed/i.test(url)) {
      console.log('frame', url.slice(0, 160))
      try {
        const cfg = await frame.evaluate(() => window.vConfig || null)
        console.log('frame vConfig', cfg && { id: cfg.id?.slice(0, 40), hash: cfg.hash, mid: cfg.mid })
        if (cfg) {
          const r = await frame.evaluate(async (c) => {
            const url = `/ajax/getSources?id=${encodeURIComponent(c.id)}`
            const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
            return { status: res.status, text: (await res.text()).slice(0, 500) }
          }, cfg)
          console.log('frame getSources', r)
        }
      } catch (e) {
        console.log('frame eval err', e.message)
      }
    }
  }

  await new Promise((r) => setTimeout(r, 15000))
  console.log('hits', hits.length)
  fs.writeFileSync('D:/app/scripts/fstream-hits.json', JSON.stringify(hits, null, 2))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
