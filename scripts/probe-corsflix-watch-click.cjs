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
  { name: 'Game of Thrones', url: 'https://watch.corsflix.net/tv/1399-game-of-thrones' },
  { name: 'Breaking Bad', url: 'https://watch.corsflix.net/tv/1396-breaking-bad' },
  { name: 'Stranger Things', url: 'https://watch.corsflix.net/tv/66732-stranger-things' },
  { name: 'The Office', url: 'https://watch.corsflix.net/tv/2316-the-office' },
  { name: 'Reacher', url: 'https://watch.corsflix.net/tv/108978-reacher' },
]

async function clickWatchFlow(page, show) {
  await page.goto(show.url, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 2500))

  const before = page.url()
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button,a')]
      .filter((el) => /^watch$|^play$/i.test((el.textContent || '').trim()))
    if (candidates[0]) {
      candidates[0].click()
      return (candidates[0].textContent || '').trim()
    }
    return null
  })

  await new Promise((r) => setTimeout(r, 4000))
  const after = page.url()

  const state = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return {
      title: document.title,
      loginGate: /requires login|sign in|log in to watch|please log in|authentication/i.test(body),
      notFound: /don't have this page|not found/i.test(body),
      hasVideo: document.querySelectorAll('video').length,
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean).slice(0, 5),
      bodySample: body.slice(0, 400),
    }
  })

  return { show: show.name, before, after, clicked, ...state }
}

;(async () => {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  for (const show of SHOWS) {
    console.log(JSON.stringify(await clickWatchFlow(page, show), null, 2))
  }
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
