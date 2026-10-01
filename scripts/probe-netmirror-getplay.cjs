const fs = require('fs')

async function fetchText(url, referer) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: referer || 'https://freemovies.lol/',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, url: r.url, text, headers: Object.fromEntries(r.headers) }
}

;(async () => {
  const hosts = ['embedru', 'superembed', 'vidsrc']
  for (const sv of hosts) {
    // note: space after s=1 as in their template
    for (const space of [true, false]) {
      const sParam = space ? '1 ' : '1'
      const url = `https://freemovies.lol/getPlayTV.php?id=294593&s=${encodeURIComponent(sParam.trim())}&e=1&sv=${sv}&playtv=true`
      // also try with literal space encoded
      const url2 = space
        ? `https://freemovies.lol/getPlayTV.php?id=294593&s=1%20&e=1&sv=${sv}&playtv=true`
        : `https://freemovies.lol/getPlayTV.php?id=294593&s=1&e=1&sv=${sv}&playtv=true`
      const res = await fetchText(url2, 'https://freemovies.lol/?player_tv=15329&s=1&e=1&sv=' + sv + '&tv=true')
      console.log('\n===', sv, space ? 'space' : 'nospace', res.status, 'final', res.url, 'len', res.text.length)
      console.log(res.text.slice(0, 1500))
      const iframes = [...res.text.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
      const locs = [...res.text.matchAll(/location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
      const srcs = [...res.text.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]).slice(0, 15)
      console.log('iframes', iframes)
      console.log('locs', locs)
      console.log('srcs', srcs.slice(0, 10))
      if (!space) break
    }
  }

  // Parse Episodes from detail via atob variants
  const detail = await fetch('https://freemovies.lol/the-trouble-with-tessa/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const atobs = [...detail.matchAll(/atob\(["']([A-Za-z0-9+/=]+)["']\)/g)]
  console.log('\natob count', atobs.length)
  for (const m of atobs.slice(0, 5)) {
    try {
      const d = Buffer.from(m[1], 'base64').toString('utf8')
      if (/Episodes|tvplayer|post_id|tvapikey/i.test(d)) {
        console.log('FOUND', d.slice(0, 2000))
      }
    } catch {}
  }
  // Also look for base64 script without atob
  const b64scripts = [...detail.matchAll(/([A-Za-z0-9+/]{80,}={0,2})/g)].slice(0, 3)
  const idx = detail.indexOf('tvapikey')
  console.log('tvapikey idx', idx)
  if (idx >= 0) console.log(detail.slice(idx - 200, idx + 600))
  const idx2 = detail.indexOf('player_tv')
  console.log('player_tv idx', idx2)
  if (idx2 >= 0) console.log(detail.slice(idx2 - 100, idx2 + 400))
})()
