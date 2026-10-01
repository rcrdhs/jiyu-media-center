async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      Referer: 'https://cinetaro.to/',
    },
  })
  return { status: r.status, t: await r.text() }
}

async function main() {
  const movieId = '157336'
  const epId = `${movieId}-1-1`
  for (const kind of ['sub', 'dub']) {
    const url = `https://cinetaro.to/src/player/${kind}.php?id=${encodeURIComponent(epId)}&server=maple&embed=true&ep=1&autoPlay=1`
    const p = await get(url)
    const iframes = [...p.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
    console.log(kind, p.status, iframes[0] || p.t.slice(0, 200).replace(/\s+/g, ' '))
  }

  // Direct cinextream for movie?
  const direct = `https://cinextream.cc/api/embed/movie/${movieId}?noads=0&autoPlay=1&autoplay=true&asi=0`
  const d = await get(direct)
  console.log('direct movie embed', d.status, d.t.slice(0, 200).replace(/\s+/g, ' '))

  const list = await get('https://cinetaro.to/movie/tv-series?page=1')
  // dump a snippet around first details link
  const idx = list.t.indexOf('/details/')
  console.log('list snippet', list.t.slice(Math.max(0, idx - 80), idx + 600).replace(/\s+/g, ' '))

  // count pages hint
  const pageLinks = [...list.t.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]))
  console.log('max page link', Math.max(0, ...pageLinks), 'unique details', new Set([...list.t.matchAll(/\/details\/(\d+)/g)].map((m) => m[1])).size)

  // watch page seasons
  const watch = await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')
  const seasons = [...watch.t.matchAll(/data-season=["'](\d+)["']/gi)].map((m) => m[1])
  const eps = [...watch.t.matchAll(/data-id=["'](\d+-\d+-\d+)["'][^>]*>[\s\S]{0,200}?Episode\s*(\d+)/gi)].slice(0, 5)
  console.log('seasons sample', [...new Set(seasons)].slice(0, 20))
  console.log(
    'eps',
    eps.map((m) => ({ id: m[1], ep: m[2] })),
  )
  const epBlocks = [...watch.t.matchAll(/data-id=["'](\d+)-(\d+)-(\d+)["']/g)].slice(0, 15)
  console.log(
    'data-ids',
    epBlocks.map((m) => `${m[1]}-${m[2]}-${m[3]}`),
  )
}

main().catch(console.error)
