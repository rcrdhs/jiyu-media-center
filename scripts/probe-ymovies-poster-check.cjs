/** Confirm fixed parser pairs #blackAF with correct poster. */
const ORIGIN = 'https://ww.ymovies.vip'

function parse(html) {
  const links = []
  const parts = html.split(/<div class="ml-item">/i).slice(1)
  for (const part of parts) {
    const mask = part.match(
      /<a[^>]*class="[^"]*ml-mask[^"]*"[^>]*href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
    )
    if (!mask) continue
    links.push({
      title: mask[2],
      id: (mask[1].match(/-(s[a-z0-9]+)$/i) || [])[1],
      poster: mask[3].split('/').pop(),
    })
  }
  return links
}

;(async () => {
  const html = await fetch(ORIGIN + '/movie/search/blackAF', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const hits = parse(html).filter((x) => /black/i.test(x.title))
  console.log(hits.slice(0, 8))
})()
