;(async () => {
  // Theme episode script
  const scriptUrl = 'https://freemovies.lol/wp-content/themes/fmovie/assets/js/script.js?ver=4.0.5'
  const js = await fetch(scriptUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) =>
    r.text(),
  )
  console.log('script len', js.length)
  const hits = []
  for (const re of [
    /player_tv[^;]{0,120}/g,
    /tvplayer[^;]{0,120}/g,
    /embed[^;]{0,100}/gi,
    /vidsrc[^;]{0,100}/gi,
    /season[^;]{0,80}/gi,
    /episode[^;]{0,80}/gi,
    /themoviedb[^;]{0,100}/gi,
  ]) {
    const m = [...js.matchAll(re)].map((x) => x[0]).slice(0, 5)
    if (m.length) hits.push([re.source, m])
  }
  console.log(JSON.stringify(hits, null, 2))

  // Player page with imdb
  for (const q of [
    'https://freemovies.lol/?player_tv=tt36957172',
    'https://freemovies.lol/?player_tv=294593',
    'https://freemovies.lol/?player_tv=tt36957172&season=1&episode=1',
    'https://freemovies.lol/?player_tv=294593&season=1&episode=1',
  ]) {
    const r = await fetch(q, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://freemovies.lol/the-trouble-with-tessa/',
      },
    })
    const t = await r.text()
    console.log('\n', q, r.status, t.length)
    const ifr = [...t.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1])
    console.log('iframes', ifr.slice(0, 8))
    const srcs = [...t.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+(?:m3u8|mp4|embed|vidsrc|player)[^"']*)/gi)].map(
      (m) => m[1],
    )
    console.log('media-ish', [...new Set(srcs)].slice(0, 15))
    if (/m3u8|\.mp4/i.test(t)) {
      const media = [...t.matchAll(/https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)[^"'\\\s<>]*/gi)].map((m) => m[0])
      console.log('direct', media.slice(0, 10))
    }
  }

  // TMDB seasons via their key (public-ish key in page)
  const tmdb = await fetch(
    'https://api.themoviedb.org/3/tv/294593?api_key=5c0f02b237bd8226ef5ffa3a86dfdcd5&language=en-US',
  ).then((r) => r.json())
  console.log('\nTMDB', tmdb.name, 'seasons', tmdb.number_of_seasons, 'eps', tmdb.number_of_episodes)
  const s1 = await fetch(
    'https://api.themoviedb.org/3/tv/294593/season/1?api_key=5c0f02b237bd8226ef5ffa3a86dfdcd5&language=en-US',
  ).then((r) => r.json())
  console.log(
    'S1 episodes',
    (s1.episodes || []).slice(0, 5).map((e) => ({ ep: e.episode_number, name: e.name })),
  )
})()
