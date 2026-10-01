const url = 'https://nyaa.si/?f=0&c=1_2&q=eternal+supreme&s=seeders&o=desc'
;(async () => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0' },
  })
  const html = await res.text()
  console.log('status', res.status, 'len', html.length, 'magnets', (html.match(/magnet:/g) || []).length)
  const row = html.match(/<tr[\s\S]*?magnet:[\s\S]*?<\/tr>/i)
  console.log('row sample', row ? row[0].slice(0, 900).replace(/\s+/g, ' ') : 'none')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
