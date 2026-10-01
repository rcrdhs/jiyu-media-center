const fs = require('fs')

;(async () => {
  const detail = await fetch('https://freemovies.lol/the-trouble-with-tessa/', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }).then((r) => r.text())
  fs.writeFileSync('D:/app/scripts/nm-detail.html', detail)
  console.log('len', detail.length)

  // Search various encodings
  for (const key of ['Episodes', 'tvapikey', 'tvplayer', 'post_id', 'tvid', 'player_tv', 'getPlayTV', 'data-load-embed']) {
    console.log(key, detail.indexOf(key))
  }

  // Look for script type with encoded content
  const scripts = [...detail.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  console.log('script count', scripts.length)
  for (const s of scripts) {
    const attrs = s[1]
    const body = s[2]
    if (/Episodes|tvapikey|player_tv|atob|btoa|fromCharCode/i.test(body) || /Episodes|tvapikey/i.test(attrs)) {
      console.log('MATCH attrs', attrs.slice(0, 120), 'body len', body.length)
      console.log(body.slice(0, 500))
    }
  }

  // Try embed pages for media
  const embeds = [
    'https://vsembed.ru/embed/tv/294593/1/1',
    'https://vidlink.pro/tv/294593/1/1',
    'https://www.2embed.cc/embedtv/294593/1/1',
  ]
  for (const url of embeds) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Referer: 'https://freemovies.lol/',
        },
        redirect: 'follow',
      })
      const html = await r.text()
      console.log('\nEMBED', url, r.status, 'final', r.url, 'len', html.length)
      console.log(html.slice(0, 800))
      const m3u = [...html.matchAll(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/gi)].map((m) => m[0])
      const mp4 = [...html.matchAll(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi)].map((m) => m[0])
      const file = [...html.matchAll(/["']file["']\s*:\s*["']([^"']+)["']/gi)].map((m) => m[1])
      const sources = [...html.matchAll(/["'](?:file|src|url|source)["']\s*:\s*["'](https?:[^"']+)["']/gi)].map(
        (m) => m[1],
      )
      console.log('m3u', m3u.slice(0, 5))
      console.log('mp4', mp4.slice(0, 5))
      console.log('file', file.slice(0, 5))
      console.log('sources', sources.slice(0, 8))
    } catch (e) {
      console.log('EMBED err', url, e.message)
    }
  }
})()
