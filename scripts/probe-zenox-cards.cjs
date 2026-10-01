const fs = require('fs')

async function fetchPage(page) {
  const url = `https://zenox.lol/tv?genre=16&page=${page}`
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  })
  const html = await r.text()
  const titles = [...html.matchAll(/<h3[^>]*>([^<]{1,160})<\/h3>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim(),
  )
  const years = [...html.matchAll(/>(19\d{2}|20\d{2})<\//g)].map((m) => m[1])
  const posters = [
    ...html.matchAll(/image\.tmdb\.org\/t\/p\/w500\/([a-zA-Z0-9]+)\.jpg/g),
  ].map((m) => m[1])

  // Flight with router state often embeds full card payloads
  const flight = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/x-component',
      RSC: '1',
    },
  })
  const text = await flight.text()
  if (page === 1) fs.writeFileSync('scripts/zenox-flight-p1.txt', text)

  // Prefer explicit media keys / id fields near titles
  const cards = []
  // Pattern seen in many next apps: id,title,posterPath close together
  const blockRe =
    /"id":(\d{2,8}).{0,120}?"title":"((?:\\.|[^"\\])+)".{0,200}?"posterPath":("([^"]+)"|null)/gs
  let m
  while ((m = blockRe.exec(text))) {
    cards.push({
      id: m[1],
      title: m[2].replace(/\\"/g, '"').replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      ),
      posterPath: m[4] || null,
    })
  }
  // Looser: "id":N ... genreIds
  if (cards.length === 0) {
    const loose = [
      ...text.matchAll(
        /\{"id":(\d{2,8}),"mediaType":"tv","title":"((?:\\.|[^"\\])+)"/g,
      ),
    ]
    for (const x of loose) {
      cards.push({
        id: x[1],
        title: x[2].replace(/\\"/g, '"'),
        posterPath: null,
      })
    }
  }

  return {
    page,
    htmlTitles: titles.length,
    titles: titles.slice(0, 5),
    posters: posters.length,
    flightLen: text.length,
    cards: cards.length,
    sampleCards: cards.slice(0, 8),
    hasReborn: text.includes('REBORN'),
    // dump a window around first known id
    ctx94664: (() => {
      const i = text.indexOf('94664')
      return i >= 0 ? text.slice(i - 80, i + 160) : null
    })(),
  }
}

async function main() {
  console.log(JSON.stringify(await fetchPage(1), null, 2))
  console.log(JSON.stringify(await fetchPage(2), null, 2))

  // Classify a few via details
  const ids = [45857, 456, 82728, 94664, 60625, 1434]
  for (const id of ids) {
    const d = await (
      await fetch('https://zenox.lol/api/details/tv/' + id, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      })
    ).json()
    const det = d.details || {}
    console.log(
      JSON.stringify({
        id,
        title: det.title,
        lang: det.originalLanguage,
        genreIds: det.genreIds,
        genres: (det.genres || []).map((g) => g.name),
      }),
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
