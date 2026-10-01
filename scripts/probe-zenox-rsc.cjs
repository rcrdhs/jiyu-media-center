const fs = require('fs')

async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }

  // Search API shape
  for (const q of ['bleach', 'REBORN', 'Simpsons', 'Bluey']) {
    const r = await fetch('https://zenox.lol/api/search?q=' + encodeURIComponent(q), {
      headers: { ...headers, Accept: 'application/json' },
    })
    const j = await r.json()
    console.log(
      q,
      JSON.stringify(
        (j.results || []).slice(0, 3).map((x) => ({
          id: x.id,
          title: x.title,
          mediaType: x.mediaType,
          genreIds: x.genreIds,
          originalLanguage: x.originalLanguage,
          releaseDate: x.releaseDate,
        })),
      ),
    )
  }

  // Fetch RSC and dump any numeric ids / titles
  const rsc = await fetch('https://zenox.lol/tv?genre=16&page=1', {
    headers: {
      ...headers,
      Accept: 'text/x-component',
      RSC: '1',
      'Next-Router-Prefetch': '1',
      'Next-Url': '/tv?genre=16&page=1',
    },
  })
  const text = await rsc.text()
  fs.writeFileSync('scripts/zenox-rsc-genre16.txt', text)
  console.log('rsc len', text.length)

  // Extract escaped JSON-ish objects with title + id
  const idTitle = []
  const re =
    /\{[^\\]{0,40}?"id"\s*:\s*(\d{2,8})[^\\]{0,200}?"title"\s*:\s*"((?:\\.|[^"\\]){1,120})"/g
  let m
  while ((m = re.exec(text))) {
    idTitle.push({ id: m[1], title: m[2] })
  }
  // alternate order title then id
  const re2 =
    /"title"\s*:\s*"((?:\\.|[^"\\]){1,120})"[\s\S]{0,200}?"id"\s*:\s*(\d{2,8})/g
  while ((m = re2.exec(text))) {
    idTitle.push({ id: m[2], title: m[1] })
  }
  console.log('idTitle hits', idTitle.length, idTitle.slice(0, 10))

  // Look for posterPath + id pairs
  const posters = [...text.matchAll(/\/([a-zA-Z0-9]{20,})\.jpg/g)].map((x) => x[1])
  console.log('poster hashes in rsc', posters.length, posters.slice(0, 5))

  // Decode common RSC string escaping: look for "REBORN"
  const idx = text.indexOf('REBORN')
  console.log('REBORN ctx', text.slice(Math.max(0, idx - 100), idx + 200))

  // Try Next.js flight with different headers used by app router
  const flight = await fetch('https://zenox.lol/tv?genre=16&page=1', {
    headers: {
      ...headers,
      RSC: '1',
      'Next-Router-State-Tree':
        '%5B%22%22%2C%7B%22children%22%3A%5B%22tv%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22genre%5C%22%3A%5C%2216%5C%22%7D%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
    },
  })
  const flightText = await flight.text()
  fs.writeFileSync('scripts/zenox-flight-genre16.txt', flightText)
  console.log('flight len', flightText.length, 'REBORN', flightText.includes('REBORN'))
  const nums = [...flightText.matchAll(/\b(1[0-9]{4,7}|[2-9][0-9]{4,7})\b/g)].map((x) => x[1])
  console.log('numeric candidates', [...new Set(nums)].slice(0, 40))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
