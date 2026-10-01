;(async () => {
  const html = await fetch('https://freemovies.lol/category/tv-series/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const items = []
  const re =
    /id="post-(\d+)"[\s\S]*?<a href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>\s*<img[^>]+data-src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<span>(\d{4})<\/span>\s*<span class="type">([^<]*)<\/span>\s*<span>([^<]*)<\/span>/gi
  let m
  while ((m = re.exec(html))) {
    items.push({
      id: m[1],
      url: m[2],
      poster: m[3],
      title: m[4],
      year: m[5],
      type: m[6].trim(),
      ep: m[7].trim(),
    })
  }
  console.log('parsed', items.length)
  console.log(items.slice(0, 5))
  const pages = [...html.matchAll(/category\/tv-series\/page\/(\d+)\//g)].map((x) => Number(x[1]))
  console.log('max page link', Math.max(0, ...pages))
})()
