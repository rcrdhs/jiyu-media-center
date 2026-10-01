;(async () => {
  const ua = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://ww1.surf/netmirror/',
  }

  const html = await fetch('https://freemovies.lol/category/tv-series/', { headers: ua }).then((r) =>
    r.text(),
  )
  const pageNums = [...html.matchAll(/\/category\/tv-series\/page\/(\d+)\//g)].map((m) => Number(m[1]))
  const maxFromNav = pageNums.length ? Math.max(...pageNums) : 0
  console.log('max page link in nav', maxFromNav)

  const cat = await fetch(
    'https://freemovies.lol/wp-json/wp/v2/categories?slug=tv-series&_fields=id,count,name',
    { headers: ua },
  ).then((r) => r.json())
  const count = Array.isArray(cat) ? cat[0]?.count : null
  console.log('wp tv-series count', count)
  console.log('pages at 32/page', count != null ? Math.ceil(count / 32) : null)

  // Confirm last page
  for (const p of [maxFromNav, maxFromNav + 1, 146, 147]) {
    if (!p) continue
    const url = `https://freemovies.lol/category/tv-series/page/${p}/`
    const r = await fetch(url, { headers: ua, redirect: 'manual' })
    const t = r.status === 200 ? await r.text() : ''
    const posts = [...t.matchAll(/id="post-\d+"/g)].length
    console.log({ page: p, status: r.status, posts })
  }
})()
