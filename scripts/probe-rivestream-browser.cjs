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

const URL_PATTERNS = (id) => [
  [`embed-query`, `https://rivestream.ru/embed?type=tv&id=${id}&season=1&episode=1`],
  [`watch-id`, `https://rivestream.ru/watch/tv/${id}`],
  [`watch-s1e1`, `https://rivestream.ru/watch/tv/${id}/1/1`],
  [`tv-id`, `https://rivestream.ru/tv/${id}`],
  [`tv-id-s1e1`, `https://rivestream.ru/tv/${id}/1/1`],
  [`info-id`, `https://rivestream.ru/info/tv/${id}`],
]

;(async () => {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  // Browse /tv landing
  await page.goto('https://rivestream.ru/tv', { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 4000))
  const landing = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 60) }))
      .filter((x) => /tv|watch|show|series/i.test(x.href))
      .slice(0, 25)
    return {
      title: document.title,
      url: location.href,
      loginGate: /sign in|log in|login required|create account/i.test(body),
      bodySample: body.slice(0, 500),
      links,
      cardCount: document.querySelectorAll('img, [class*="card"], [class*="poster"]').length,
    }
  })
  console.log('LANDING', JSON.stringify(landing, null, 2))

  for (const show of SHOWS) {
    const results = { show: show.name, patterns: [] }
    for (const [kind, url] of URL_PATTERNS(show.id)) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
        await new Promise((r) => setTimeout(r, 4000))
        const info = await page.evaluate(() => {
          const body = document.body?.innerText || ''
          return {
            finalUrl: location.href,
            title: document.title,
            loginGate: /sign in|log in|login required|create account|authentication/i.test(body),
            notFound: /404|not found|page not found/i.test(body),
            videoCount: document.querySelectorAll('video').length,
            iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean).slice(0, 3),
            buttons: [...document.querySelectorAll('button,a')]
              .map((el) => (el.textContent || '').trim())
              .filter((t) => /watch|play|sign in|log in|login|unmute/i.test(t))
              .slice(0, 8),
            bodySample: body.slice(0, 350),
          }
        })
        results.patterns.push({ kind, url, ...info })
      } catch (err) {
        results.patterns.push({ kind, url, error: err.message || String(err) })
      }
    }
    console.log(JSON.stringify(results, null, 2))
  }

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
