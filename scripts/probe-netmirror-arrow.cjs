;(async () => {
  const ua = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://ww1.surf/netmirror/',
  }

  // Direct detail
  for (const path of ['/arrow/', '/tv/arrow/', '/series/arrow/']) {
    const r = await fetch('https://freemovies.lol' + path, { headers: ua, redirect: 'follow' })
    console.log('detail', path, r.status, r.url)
  }

  // Search
  const search = await fetch('https://freemovies.lol/?s=Arrow', { headers: ua }).then((r) => r.text())
  const titles = [...search.matchAll(/alt="([^"]*Arrow[^"]*)"/gi)].map((m) => m[1])
  console.log('search alts', [...new Set(titles)].slice(0, 20))
  const hrefs = [...search.matchAll(/href="(https:\/\/freemovies\.lol\/[^"]*arrow[^"]*)"/gi)].map(
    (m) => m[1],
  )
  console.log('search hrefs', [...new Set(hrefs)].slice(0, 10))

  // WP JSON search
  const wp = await fetch(
    'https://freemovies.lol/wp-json/wp/v2/posts?search=Arrow&per_page=20&_fields=id,link,title,categories',
    { headers: ua },
  ).then((r) => r.json())
  console.log(
    'wp',
    Array.isArray(wp)
      ? wp.map((p) => ({ id: p.id, title: p.title?.rendered, link: p.link, cats: p.categories }))
      : wp,
  )

  // Scan category pages for Arrow (sample first 5 + binary-ish later pages)
  const re =
    /id="post-(\d+)"[\s\S]*?<a href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>\s*<img[^>]+data-src="([^"]+)"[^>]*alt="([^"]*)"/gi
  async function pageHasArrow(page) {
    const url =
      page <= 1
        ? 'https://freemovies.lol/category/tv-series/'
        : `https://freemovies.lol/category/tv-series/page/${page}/`
    const html = await fetch(url, { headers: ua }).then((r) => r.text())
    const links = []
    let m
    re.lastIndex = 0
    while ((m = re.exec(html))) {
      links.push({ title: m[4], url: m[2] })
    }
    const hit = links.find((l) => /^arrow$/i.test(l.title.trim()) || /^arrow\b/i.test(l.title.trim()))
    return { page, count: links.length, hit: hit || null, sample: links.slice(0, 3).map((l) => l.title) }
  }

  for (const p of [1, 2, 10, 50, 100, 120, 146]) {
    const r = await pageHasArrow(p)
    console.log(JSON.stringify(r))
    await new Promise((r) => setTimeout(r, 300))
  }
})()
