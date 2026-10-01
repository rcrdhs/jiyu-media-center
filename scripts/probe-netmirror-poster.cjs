;(async () => {
  const p = await fetch(
    'https://freemovies.lol/wp-json/wp/v2/posts/15329?_embed=1',
    { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
  ).then((r) => r.json())
  console.log('keys', Object.keys(p))
  console.log('meta', p.meta)
  console.log('acf', p.acf)
  console.log('featured_media', p.featured_media)
  console.log('embedded keys', p._embedded && Object.keys(p._embedded))
  console.log('yoast', p.yoast_head_json?.og_image)

  // class_list / custom
  for (const k of Object.keys(p)) {
    if (/poster|image|thumb|cover|tmdb|imdb/i.test(k)) console.log(k, p[k])
  }

  const html = await fetch('https://freemovies.lol/category/tv-series/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  // find structure around first show link
  const idx = html.indexOf('the-trouble-with-tessa')
  console.log('html context\n', html.slice(Math.max(0, idx - 400), idx + 500))
})()
