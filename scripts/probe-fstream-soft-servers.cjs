const YM = 'https://ww.ymovies.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const puppeteer = require('puppeteer-core')
const exe =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

async function getEmbed(serverName) {
  const servers = await fetch(`${YM}/ajax/movie/episode/servers/soft_1_1`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  const html = String(servers.html)
  const re = /<a\b([^>]*data-id="([^"]+)"[^>]*)>/gi
  let m
  let token = ''
  let name = serverName
  while ((m = re.exec(html))) {
    const n = m[1].match(/data-name="(\d+)"/i)?.[1]
    if (n === serverName) {
      token = m[2]
      break
    }
    if (!token) {
      token = m[2]
      name = n || name
    }
  }
  const src = await fetch(`${YM}/ajax/movie/episode/server/sources/${token}_${name}`, {
    headers: { 'User-Agent': UA, Referer: YM + '/', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json())
  return { src: src.src, name }
}

async function probe(url, label, referer) {
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  const errors = []
  const media = []
  page.on('pageerror', (err) => errors.push(err.message.slice(0, 120)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 120))
  })
  page.on('response', (res) => {
    const u = res.url()
    const ct = (res.headers()['content-type'] || '').toLowerCase()
    if (/m3u8|\.mp4|mpegurl|getSources/i.test(u + ct)) {
      media.push({ status: res.status(), u: u.slice(0, 140), ct: ct.slice(0, 40) })
    }
  })
  if (referer) await page.setExtraHTTPHeaders({ Referer: referer })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) =>
    errors.push('goto ' + e.message),
  )
  await new Promise((r) => setTimeout(r, 10000))
  const state = await page.evaluate(() => {
    const v = document.querySelector('video')
    const iframe = document.querySelector('iframe')
    return {
      title: document.title,
      href: location.href.slice(0, 120),
      video: v
        ? { src: (v.currentSrc || v.src || '').slice(0, 120), ready: v.readyState, err: v.error && v.error.code }
        : null,
      iframe: iframe ? (iframe.src || '').slice(0, 120) : null,
    }
  })
  await browser.close()
  console.log('\n===', label)
  console.log(JSON.stringify({ state, errors: errors.slice(0, 8), media: media.slice(0, 12) }, null, 2))
}

;(async () => {
  for (const sid of ['11', '12']) {
    const { src, name } = await getEmbed(sid)
    await probe(src, `embed server ${name}`, YM + '/')
  }
  await probe(
    `${YM}/film/16-and-pregnant-soft/watching.html?ep=1_1`,
    'ymovies watching',
    YM + '/',
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
