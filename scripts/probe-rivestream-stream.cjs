const TMDB_KEY = 'd64117f26031a428449f102ced3aba73'
const SHOWS = [
  { name: 'Game of Thrones', id: 1399 },
  { name: 'Breaking Bad', id: 1396 },
  { name: 'Stranger Things', id: 66732 },
  { name: 'The Office', id: 2316 },
  { name: 'Reacher', id: 108978 },
]

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text: text.slice(0, 300) }
}

async function main() {
  const discover = await get(
    `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&language=en-US&sort_by=popularity.desc&page=1`,
  )
  console.log('TMDB discover/tv:', {
    total_results: discover.json?.total_results,
    total_pages: discover.json?.total_pages,
    page1: discover.json?.results?.length,
    first: discover.json?.results?.[0]?.name,
  })

  const embedJs = await fetch('https://rivestream.ru/_next/static/chunks/pages/embed-a2f4195a653b219d.js').then((r) =>
    r.text(),
  )
  const backendHits = [...new Set([...embedJs.matchAll(/https:\/\/[^\"']+rivestream[^\"']{0,80}/g)].map((m) => m[0]))]
  console.log('\nembed backend urls', backendHits)

  for (const term of ['backend.rivestream', 'scrapper', 'stream', 'source', 'm3u8', 'login', 'signIn', 'firebase']) {
    const i = embedJs.indexOf(term)
    if (i >= 0) console.log('embed', term, embedJs.slice(Math.max(0, i - 20), i + 120))
  }

  const streamPaths = [
    (id) => `https://backend.rivestream.app/stream/tv/${id}/1/1`,
    (id) => `https://backend.rivestream.app/api/stream/tv/${id}/1/1`,
    (id) => `https://backend.rivestream.app/v1/stream/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/stream/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/tv/${id}/1/1`,
    (id) => `https://bff.rivestream.app/api/v1/stream/tv/${id}/1/1`,
    (id) => `https://proxy.valhallastream.com/?destination=https://backend.rivestream.app/stream/tv/${id}/1/1`,
  ]

  console.log('\n=== Stream resolution probes ===')
  for (const show of SHOWS.slice(0, 2)) {
    for (const fn of streamPaths) {
      const url = fn(show.id)
      const r = await get(url)
      if (r.status !== 404) {
        console.log(show.name, url, r.status, r.json ? JSON.stringify(r.json).slice(0, 200) : r.text)
      }
    }
  }
}

main().catch(console.error)
