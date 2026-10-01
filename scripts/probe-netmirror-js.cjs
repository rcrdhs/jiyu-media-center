const fs = require('fs')

;(async () => {
  const jsUrl = 'https://freemovies.lol/wp-content/themes/fmovie/assets/js/min/episodes.min.js?ver=1787217692'
  const js = await fetch(jsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
  fs.writeFileSync('D:/app/scripts/netmirror-episodes.min.js', js)
  console.log('len', js.length)

  // Extract readable chunks around embed hosts
  for (const key of ['embedru', 'superembed', 'vidsrc', 'data-load-embed', 'player_tv', 'iframe', 'tmdb', 'season']) {
    const i = js.indexOf(key)
    console.log('\n==', key, i)
    if (i >= 0) console.log(js.slice(Math.max(0, i - 120), i + 400))
  }

  // Also script.js for play button
  const script = await fetch('https://freemovies.lol/wp-content/themes/fmovie/assets/js/script.js?ver=4.0.5', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  fs.writeFileSync('D:/app/scripts/netmirror-script.js', script)
  for (const key of ['embedru', 'load-embed', 'player_tv', 'iframe', 'data-src']) {
    const i = script.indexOf(key)
    console.log('\nscript', key, i)
    if (i >= 0) console.log(script.slice(Math.max(0, i - 80), i + 350))
  }
})()
