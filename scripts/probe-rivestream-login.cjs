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
  { name: 'Game of Thrones', id: 1399, slug: 'game-of-thrones' },
  { name: 'Breaking Bad', id: 1396, slug: 'breaking-bad' },
  { name: 'Stranger Things', id: 66732, slug: 'stranger-things' },
  { name: 'The Office', id: 2316, slug: 'the-office' },
  { name: 'Reacher', id: 108978, slug: 'reacher' },
]

function urlsFor(show) {
  const base = `https://rivestream.ru/tv/${show.id}-${show.slug}`
  return {
    detail: base,
    watch: `${base}/watch`,
    ep: `${base}/season/1/episode/1`,
    embed: `https://rivestream.ru/embed?type=tv&id=${show.id}&season=1&episode=1`,
    embedAlt: `https://rivestream.ru/embed/tv/${show.id}/1/1`,
  }
}

async function probePage(page, show, kind, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
    await new Promise((r) => setTimeout(r, 3500))
    return {
      show: show.name,
      kind,
      url: page.url(),
      ...(await page.evaluate(() => {
        const body = document.body?.innerText || ''
        return {
          title: document.title,
          loginGate: /requires login|sign in|log in to watch|please log in|authentication required|create an account/i.test(
            body,
          ),
          notFound: /don't have this page|page not found|404|not found/i.test(body),
          videoCount: document.querySelectorAll('video').length,
          iframeCount: document.querySelectorAll('iframe').length,
          iframeSrcs: [...document.querySelectorAll('iframe')]
            .map((f) => f.src || f.dataset?.src || '')
            .filter(Boolean)
            .slice(0, 5),
          buttons: [...document.querySelectorAll('button,a')]
            .map((el) => (el.textContent || '').trim())
            .filter((t) => /watch|play|sign in|log in|login|episode/i.test(t))
            .slice(0, 10),
          bodySample: body.slice(0, 450),
        }
      })),
    }
  } catch (err) {
    return { show: show.name, kind, url, error: err.message || String(err) }
  }
}

async function clickWatch(page, show) {
  const u = urlsFor(show)
  await page.goto(u.detail, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 2500))
  const before = page.url()
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button,a')].filter((el) =>
      /^(watch|play)$/i.test((el.textContent || '').trim()),
    )
    if (candidates[0]) {
      candidates[0].click()
      return (candidates[0].textContent || '').trim()
    }
    return null
  })
  await new Promise((r) => setTimeout(r, 4500))
  const after = page.url()
  const state = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return {
      title: document.title,
      loginGate: /requires login|sign in|log in to watch|please log in|authentication required/i.test(body),
      notFound: /don't have this page|page not found|404/i.test(body),
      videoCount: document.querySelectorAll('video').length,
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean).slice(0, 5),
      bodySample: body.slice(0, 450),
    }
  })
  return { show: show.name, before, after, clicked, ...state }
}

;(async () => {
  console.log('=== Static fetch ===')
  for (const show of SHOWS) {
    const u = urlsFor(show)
    for (const [kind, url] of Object.entries(u)) {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      })
      const text = await res.text()
      const loginGate = /requires login|sign in|log in to watch|authentication required/i.test(text)
      const notFound = /don't have this page|page not found|404/i.test(text)
      const hasVideo = /<video|iframe|embed|m3u8|jwplayer|clappr/i.test(text)
      console.log(
        JSON.stringify({
          show: show.name,
          kind,
          status: res.status,
          loginGate,
          notFound,
          hasVideoMarkup: hasVideo,
          len: text.length,
        }),
      )
    }
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('\n(no Chrome — static only)')
    return
  }

  console.log('\n=== Headless browser (logged out) ===')
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  for (const show of SHOWS) {
    const u = urlsFor(show)
    for (const [kind, url] of Object.entries(u)) {
      console.log(JSON.stringify(await probePage(page, show, kind, url), null, 2))
    }
  }

  console.log('\n=== Click Watch on detail pages ===')
  for (const show of SHOWS) {
    console.log(JSON.stringify(await clickWatch(page, show), null, 2))
  }

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
