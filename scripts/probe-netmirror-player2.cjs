const fs = require('fs')

;(async () => {
  // From detail page: post_id and tvplayer
  const detail = await fetch('https://freemovies.lol/the-trouble-with-tessa/', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ww1.surf/netmirror/' },
  }).then((r) => r.text())

  const b64 = detail.match(/atob\("([A-Za-z0-9+/=]+)"\)/)?.[1]
  if (b64) {
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    console.log('decoded Episodes chunk:\n', decoded.slice(0, 1500))
  }

  // Also raw Episodes= in page
  const epIdx = detail.indexOf('var Episodes')
  console.log('\nEpisodes raw around', epIdx)
  if (epIdx >= 0) console.log(detail.slice(epIdx, epIdx + 800))

  const postId = '15329' // from favorite bookmark id earlier - need real post_id
  // Try common patterns
  const candidates = [
    'https://freemovies.lol/?player_tv=15329&s=1&e=1&sv=embedru&tv=true',
    'https://freemovies.lol/?player_tv=294593&s=1&e=1&sv=embedru&tv=true',
    'https://freemovies.lol/?player_tv=tt36957172&s=1&e=1&sv=embedru&tv=true',
  ]

  for (const url of candidates) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://freemovies.lol/the-trouble-with-tessa/',
      },
    })
    const html = await r.text()
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]
    const iframes = [...html.matchAll(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi)].map((m) => m[1])
    const scripts = [...html.matchAll(/src=["']([^"']*player[^"']*)["']/gi)].map((m) => m[1]).slice(0, 10)
    const media = [...html.matchAll(/https?:\/\/[^"'<\s]+\.(?:m3u8|mp4)[^"'<\s]*/gi)].map((m) => m[0]).slice(0, 5)
    console.log('\n', url, r.status, 'len', html.length)
    console.log(' title', title)
    console.log(' iframes', iframes.slice(0, 8))
    console.log(' scripts', scripts)
    console.log(' media', media)
    // look for embed
    const embedHints = [...html.matchAll(/(?:vidsrc|embed|superembed|moviesapi|vidlink)[^"'<\s]{0,80}/gi)].slice(0, 8)
    console.log(' hints', embedHints.map((m) => m[0]))
    fs.writeFileSync(
      `D:/app/scripts/nm-player-${url.includes('15329') ? 'post' : url.includes('294593') ? 'tvid' : 'imdb'}.html`,
      html.slice(0, 50000),
    )
  }
})()
