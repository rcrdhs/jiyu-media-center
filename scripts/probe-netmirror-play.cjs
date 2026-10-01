;(async () => {
  // Detail page for a known series
  const url = 'https://freemovies.lol/tvf-pitchers/'
  const html = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ww1.surf/netmirror/' },
  }).then((r) => r.text())

  // Episodes config
  const epMatch = html.match(/var Episodes\s*=\s*(\{[\s\S]*?\});/)
  if (epMatch) {
    try {
      const ep = JSON.parse(epMatch[1])
      console.log('Episodes keys', Object.keys(ep))
      console.log(JSON.stringify(ep, null, 2).slice(0, 2500))
    } catch (e) {
      console.log('Episodes parse fail', e.message, epMatch[1].slice(0, 500))
    }
  } else {
    console.log('no Episodes var')
  }

  // player iframes / sources
  const iframes = [...html.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1])
  console.log('iframes', iframes.slice(0, 10))

  const playHints = [...html.matchAll(/(?:player|embed|vidsrc|stream|watch)[^"'\\\s]{0,80}/gi)]
    .map((m) => m[0])
    .slice(0, 30)
  console.log('playHints', [...new Set(playHints)])

  // ajax / rest endpoints
  const ajax = [...html.matchAll(/admin-ajax\.php[^"'\\\s]*/gi)].map((m) => m[0])
  console.log('ajax', [...new Set(ajax)])

  // Try common player_tv query
  const postId = html.match(/"post_id"\s*:\s*"?(\d+)/)?.[1]
  const tvid = html.match(/"tvid"\s*:\s*"?(\d+)/)?.[1]
  const imdb = html.match(/"tvimdbid"\s*:\s*"([^"]+)"/)?.[1]
  console.log({ postId, tvid, imdb })

  for (const tryUrl of [
    `https://freemovies.lol/?player_tv=${tvid}`,
    `https://freemovies.lol/?player_tv=${imdb}`,
    postId ? `https://freemovies.lol/wp-admin/admin-ajax.php?action=ajax_player&post_id=${postId}` : null,
  ].filter(Boolean)) {
    const r = await fetch(tryUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
      redirect: 'follow',
    })
    const t = await r.text()
    console.log('\ntry', tryUrl, r.status, t.length)
    console.log(t.slice(0, 400))
  }
})()
