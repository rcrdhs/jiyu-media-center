/**
 * Headful Chrome capture of fstream365 network + DOM.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const ORIGIN = 'https://ww.ymovies.vip'

function findChrome() {
  for (const c of [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

;(async () => {
  const servers = await fetch(`${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN },
  }).then((r) => r.json())
  const token = servers.html.match(/data-id="([^"]+)"/)[1]
  const name = servers.html.match(/data-name="(\d+)"/)[1]
  const embed = (
    await fetch(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN },
    }).then((r) => r.json())
  ).src
  console.log('embed', embed)

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 720 },
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
    if (/m3u8|\.mp4|getS|source|ajax\/|\/api\//i.test(u)) {
      console.log('>>', req.method(), u.slice(0, 160))
      hits.push({ type: 'req', method: req.method(), url: u })
    }
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!/m3u8|\.mp4|getS|source|ajax\/|\/api\//i.test(u)) return
    let body = ''
    try {
      body = (await res.text()).slice(0, 400)
    } catch {}
    console.log('<<', res.status(), u.slice(0, 160), body.slice(0, 120))
    hits.push({ type: 'res', status: res.status(), url: u, body })
  })

  await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 3000))
  const html = await page.content()
  console.log('title', await page.title())
  console.log('has vConfig', /vConfig/.test(html))
  console.log('html len', html.length)
  console.log('snippet', html.slice(0, 500))

  // evaluate fetch from page context using vConfig
  const result = await page.evaluate(async () => {
    const cfg = window.vConfig
    if (!cfg) return { error: 'no vConfig', keys: Object.keys(window).slice(0, 30) }
    const tries = []
    for (const path of [
      `/ajax/getSources?id=${encodeURIComponent(cfg.id)}`,
      `/ajax/getSources?id=${encodeURIComponent(cfg.id)}&hash=${encodeURIComponent(cfg.hash)}`,
    ]) {
      try {
        const r = await fetch(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        const t = await r.text()
        tries.push({ path, status: r.status, len: t.length, text: t.slice(0, 300) })
      } catch (e) {
        tries.push({ path, error: String(e) })
      }
    }
    return { cfg, tries }
  })
  console.log('page eval', JSON.stringify(result, null, 2))

  await new Promise((r) => setTimeout(r, 10000))
  console.log('hit count', hits.length)
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
