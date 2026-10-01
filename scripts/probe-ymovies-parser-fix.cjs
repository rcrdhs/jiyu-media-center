/** Smoke-test fixed YMovies list parser poster pairing. */
const ORIGIN = 'https://ww.ymovies.vip'

function decodeHtmlEntities(raw) {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .trim()
}

function parseYmoviesListHtml(html, origin = ORIGIN) {
  const links = []
  const seen = new Set()
  const parts = html.split(/<div class="ml-item">/i).slice(1)
  for (const part of parts) {
    const mask =
      part.match(
        /<a[^>]*class="[^"]*ml-mask[^"]*"[^>]*href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
      ) ||
      part.match(
        /href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
      )
    if (!mask) continue
    const path = mask[1]
    const url = origin + path
    if (seen.has(url)) continue
    seen.add(url)
    links.push({
      title: decodeHtmlEntities(mask[2]),
      posterFile: mask[3].split('/').pop(),
      id: (path.match(/-(s[a-z0-9]+)$/i) || [])[1],
    })
  }
  return links
}

;(async () => {
  const html = await fetch(ORIGIN + '/movie/filter/series/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const links = parseYmoviesListHtml(html)
  console.log('count', links.length)
  console.log(links.slice(0, 5))

  const search = await fetch(ORIGIN + '/movie/search/blackAF', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const black = parseYmoviesListHtml(search).find((x) => /blackaf/i.test(x.id || ''))
  console.log('blackAF', black)
})()
