const puppeteer = require('puppeteer-core')
const fs = require('fs')

const chromeCandidates = [
  process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
]

function findChrome() {
  for (const c of chromeCandidates) {
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

async function probeEmbed(page, show) {
  const url = `https://rivestream.ru/embed?type=tv&id=${show.id}&season=1&episode=1`
  const hits = []
  page.on('response', async (res) => {
    const u = res.url()
    if (!/m3u8|mp4|stream|source|api|embed|media|video|playlist|hls|proxy/i.test(u)) return
    hits.push({ status: res.status(), url: u.slice(0, 180) })
  })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 10000))
  const state = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return {
      title: document.title,
      url: location.href,
      loginGate: /sign in|log in|login required|create account|authentication/i.test(body),
      notFound: /404|not found|page not found/i.test(body),
      videoCount: document.querySelectorAll('video').length,
      videos: [...document.querySelectorAll('video')].map((v) => ({
        paused: v.paused,
        muted: v.muted,
        readyState: v.readyState,
        src: (v.currentSrc || v.src || '').slice(0, 120),
      })),
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean),
      bodySample: body.slice(0, 400),
    }
  })
  return { show: show.name, embedUrl: url, ...state, networkHits: hits.slice(0, 20) }
}

async function probeTvLanding(page) {
  await page.goto('https://rivestream.ru/tv', { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 8000))
  return page.evaluate(() => {
    const body = document.body?.innerText || ''
    const cards = [...document.querySelectorAll('a[href*="/info/"], a[href*="/watch/"], a[href*="/tv/"]')]
      .map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 50) }))
      .slice(0, 20)
    return {
      title: document.title,
      url: location.href,
      loginGate: /sign in|log in|login required|create account/i.test(body),
      cardLinks: cards.length,
      cards,
      bodySample: body.slice(0, 500),
    }
  })
}

;(async () => {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  console.log('LANDING', JSON.stringify(await probeTvLanding(page), null, 2))
  for (const show of SHOWS) {
    console.log(JSON.stringify(await probeEmbed(page, show), null, 2))
  }
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
