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

;(async () => {
  const embed =
    process.argv[2] ||
    'https://embedhd.st/source/streamed.php?hd=111&id=759&no=1'
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
  })
  const page = await browser.newPage()
  await page.setExtraHTTPHeaders({ Referer: 'https://embed.st/' })
  await page.goto(embed, { waitUntil: 'networkidle2', timeout: 90000 })
  for (const wait of [8000, 12000, 20000]) {
    await new Promise((r) => setTimeout(r, wait === 8000 ? wait : wait - 8000))
    const info = await page.evaluate(() => {
      const texts = []
      for (const el of document.querySelectorAll('*')) {
        const t = (el.textContent || '').trim()
        if (/unmute|click.*stream|mute stream/i.test(t) && t.length < 120) {
          texts.push({
            tag: el.tagName,
            id: el.id,
            className: String(el.className || '').slice(0, 80),
            text: t.slice(0, 100),
          })
        }
      }
      const videos = [...document.querySelectorAll('video')].map((v) => ({
        paused: v.paused,
        muted: v.muted,
        volume: v.volume,
        readyState: v.readyState,
      }))
      const iframes = [...document.querySelectorAll('iframe')].map((f) => f.src)
      return {
        texts,
        videos,
        iframes,
        bodyText: document.body?.innerText?.slice(0, 500) || '',
        htmlLen: document.documentElement.outerHTML.length,
      }
    })
    console.log('wait', wait, JSON.stringify(info, null, 2))
  }
  await browser.close()
  return

  const info = await page.evaluate(() => {
    const texts = []
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim()
      if (/unmute|click.*stream|mute stream/i.test(t) && t.length < 120) {
        texts.push({
          tag: el.tagName,
          id: el.id,
          className: el.className,
          text: t.slice(0, 100),
          html: el.outerHTML.slice(0, 300),
        })
      }
    }
    const videos = [...document.querySelectorAll('video')].map((v) => ({
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      readyState: v.readyState,
    }))
    const jw = typeof window.jwplayer === 'function' ? 'yes' : 'no'
    let jwState = null
    try {
      const p = window.jwplayer()
      jwState = {
        mute: p.getMute?.(),
        state: p.getState?.(),
        volume: p.getVolume?.(),
      }
    } catch (e) {
      jwState = String(e.message || e)
    }
    return { texts, videos, jw, jwState, bodyText: document.body.innerText.slice(0, 500) }
  })

  console.log(JSON.stringify(info, null, 2))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
