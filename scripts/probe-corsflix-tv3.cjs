async function countTvLinks(url) {
  const html = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
  }).then((r) => r.text())
  const paths = new Set()
  for (const m of html.matchAll(/\/tv\/[a-z0-9-]+-\d+/gi)) paths.add(m[0].toLowerCase())
  return { url, htmlLen: html.length, count: paths.size }
}

async function main() {
  const pages = [
    'https://watch.corsflix.net/tv',
    'https://watch.corsflix.net/tv/search?q=the',
    'https://watch.corsflix.net/tv/search?q=a',
    'https://watch.corsflix.net/tv?page=2',
    'https://watch.corsflix.net/tv/popular',
    'https://watch.corsflix.net/tv/browse',
  ]
  for (const url of pages) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
      })
      const html = await res.text()
      const paths = new Set()
      for (const m of html.matchAll(/\/tv\/[a-z0-9-]+-\d+/gi)) paths.add(m[0].toLowerCase())
      console.log(res.status, url, 'len', html.length, 'tv slugs', paths.size)
    } catch (e) {
      console.log('fail', url, e.message)
    }
  }

  // RSC flight chunks sometimes embed total counts
  const home = await fetch('https://watch.corsflix.net/tv', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const totals = home.match(/total_(?:pages|results)[^0-9]{0,5}\d+/gi)
  console.log('total hints', totals?.slice(0, 10))
  const flight = home.match(/self\.__next_f\.push/g)
  console.log('next flight chunks', flight?.length ?? 0)
}

main().catch(console.error)
