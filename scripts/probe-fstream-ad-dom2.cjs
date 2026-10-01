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
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  page.on('frameattached', (f) => console.log('frame', f.url().slice(0, 120)))
  await page.goto(embed, { waitUntil: 'networkidle2', timeout: 60000, referer: YM + '/' })
  await new Promise((r) => setTimeout(r, 15000))

  const info = await page.evaluate(() => {
    const walk = (root, depth = 0) => {
      const out = []
      if (depth > 8) return out
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (const el of nodes) {
        const t = (el.innerText || el.textContent || '').slice(0, 240)
        if (/closed after|LIVE/i.test(t) && /closed after|cam|girl/i.test(t)) {
          out.push({
            depth,
            tag: el.tagName,
            id: el.id,
            className: String(el.className).slice(0, 100),
            text: t.replace(/\s+/g, ' ').slice(0, 100),
          })
        }
        if (el.shadowRoot) out.push(...walk(el.shadowRoot, depth + 1))
      }
      return out
    }
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({
      src: (f.src || '').slice(0, 160),
      id: f.id,
      className: String(f.className).slice(0, 80),
    }))
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.src)
      .filter((s) => /ad|apd|pop|banner|tsyndicate|juicy|exoclick/i.test(s))
    return {
      hits: walk(document).slice(0, 20),
      iframes: iframes.slice(0, 20),
      adScripts: scripts.slice(0, 20),
      bodyChildCount: document.body?.children.length,
    }
  })
  console.log(JSON.stringify(info, null, 2))

  // Check child frames text
  for (const frame of page.frames()) {
    const u = frame.url()
    if (!u || u === 'about:blank') continue
    try {
      const t = await frame.evaluate(() => (document.body && document.body.innerText) || '')
      if (/closed after|LIVE/i.test(t)) {
        console.log('FRAME HIT', u.slice(0, 120), t.slice(0, 200).replace(/\s+/g, ' '))
      }
    } catch {
      /* cross-origin */
      console.log('FRAME locked', u.slice(0, 120))
    }
  }

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
