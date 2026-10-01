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

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim()
}

async function main() {
  // Direct cinextream TV
  for (const url of [
    'https://cinextream.cc/api/embed/tv/97546/1/1?noads=0&autoPlay=1&autoplay=true&asi=0',
    'https://cinextream.cc/api/embed/movie/157336?noads=0&autoPlay=1&autoplay=true&asi=0',
  ]) {
    const p = await get(url)
    const iframes = [...p.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => decode(m[1]))
    const sources = [...p.t.matchAll(/(?:src|file|source)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi)].map(
      (m) => m[1],
    )
    const anyM3u8 = [...p.t.matchAll(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/gi)].map((m) => m[0]).slice(0, 5)
    console.log('\nDIRECT', url)
    console.log({
      status: p.status,
      len: p.t.length,
      iframes: iframes.slice(0, 5),
      sources,
      anyM3u8,
      head: p.t.slice(0, 250).replace(/\s+/g, ' '),
    })
  }

  // Parse JSON-LD from list
  const list = await get('https://cinetaro.to/movie/tv-series?page=1')
  const ld = [...list.t.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1],
  )
  console.log('\nld blocks', ld.length)
  for (const block of ld.slice(0, 2)) {
    try {
      const j = JSON.parse(block)
      const items = j?.itemListElement || j?.['@graph'] || []
      console.log('type', j['@type'], 'items', Array.isArray(items) ? items.length : 0)
      if (Array.isArray(items)) {
        console.log(
          'sample',
          items.slice(0, 3).map((x) => {
            const it = x.item || x
            return { name: it.name, url: it.url, image: it.image, rating: it.aggregateRating?.ratingValue }
          }),
        )
      }
    } catch (e) {
      console.log('parse fail', e.message, block.slice(0, 100))
    }
  }

  // Movies list
  for (const path of ['/movie/movies?page=1', '/movie?page=1', '/movies?page=1', '/movie/film?page=1']) {
    const p = await get(`https://cinetaro.to${path}`)
    const has = p.t.includes('application/ld+json') && p.t.includes('/details/')
    const n = new Set([...p.t.matchAll(/\/details\/(\d+)/g)].map((m) => m[1])).size
    console.log(path, p.status, 'details', n, 'ld', has)
  }

  // Click handler: map hardsub -> player path
  const watch = await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')
  const scripts = [...watch.t.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  const s = scripts.find((x) => x.includes('btn-server') && x.includes('src/player'))
  if (s) {
    const i = s.indexOf('btn-server')
    const j = s.indexOf('src/player')
    console.log('\nclick region', s.slice(Math.min(i, j) - 100, Math.max(i, j) + 400))
  }
}

main().catch(console.error)
