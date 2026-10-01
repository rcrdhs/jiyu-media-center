;(async () => {
  const url = 'https://freemovies.lol/the-trouble-with-tessa/'
  const html = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ww1.surf/netmirror/' },
  }).then((r) => r.text())
  console.log('len', html.length, 'title', html.match(/<title[^>]*>([^<]+)/i)?.[1])

  // Find Episodes assignment in any form
  for (const pat of [
    /Episodes\s*=\s*\{/,
    /tvapikey/,
    /tvimdbid/,
    /player_tv/,
    /data-id=/,
    /season/,
  ]) {
    console.log(pat, pat.test(html))
  }

  const idx = html.indexOf('Episodes')
  console.log('Episodes idx', idx)
  if (idx >= 0) console.log(html.slice(idx, idx + 800))

  // decode base64 scripts that might hold Episodes
  const b64s = [...html.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g)]
  console.log('b64 scripts', b64s.length)
  for (const m of b64s) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8')
    if (/Episode|tvapi|player|imdb|tmdb/i.test(decoded)) {
      console.log('\n--- decoded ---\n', decoded.slice(0, 2000))
    }
  }

  // season select / episode buttons
  const seasons = [...html.matchAll(/data-season=["']?(\d+)/gi)].map((m) => m[1])
  const eps = [...html.matchAll(/data-episode=["']?(\d+)/gi)].map((m) => m[1])
  console.log('data-season', [...new Set(seasons)].slice(0, 20))
  console.log('data-episode sample', eps.slice(0, 20))

  // Look for select#seasons or .episodes
  const epBlock = html.match(/class="[^"]*episodes[^"]*"[\s\S]{0,2000}/i)
  console.log('ep block', epBlock?.[0]?.slice(0, 800))
})()
