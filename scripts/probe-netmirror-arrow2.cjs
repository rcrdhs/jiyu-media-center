;(async () => {
  const ua = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://ww1.surf/netmirror/',
  }

  const html = await fetch('https://freemovies.lol/arrow/', { headers: ua }).then((r) => r.text())
  console.log('len', html.length)
  console.log('title', html.match(/<title>([^<]*)<\/title>/i)?.[1])
  console.log('og:title', html.match(/property="og:title"[^>]+content="([^"]+)"/i)?.[1])
  const cats = [...html.matchAll(/rel="category tag"[^>]*>([^<]+)</gi)].map((m) => m[1])
  console.log('cats', cats)
  const catLinks = [...html.matchAll(/href="(https:\/\/freemovies\.lol\/category\/[^"]+)"[^>]*rel="category/gi)].map(
    (m) => m[1],
  )
  console.log('catLinks', catLinks)

  // post id
  const postId = html.match(/comment_post_ID['"]?\s*value=['"](\d+)/i)?.[1]
  console.log('postId', postId)
  const article = html.match(/id="post-(\d+)"/)?.[1]
  console.log('article', article)

  // WP by slug
  const wp = await fetch('https://freemovies.lol/wp-json/wp/v2/posts?slug=arrow&_fields=id,link,title,categories,status', {
    headers: ua,
  }).then((r) => r.json())
  console.log('wp slug', wp)

  // categories list for tv
  const catsWp = await fetch(
    'https://freemovies.lol/wp-json/wp/v2/categories?search=tv&per_page=20&_fields=id,name,slug,count',
    { headers: ua },
  ).then((r) => r.json())
  console.log('cats wp', catsWp)

  // Is Arrow on NetMirror wrapper site differently?
  for (const url of [
    'https://ww1.surf/netmirror/',
    'https://netmirror-app.pages.dev/',
  ]) {
    try {
      const r = await fetch(url, { headers: ua, redirect: 'follow' })
      const t = await r.text()
      console.log('\n', url, r.status, r.url, 'len', t.length)
      console.log('iframe', [...t.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1]).slice(0, 5))
      console.log('snippet', t.slice(0, 400).replace(/\s+/g, ' '))
    } catch (e) {
      console.log(url, e.message)
    }
  }
})()
