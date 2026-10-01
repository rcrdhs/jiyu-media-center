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
  {
    name: 'Game of Thrones',
    detail: 'https://watch.corsflix.net/tv/1399-game-of-thrones',
    watch: 'https://watch.corsflix.net/tv/1399-game-of-thrones/watch',
    ep: 'https://watch.corsflix.net/tv/1399-game-of-thrones/season/1/episode/1',
  },
  {
    name: 'Breaking Bad',
    detail: 'https://watch.corsflix.net/tv/1396-breaking-bad',
    watch: 'https://watch.corsflix.net/tv/1396-breaking-bad/watch',
    ep: 'https://watch.corsflix.net/tv/1396-breaking-bad/season/1/episode/1',
  },
  {
    name: 'Stranger Things',
    detail: 'https://watch.corsflix.net/tv/66732-stranger-things',
    watch: 'https://watch.corsflix.net/tv/66732-stranger-things/watch',
    ep: 'https://watch.corsflix.net/tv/66732-stranger-things/season/1/episode/1',
  },
  {
    name: 'The Office',
    detail: 'https://watch.corsflix.net/tv/2316-the-office',
    watch: 'https://watch.corsflix.net/tv/2316-the-office/watch',
    ep: 'https://watch.corsflix.net/tv/2316-the-office/season/1/episode/1',
  },
  {
    name: 'Lanterns (2026)',
    detail: 'https://watch.corsflix.net/tv/97476-lanterns',
    watch: 'https://watch.corsflix.net/tv/97476-lanterns/watch',
    ep: 'https://watch.corsflix.net/tv/97476-lanterns/season/1/episode/1',
  },
]

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  const text = await res.text()
  return { status: res.status, url: res.url, text }
}

function analyzeHtml(name, kind, url, text) {
  const lower = text.toLowerCase()
  const loginRequired =
    /requires login|sign in to|please log in|login to watch|create an account/i.test(text)
  const notFound = /don't have this page|page not found|404/i.test(text)
  const hasVideo = /<video|jwplayer|clappr|iframe[^>]+src|embed\.|vidsrc|superembed|videasy|player/i.test(
    text,
  )
  const watchBtn = /watch now|play episode|start watching|continue watching/i.test(text)
  return {
    show: name,
    kind,
    url,
    loginRequired,
    notFound,
    hasVideoMarkup: hasVideo,
    watchBtnInHtml: watchBtn,
    snippet: text.replace(/\s+/g, ' ').slice(0, 220),
  }
}

async function probeWithBrowser(page, show) {
  const out = { show: show.name, browser: {} }
  for (const [kind, url] of [
    ['detail', show.detail],
    ['watch', show.watch],
    ['episode', show.ep],
  ]) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
      await new Promise((r) => setTimeout(r, 3500))
      const info = await page.evaluate(() => {
        const body = document.body?.innerText || ''
        const loginRequired = /requires login|sign in|log in to|create an account/i.test(body)
        const notFound = /don't have this page|page not found/i.test(body)
        const videos = document.querySelectorAll('video').length
        const iframes = [...document.querySelectorAll('iframe')].map((f) => f.src || f.dataset?.src || '')
        const buttons = [...document.querySelectorAll('button,a')]
          .map((el) => (el.textContent || '').trim())
          .filter((t) => /watch|play|sign in|log in|login/i.test(t))
          .slice(0, 12)
        return {
          title: document.title,
          loginRequired,
          notFound,
          videoCount: videos,
          iframeCount: iframes.length,
          iframeSrcs: iframes.filter(Boolean).slice(0, 5),
          buttons,
          bodySample: body.slice(0, 350),
        }
      })
      out.browser[kind] = info
    } catch (err) {
      out.browser[kind] = { error: err.message || String(err) }
    }
  }
  return out
}

;(async () => {
  console.log('=== Static fetch (no login cookies) ===')
  for (const show of SHOWS) {
    for (const [kind, url] of [
      ['detail', show.detail],
      ['watch', show.watch],
      ['episode', show.ep],
    ]) {
      const { status, text } = await fetchText(url)
      const row = analyzeHtml(show.name, kind, url, text)
      console.log(JSON.stringify({ ...row, status }, null, 0))
    }
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('\n(no Chrome for puppeteer — static results only)')
    return
  }

  console.log('\n=== Headless browser (logged out) ===')
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )

  for (const show of SHOWS) {
    const result = await probeWithBrowser(page, show)
    console.log(JSON.stringify(result, null, 2))
  }

  await browser.close()
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
