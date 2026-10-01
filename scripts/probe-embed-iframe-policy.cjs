/**
 * Resolve the two remaining host unknowns for one-GeckoView multiview:
 * 1) Does embed.st initialize inside an iframe with no Referer?
 * 2) Does a sandbox attribute block player init?
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const { URL } = require('url')
const puppeteer = require('puppeteer-core')

function findChrome() {
  const candidates = [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return null
}

function request(url, headers = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          ...headers,
        },
      },
      (r) => {
        const chunks = []
        r.on('data', (d) => chunks.push(d))
        r.on('end', () =>
          res({
            status: r.statusCode,
            headers: r.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', rej)
    req.setTimeout(25000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

async function resolveEmbed() {
  const live = JSON.parse(
    (await request('https://streamed.pk/api/matches/live', { Accept: 'application/json' })).body,
  )
  const m = live.find((x) => x.sources && x.sources.length)
  if (!m) throw new Error('no live matches')
  const s = m.sources[0]
  const streams = JSON.parse(
    (
      await request(`https://streamed.pk/api/stream/${s.source}/${s.id}`, {
        Accept: 'application/json',
      })
    ).body,
  )
  const embed = streams[0]?.embedUrl
  if (!embed) throw new Error('no embed')
  return { title: m.title || m.id, embed }
}

function parentHtml(embed, mode) {
  const sandbox =
    mode === 'sandbox'
      ? ' sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"'
      : ''
  const referrer = mode === 'with-referrer' ? '' : ' referrerpolicy="no-referrer"'
  return `<!doctype html><html><body style="margin:0;background:#000">
<iframe id="t" src="${embed}"${sandbox}${referrer} style="width:960px;height:540px;border:0"></iframe>
</body></html>`
}

async function main() {
  const chrome = findChrome()
  if (!chrome) throw new Error('no chrome')
  const { title, embed } = await resolveEmbed()
  console.log(JSON.stringify({ title, embed }))

  const top = await request(embed, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' })
  const framing = {
    status: top.status,
    len: top.body.length,
    xFrameOptions: top.headers['x-frame-options'] || null,
    csp: top.headers['content-security-policy'] || null,
  }
  console.log('TOP', JSON.stringify(framing))

  const pages = {
    '/noref': parentHtml(embed, 'noref'),
    '/sandbox': parentHtml(embed, 'sandbox'),
    '/referrer': parentHtml(embed, 'with-referrer'),
  }
  const server = http.createServer((req, res) => {
    const body = pages[req.url] || 'missing'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  })

  async function run(mode) {
    const page = await browser.newPage()
    const childDocs = []
    page.on('response', (resp) => {
      const url = resp.url()
      if (url.startsWith('https://embed.st/') || url.includes('embedhd.st')) {
        const h = resp.headers()
        childDocs.push({
          url: url.slice(0, 140),
          status: resp.status(),
          lenHint: h['content-length'] || null,
          xfo: h['x-frame-options'] || null,
          csp: h['content-security-policy'] ? String(h['content-security-policy']).slice(0, 180) : null,
        })
      }
    })
    await page.goto(`http://127.0.0.1:${port}/${mode}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await new Promise((r) => setTimeout(r, 12000))
    const frames = page.frames().filter((f) => f !== page.mainFrame())
    const reports = []
    for (const frame of frames) {
      try {
        const info = await frame.evaluate(() => {
          const text = (document.body && (document.body.innerText || document.body.textContent)) || ''
          const videos = [...document.querySelectorAll('video')].map((v) => ({
            paused: v.paused,
            ready: v.readyState,
            t: Math.round((v.currentTime || 0) * 10) / 10,
          }))
          return {
            href: location.href.slice(0, 140),
            referrer: document.referrer,
            htmlLen: document.documentElement.outerHTML.length,
            sandboxMsg: /remove sandbox|sandbox attributes/i.test(text),
            body: text.replace(/\s+/g, ' ').trim().slice(0, 220),
            videos,
            hasPlayer: !!document.querySelector('#player, .clappr-player, video'),
          }
        })
        reports.push(info)
      } catch (e) {
        reports.push({ error: String(e.message || e).slice(0, 200), url: frame.url().slice(0, 140) })
      }
    }
    await page.close()
    return {
      mode,
      frameCount: frames.length,
      embedResponses: childDocs.filter((d) => /\/embed\//.test(d.url)).slice(0, 3),
      reports,
    }
  }

  for (const mode of ['noref', 'sandbox', 'referrer']) {
    const result = await run(mode)
    console.log(JSON.stringify(result))
  }

  await browser.close()
  server.close()
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
