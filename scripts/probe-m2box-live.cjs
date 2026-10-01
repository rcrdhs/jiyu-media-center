const fs = require('fs')

async function probe(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  const html = await res.text()
  const hasNuxt = html.includes('__NUXT_DATA__')
  const hasDetail = html.includes('/detail/')
  console.log(url, 'len', html.length, 'nuxt', hasNuxt, 'detail', hasDetail)
  if (!hasNuxt) {
    fs.writeFileSync(__dirname + '/m2box-live-fail.html', html)
  }
}

;(async () => {
  await probe('https://m2box.org/web/tv-series')
})()
