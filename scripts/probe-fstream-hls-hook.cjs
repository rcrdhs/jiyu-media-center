/**
 * Hook Hls.loadSource inside fstream embed to steal the m3u8.
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
    window.__jiyuStreams = []
    const hook = () => {
      try {
        if (window.Hls && window.Hls.prototype && !window.Hls.prototype.__jiyuHooked) {
          const orig = window.Hls.prototype.loadSource
          window.Hls.prototype.loadSource = function (url) {
            window.__jiyuStreams.push(url)
            console.log('HLS loadSource', url)
            return orig.apply(this, arguments)
          }
          window.Hls.prototype.__jiyuHooked = true
        }
      } catch {}
    }
    const id = setInterval(hook, 50)
    setTimeout(() => clearInterval(id), 20000)
  })

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const embed = await page.evaluate(async () => {
    const id = 's6ptq'
    const s = await fetch(`/ajax/movie/episode/servers/${id}_1_1`).then((r) => r.json())
    const token = s.html.match(/data-id="([^"]+)"/)[1]
    const name = s.html.match(/data-name="(\d+)"/)[1]
    return (await fetch(`/ajax/movie/episode/server/sources/${token}_${name}`).then((r) => r.json())).src
  })
  console.log('embed', embed.slice(0, 100))
  await page.setExtraHTTPHeaders({ Referer: ORIGIN + '/' })
  await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 60000 })

  let stream = null
  for (let i = 0; i < 25; i++) {
    stream = await page.evaluate(() => (window.__jiyuStreams && window.__jiyuStreams[0]) || null)
    const logs = await page.evaluate(() => ({
      streams: window.__jiyuStreams || [],
      hasHls: typeof window.Hls,
      vConfig: !!window.vConfig,
    }))
    console.log('tick', i, logs)
    if (stream) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('STREAM', stream)
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
