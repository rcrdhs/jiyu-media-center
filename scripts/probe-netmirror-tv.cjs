;(async () => {
  // TV series category listing + pagination
  for (const url of [
    'https://freemovies.lol/category/tv-series/',
    'https://freemovies.lol/category/tv-series/page/2/',
    'https://freemovies.lol/wp-json/wp/v2/posts?categories=2&per_page=5',
    'https://freemovies.lol/wp-json/wp/v2/categories?per_page=50',
    'https://freemovies.lol/wp-json/fmovie/suggestions/?s=breaking',
  ]) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json, text/html',
          Referer: 'https://freemovies.lol/',
        },
      })
      const ct = res.headers.get('content-type') || ''
      const text = await res.text()
      console.log('\n===', url)
      console.log('status', res.status, 'ct', ct, 'len', text.length)
      if (ct.includes('json')) {
        console.log(text.slice(0, 800))
      } else {
        const cards = [...text.matchAll(/<a[^>]+href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*>[\s\S]*?(?:alt="([^"]*)")?/gi)]
        console.log('card-ish matches', cards.length)
        console.log(
          'samples',
          cards.slice(0, 5).map((m) => ({ href: m[1], img: m[2]?.slice(0, 60), alt: m[3] })),
        )
        const titles = [...text.matchAll(/class="[^"]*title[^"]*"[^>]*>([^<]+)/gi)].map((m) =>
          m[1].trim(),
        )
        console.log('title classes', titles.slice(0, 10))
        const postLinks = [
          ...new Set(
            [...text.matchAll(/href="(https:\/\/freemovies\.lol\/[a-z0-9-]+\/)"/gi)].map((m) => m[1]),
          ),
        ].filter((h) => !/category|tag|page|wp-|author/i.test(h))
        console.log('post links', postLinks.slice(0, 15))
      }
    } catch (e) {
      console.log(url, e.message)
    }
  }

  // Netmirror SPA bundle
  const js = await fetch('https://netmirror-app.pages.dev/js/index-CuUuhySN.js').then((r) =>
    r.text(),
  )
  console.log('\nSPA js len', js.length)
  const urls = [...new Set([...js.matchAll(/https?:\\?\/\\?\/[a-zA-Z0-9._\-/:]+/g)].map((m) =>
    m[0].replace(/\\\//g, '/'),
  ))]
  console.log('spa urls', urls.slice(0, 40))
  const apiBits = [...js.matchAll(/["'`](\/?api[^"'`]{0,80}|wefeed[^"'`]{0,40}|tv-series[^"'`]{0,40})["'`]/gi)].map(
    (m) => m[1],
  )
  console.log('spa api bits', [...new Set(apiBits)].slice(0, 40))
})()
