async function main() {
  const home = await fetch('https://rivestream.ru/tv', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())

  const scripts = [...home.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1])
  console.log('scripts', scripts.slice(0, 10))

  for (const src of scripts.slice(0, 5)) {
    const url = src.startsWith('http') ? src : `https://rivestream.ru${src.startsWith('/') ? '' : '/'}${src}`
    const js = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
    for (const term of [
      'discover/tv',
      'total_results',
      'total_pages',
      '/api/',
      'tmdb',
      'embed?type=tv',
      'signIn',
      'login',
    ]) {
      const i = js.indexOf(term)
      if (i >= 0) console.log(src, term, js.slice(Math.max(0, i - 30), i + 80))
    }
  }

  const tries = [
    'https://rivestream.ru/api/tmdb/discover/tv?page=1',
    'https://rivestream.ru/api/tmdb/tv/popular?page=1',
    'https://rivestream.ru/api/tmdb/tv/1399',
    'https://rivestream.ru/api/tmdb/tv/1399/season/1',
    'https://rivestream.ru/api/tmdb/tv/1399/season/1/episode/1',
    'https://rivestream.ru/api/media/tv/1399',
    'https://rivestream.ru/api/stream/tv/1399/1/1',
  ]
  for (const url of tries) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
    const ct = res.headers.get('content-type') || ''
    const body = await res.text()
    console.log('\n', url, res.status, ct.slice(0, 40), body.slice(0, 300))
  }
}

main().catch(console.error)
