async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html',
      Referer: 'https://cinetaro.to/',
    },
  })
  return r.text()
}

async function main() {
  const html = await get('https://cinetaro.to/movie/tv-series?page=1')
  const ld = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1],
  )
  for (const block of ld) {
    try {
      const j = JSON.parse(block)
      const items = j?.itemListElement
      if (Array.isArray(items)) console.log('ItemList', items.length)
    } catch {}
  }
  // film-poster / flw-item style cards?
  for (const cls of ['flw-item', 'film-poster', 'movie-item', 'item-card', 'media-card', 'grid-item']) {
    const n = (html.match(new RegExp(`class="[^"]*${cls}`, 'gi')) || []).length
    if (n) console.log('class', cls, n)
  }
  // All detail links with nearby title
  const ids = [...new Set([...html.matchAll(/\/details\/(\d+)\?tv/g)].map((m) => m[1]))]
  console.log('unique tv details', ids.length)

  // Try extracting from data attributes / card markup near first detail
  const i = html.indexOf('/details/')
  console.log(html.slice(i - 200, i + 800).replace(/\s+/g, ' '))
}

main().catch(console.error)
