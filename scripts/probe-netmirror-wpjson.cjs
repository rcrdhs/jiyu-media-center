;(async () => {
  const cats = await fetch('https://freemovies.lol/wp-json/wp/v2/categories?per_page=100', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  }).then((r) => r.json())
  const tv = cats.filter((c) => /tv|series|show/i.test(c.slug + c.name))
  console.log(
    'tv cats',
    tv.map((c) => ({ id: c.id, slug: c.slug, name: c.name, count: c.count })),
  )

  const tvCat = tv.find((c) => c.slug === 'tv-series') || tv[0]
  console.log('using', tvCat)

  const res = await fetch(
    `https://freemovies.lol/wp-json/wp/v2/posts?categories=${tvCat.id}&per_page=20&page=1&_embed=1`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    },
  )
  console.log('total pages header', res.headers.get('x-wp-totalpages'), 'total', res.headers.get('x-wp-total'))
  const posts = await res.json()
  for (const p of posts.slice(0, 5)) {
    const media = p._embedded?.['wp:featuredmedia']?.[0]
    console.log({
      id: p.id,
      title: p.title?.rendered,
      link: p.link,
      excerpt: p.excerpt?.rendered?.replace(/<[^>]+>/g, '').slice(0, 120),
      poster: media?.source_url || media?.media_details?.sizes?.medium?.source_url,
      date: p.date,
    })
  }

  // last page existence
  const totalPages = Number(res.headers.get('x-wp-totalpages') || 0)
  console.log('totalPages', totalPages)
  if (totalPages > 1) {
    const last = await fetch(
      `https://freemovies.lol/wp-json/wp/v2/posts?categories=${tvCat.id}&per_page=20&page=${Math.min(totalPages, 50)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
    ).then((r) => r.json())
    console.log('page sample count', last.length, 'first', last[0]?.title?.rendered)
  }
})()
