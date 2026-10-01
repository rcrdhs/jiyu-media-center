/**
 * Reproduce embed.st "Remove sandbox attributes…" under different UA/Referer
 * profiles, then verify stealth+strip strategies that Multiview tiles need.
 */
const https = require('https')
const http = require('http')
const { URL } = require('url')

function get(url, headers = {}) {
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
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
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

const DESKTOP = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
}

const ANDROID_WEBVIEWISH = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel Tablet Build/UQ1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'X-Requested-With': 'app.jiyu.mediacenter',
}

function analyze(name, body) {
  const sandboxMsg = /remove sandbox attributes|sandbox attributes on the iframe/i.test(body)
  const hasSandboxAttr = /\ssandbox(=|\s|>)/i.test(body)
  const hasPlayer =
    /jwplayer|clappr|hls\.js|video-js|plyr|bundle-jw|\.m3u8/i.test(body)
  const idle = /\bidle\b/i.test(body)
  const justMoment = /just a moment|cf-browser|challenge-platform/i.test(body)
  return { name, sandboxMsg, hasSandboxAttr, hasPlayer, idle, justMoment, len: body.length }
}

async function resolveLiveEmbed() {
  const live = await get('https://streamed.pk/api/matches/live', {
    Accept: 'application/json',
    'User-Agent': DESKTOP['User-Agent'],
  })
  const matches = JSON.parse(live.body)
  const m = matches.find((x) => x.sources && x.sources.length)
  if (!m) throw new Error('no live matches')
  const s = m.sources[0]
  const streams = JSON.parse(
    (
      await get(`https://streamed.pk/api/stream/${s.source}/${s.id}`, {
        Accept: 'application/json',
        'User-Agent': DESKTOP['User-Agent'],
      })
    ).body,
  )
  const embed = streams[0]?.embedUrl
  if (!embed) throw new Error('no embedUrl')
  return { title: m.title || m.id, embed, source: s.source }
}

async function main() {
  const { title, embed, source } = await resolveLiveEmbed()
  console.log(JSON.stringify({ title, embed, source }))

  const profiles = [
    ['desktop-noref', { ...DESKTOP }],
    ['desktop+streamed-ref', { ...DESKTOP, Referer: 'https://streamed.pk/' }],
    ['android-wv-noref', { ...ANDROID_WEBVIEWISH }],
    ['android-wv+ref', { ...ANDROID_WEBVIEWISH, Referer: 'https://streamed.pk/' }],
    [
      'desktop-ua-but-xrw',
      { ...DESKTOP, 'X-Requested-With': 'app.jiyu.mediacenter' },
    ],
  ]

  for (const [name, headers] of profiles) {
    const r = await get(embed, headers)
    const a = analyze(name, r.body)
    a.status = r.status
    console.log(JSON.stringify(a))
    if (a.sandboxMsg) {
      const m = r.body.match(/Remove sandbox[^<]{0,100}/i)
      if (m) console.log('  snippet:', m[0])
    }
  }
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
