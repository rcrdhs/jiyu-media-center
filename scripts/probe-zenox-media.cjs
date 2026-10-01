const fs = require('fs')

async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }
  const html = await (await fetch('https://zenox.lol/media/series-94664-1-1', { headers })).text()
  fs.writeFileSync('scripts/zenox-media.html', html)
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /_next|chunk/i.test(s))
  console.log(JSON.stringify({ len: html.length, scripts }, null, 2))

  for (const path of scripts.filter((s) => /media|player|6857|9343|4267|2951|app\//i.test(s))) {
    const url = path.startsWith('http') ? path : 'https://zenox.lol' + path
    const js = await (await fetch(url, { headers })).text()
    const name = 'zenox-media-' + path.split('/').pop()
    fs.writeFileSync('scripts/' + name, js)
    const apiHits = [...js.matchAll(/\/api\/[a-zA-Z0-9_/?&=${}.-]{2,80}/g)].map((m) => m[0])
    const hosts = [...js.matchAll(/https?:\/\/[a-zA-Z0-9._:-]+/g)].map((m) => m[0])
    const keys = [
      'm3u8',
      'vidsrc',
      'videasy',
      'embed',
      'provider',
      'source',
      'stream',
      'hls',
      'playlist',
      'scraper',
      'proxy',
    ]
    const found = {}
    for (const k of keys) {
      if (js.toLowerCase().includes(k)) found[k] = true
    }
    console.log(
      JSON.stringify({
        name,
        len: js.length,
        apis: [...new Set(apiHits)].slice(0, 40),
        hosts: [...new Set(hosts)].slice(0, 40),
        found,
      }),
    )
  }

  // Broader API guesses for streams
  const tries = [
    '/api/stream/tv/94664/1/1',
    '/api/stream/series/94664/1/1',
    '/api/sources/tv/94664/1/1',
    '/api/sources?type=tv&id=94664&season=1&episode=1',
    '/api/watch/tv/94664/1/1',
    '/api/media/series-94664-1-1',
    '/api/playback/tv/94664/1/1',
    '/api/provider/tv/94664/1/1',
  ]
  for (const path of tries) {
    try {
      const r = await fetch('https://zenox.lol' + path, {
        headers: { ...headers, Accept: 'application/json', Referer: 'https://zenox.lol/media/series-94664-1-1' },
      })
      const t = await r.text()
      console.log(JSON.stringify({ path, status: r.status, ct: r.headers.get('content-type'), sample: t.slice(0, 180).replace(/\s+/g, ' ') }))
    } catch (e) {
      console.log(JSON.stringify({ path, error: e.message }))
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
