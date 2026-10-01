const puppeteer = require('puppeteer-core')
const fs = require('fs')

function findChrome() {
  for (const c of [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    try {
      if (c && fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

const SHOWS = [
  { name: 'Game of Thrones', id: 1399 },
  { name: 'Breaking Bad', id: 1396 },
  { name: 'Stranger Things', id: 66732 },
  { name: 'The Office', id: 2316 },
  { name: 'Reacher', id: 108978 },
]

;(async () => {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  for (const show of SHOWS) {
    const url = `https://rivestream.ru/embed?type=tv&id=${show.id}&season=1&episode=1`
    const mediaHits = []
    page.on('response', (res) => {
      const u = res.url()
      if (/m3u8|mp4|stream|source|embed|proxy|backend|scrapper|api|subtitle|1shows/i.test(u)) {
        mediaHits.push({ status: res.status(), url: u.slice(0, 200) })
      }
    })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })
    await new Promise((r) => setTimeout(r, 15000))
    const html = await page.content()
    const bodyText = await page.evaluate(() => document.body?.innerText || '')
    const videos = await page.evaluate(() =>
      [...document.querySelectorAll('video')].map((v) => ({
        paused: v.paused,
        muted: v.muted,
        readyState: v.readyState,
        src: (v.currentSrc || v.src || '').slice(0, 150),
      })),
    )
    console.log(
      JSON.stringify(
        {
          show: show.name,
          finalUrl: page.url(),
          title: await page.title(),
          loginGate: /sign in|log in|login required|create account/i.test(bodyText),
          videoCount: videos.length,
          videos,
          bodySample: bodyText.slice(0, 350),
          htmlHasLogin: /sign in|log in|login required/i.test(html),
          mediaHits: mediaHits.slice(0, 25),
        },
        null,
        2,
      ),
    )
    page.removeAllListeners('response')
  }

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
