/**
 * Capture ALL interesting network from fstream embed until m3u8 appears.
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

  const all = []
  page.on('response', async (res) => {
    const u = res.url()
    const ct = (res.headers()['content-type'] || '').toLowerCase()
    const interesting =
      /getSources|m3u8|\.mp4|mpegurl|video\//i.test(u + ct) ||
      ct.includes('mpegurl') ||
      ct.includes('video') ||
      ct.includes('json')
    if (!interesting) return
    let body = ''
    try {
      body = await res.text()
    } catch {}
    const row = {
      status: res.status(),
      ct,
      url: u,
      body: body.slice(0, 2000),
    }
    all.push(row)
    if (/getSources|m3u8|mp4|mpegurl/i.test(u + ct + body.slice(0, 100))) {
      console.log('HIT', row.status, ct, u.slice(0, 160), body.slice(0, 100))
    }
  })

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const embed = await page.evaluate(async () => {
    const id = 's6ptq'
    const s = await fetch(`/ajax/movie/episode/servers/${id}_1_1`).then((r) => r.json())
    const token = s.html.match(/data-id="([^"]+)"/)[1]
    const name = s.html.match(/data-name="(\d+)"/)[1]
    return (await fetch(`/ajax/movie/episode/server/sources/${token}_${name}`).then((r) => r.json())).src
  })
  console.log('embed', embed.slice(0, 120))

  await page.setExtraHTTPHeaders({ Referer: ORIGIN + '/' })
  await page.goto(embed, { waitUntil: 'networkidle2', timeout: 90000 })

  // Wait for video element / sources
  for (let i = 0; i < 20; i++) {
    const info = await page.evaluate(() => {
      const v = document.querySelector('video')
      return {
        vConfig: !!window.vConfig,
        videoSrc: v?.currentSrc || v?.src || '',
        videoReady: v?.readyState,
      }
    })
    console.log('tick', i, info)
    if (info.videoSrc && /\.m3u8|\.mp4/i.test(info.videoSrc)) break
    await new Promise((r) => setTimeout(r, 1000))
  }

  fs.writeFileSync('D:/app/scripts/fstream-all-hits.json', JSON.stringify(all, null, 2))
  console.log('saved', all.length, 'responses')
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
