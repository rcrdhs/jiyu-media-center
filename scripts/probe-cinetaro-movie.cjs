async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      Referer: 'https://cinetaro.to/',
    },
  })
  return { status: r.status, t: await r.text(), ct: r.headers.get('content-type') }
}

async function main() {
  // Movie: try Interstellar TMDB 157336
  const movieId = '157336'
  const watch = await get(`https://cinetaro.to/watch/${movieId}`)
  console.log('movie watch', watch.status, watch.t.length)
  const epIds = [...watch.t.matchAll(/data-id=["']([^"']+)["']/g)].map((m) => m[1]).slice(0, 10)
  console.log('ep ids', epIds)

  const servers = await get(
    `https://cinetaro.to/src/ajax/anime/server.php?episodeId=${encodeURIComponent(movieId)}`,
  )
  console.log('movie servers', servers.status, servers.t.slice(0, 500))

  const servers2 = await get(
    `https://cinetaro.to/src/ajax/anime/server.php?episodeId=${encodeURIComponent(movieId + '-1-1')}`,
  )
  console.log('movie servers -1-1', servers2.status, servers2.t.slice(0, 500))

  for (const sid of ['maple', '1']) {
    for (const kind of ['sub', 'dub']) {
      const url = `https://cinetaro.to/src/player/${kind}.php?id=${encodeURIComponent(movieId)}&server=${sid}&embed=true&ep=1&autoPlay=1`
      const p = await get(url)
      const iframes = [...p.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
      console.log(kind, sid, p.status, iframes[0] || p.t.slice(0, 120).replace(/\s+/g, ' '))
    }
  }

  // List page sample
  const list = await get('https://cinetaro.to/movie/tv-series?page=1')
  const cards = [...list.t.matchAll(/href="(\/details\/(\d+)\?tv)"[\s\S]{0,400}?alt="([^"]*)"/gi)].slice(0, 5)
  console.log(
    'list cards',
    cards.map((m) => ({ href: m[1], id: m[2], title: m[3] })),
  )
  const posters = [...list.t.matchAll(/\/details\/(\d+)\?tv[\s\S]{0,600}?src="(https?:\/\/[^"]+)"/gi)].slice(0, 3)
  console.log('posters', posters.map((m) => ({ id: m[1], poster: m[2] })))

  // movies list
  const movies = await get('https://cinetaro.to/movie/movies?page=1')
  console.log('movies page', movies.status, movies.t.includes('/details/'))
  const mc = [...movies.t.matchAll(/href="(\/details\/(\d+))(?!\?tv)"/gi)].slice(0, 5)
  console.log(
    'movie cards',
    mc.map((m) => ({ href: m[1], id: m[2] })),
  )
}

main().catch(console.error)
