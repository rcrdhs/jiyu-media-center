/**
 * Probe fstream embed DOM for the dating LIVE banner structure so we can
 * target it precisely without blanking the video.
 */
const YM = 'https://ww.ymovies.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const puppeteer = require('puppeteer-core')
const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

;(async () => {
  const servers = await fetch(`${YM}/ajax/movie/episode/servers/soft_1_1`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  const token = String(servers.html).match(/data-id="([^"]+)"/)[1]
  const embed = (
    await fetch(`${YM}/ajax/movie/episode/server/sources/${token}_11`, {
      headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
    }).then((r) => r.json())
  ).src

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 45000, referer: YM + '/' })
  await new Promise((r) => setTimeout(r, 8000))

  const info = await page.evaluate(() => {
    const hits = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const t = (el.innerText || '').slice(0, 200)
      if (!/This will be closed after/i.test(t)) continue
      const style = window.getComputedStyle(el)
      hits.push({
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 120),
        position: style.position,
        zIndex: style.zIndex,
        childCount: el.children.length,
        html: el.outerHTML.slice(0, 500),
        parent: el.parentElement
          ? {
              tag: el.parentElement.tagName,
              id: el.parentElement.id,
              className: String(el.parentElement.className).slice(0, 120),
            }
          : null,
      })
    }
    // Also find fixed bottom bars
    const fixed = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const style = window.getComputedStyle(el)
      if (style.position !== 'fixed' && style.position !== 'sticky') continue
      const t = (el.innerText || '').slice(0, 100)
      if (!t && !el.querySelector('img')) continue
      fixed.push({
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 100),
        bottom: style.bottom,
        height: style.height,
        zIndex: style.zIndex,
        text: t.replace(/\s+/g, ' ').slice(0, 80),
      })
    }
    return { hits: hits.slice(0, 8), fixed: fixed.slice(0, 20) }
  })
  console.log(JSON.stringify(info, null, 2))
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
