/**
 * Use system Chrome via puppeteer-core to capture fstream365 stream URL.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const path = require('path')

const ORIGIN = 'https://ww.ymovies.vip'
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

async function ymoviesEmbed(id = 's6ptq') {
  const servers = await fetch(`${ORIGIN}/ajax/movie/episode/servers/${id}_1_1`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' },
  }).then((r) => r.json())
  const token = servers.html.match(/data-id="([^"]+)"/)[1]
  const name = servers.html.match(/data-name="(\d+)"/)[1]
  const src = await fetch(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' },
  }).then((r) => r.json())
  return src.src
}

;(async () => {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const embed = await ymoviesEmbed()
  console.log('embed', embed)

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  )

  const hits = []
  page.on('response', async (res) => {
    const url = res.url()
    if (!/m3u8|mp4|getS|source|ajax|api\//i.test(url)) return
    let body = ''
    try {
      body = (await res.text()).slice(0, 300)
    } catch {}
    hits.push({ status: res.status(), url: url.slice(0, 180), body })
  })
  page.on('request', (req) => {
    const url = req.url()
    if (/getS|m3u8|mp4|source/i.test(url)) {
      console.log('REQ', req.method(), url.slice(0, 160))
    }
  })

  await page.goto(embed, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 8000))
  // try clicking play
  try {
    await page.click('video, .vjs-big-play-button, button, .play', { timeout: 2000 })
  } catch {}
  await new Promise((r) => setTimeout(r, 5000))

  console.log('\nHITS', JSON.stringify(hits, null, 2))
  const vConfig = await page.evaluate(() => window.vConfig || null)
  console.log('vConfig', vConfig)

  await browser.close()
})().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
