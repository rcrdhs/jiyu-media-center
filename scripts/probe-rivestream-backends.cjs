async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
      ...headers,
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text: text.slice(0, 400) }
}

async function main() {
  const bases = [
    'https://scrapper.rivestream.app',
    'https://backend.rivestream.app',
    'https://recommendation.rivestream.app',
  ]
  const paths = [
    '/discover/tv?page=1&language=en-US&sort_by=popularity.desc',
    '/api/discover/tv?page=1',
    '/api/v1/discover/tv?page=1',
    '/tmdb/discover/tv?page=1',
    '/tv/1399',
    '/stream/tv/1399/1/1',
    '/embed/tv/1399/1/1',
  ]
  for (const base of bases) {
    for (const path of paths) {
      const r = await get(base + path)
      if (r.status !== 404) {
        console.log(base + path, r.status)
        if (r.json?.total_results != null) {
          console.log('  total_results', r.json.total_results, 'total_pages', r.json.total_pages)
        } else if (r.json) console.log(' ', JSON.stringify(r.json).slice(0, 200))
        else console.log(' ', r.text)
      }
    }
  }

  const embedJs = await fetch('https://rivestream.ru/_next/static/chunks/pages/embed-a2f4195a653b219d.js').then((r) =>
    r.text(),
  )
  for (const term of ['login', 'signIn', 'm3u8', 'source', 'stream', 'backend', 'scrapper', 'api.']) {
    const i = embedJs.indexOf(term)
    if (i >= 0) console.log('embed js', term, embedJs.slice(Math.max(0, i - 40), i + 100))
  }
}

main().catch(console.error)
