const API = 'https://bff.rivestream.app/api/v1'

async function get(path) {
  const url = `${API}${path}`
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
  return { url, status: res.status, json, text: text.slice(0, 500) }
}

async function main() {
  const tries = [
    '/discover/tv?page=1&language=en-US&sort_by=popularity.desc',
    '/discover/tv?with_genres=&language=en-US&sort_by=popularity.desc&page=1',
    '/tmdb/discover/tv?page=1',
    '/tv/popular?page=1',
    '/tv/1399',
    '/tv/1399/season/1',
    '/tv/1399/season/1/episode/1',
    '/stream/tv/1399/1/1',
    '/embed/tv/1399/1/1',
    '/media/tv/1399/season/1/episode/1',
  ]
  for (const path of tries) {
    const r = await get(path)
    console.log('\n', path, r.status)
    if (r.json) {
      const keys = Object.keys(r.json)
      console.log('keys', keys)
      if (r.json.total_results != null) console.log('total_results', r.json.total_results, 'total_pages', r.json.total_pages)
      if (Array.isArray(r.json.results)) console.log('results', r.json.results.length, r.json.results[0]?.name || r.json.results[0]?.title)
      else console.log(JSON.stringify(r.json).slice(0, 400))
    } else console.log(r.text)
  }
}

main().catch(console.error)
