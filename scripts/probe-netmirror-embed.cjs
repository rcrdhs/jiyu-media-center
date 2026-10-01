const fs = require('fs')

;(async () => {
  const url = 'https://freemovies.lol/the-trouble-with-tessa/'
  const html = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ww1.surf/netmirror/' },
  }).then((r) => r.text())

  // Save around player
  const pIdx = html.indexOf('player-main')
  console.log('player-main context\n', html.slice(pIdx, pIdx + 2500))

  const eIdx = html.indexOf('embed-host')
  console.log('\nembed-host context\n', html.slice(Math.max(0, eIdx - 200), eIdx + 1500))

  // Find all plugin scripts
  const plugins = [...html.matchAll(/wp-content\/plugins\/[^"']+/g)].map((m) => m[0])
  console.log('\nplugins', [...new Set(plugins)])

  // Fetch episode-related theme/plugin JS
  for (const path of [
    '/wp-content/themes/fmovie/assets/js/min/tv.min.js',
    '/wp-content/themes/fmovie/assets/js/tv.js',
    '/wp-content/plugins/fmovie-core/assets/js/player.js',
    '/wp-content/plugins/fmovie-core/player/player.js',
  ]) {
    const r = await fetch('https://freemovies.lol' + path, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    console.log(path, r.status, r.headers.get('content-type'), (await r.text()).length)
  }

  // List theme js dir via common files referenced
  const themeJs = [...html.matchAll(/wp-content\/themes\/fmovie\/assets\/js\/[^"']+/g)].map((m) => m[0])
  console.log('theme js', [...new Set(themeJs)])
})()
