async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/json',
  }

  const home = await fetch('https://watch.corsflix.net/tv', { headers }).then((r) => ({
    status: r.status,
    text: r.text(),
  }))
  const html = await home.text
  console.log('home status', home.status, 'len', html.length)

  const apiHints = [
    ...html.matchAll(/\/api\/[a-zA-Z0-9_/-]+/g),
    ...html.matchAll(/tmdb[^"'\s]{0,80}/gi),
    ...html.matchAll(/discover[^"'\s]{0,80}/gi),
  ].map((m) => m[0])
  console.log('api hints', [...new Set(apiHints)].slice(0, 30))

  const scriptSrc = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1])
  console.log('scripts', scriptSrc.slice(0, 15))

  // Try common TMDB-proxy patterns
  const tries = [
    'https://watch.corsflix.net/api/tv?page=1',
    'https://watch.corsflix.net/api/discover/tv?page=1',
    'https://watch.corsflix.net/api/v1/tv?page=1',
    'https://watch.corsflix.net/tv?page=1',
    'https://watch.corsflix.net/tv/all',
    'https://watch.corsflix.net/sitemap.xml',
  ]
  for (const url of tries) {
    try {
      const res = await fetch(url, { headers })
      const ct = res.headers.get('content-type') || ''
      const body = await res.text()
      console.log('\nTRY', url, res.status, ct.slice(0, 40), 'len', body.length)
      if (ct.includes('json') || body.startsWith('{') || body.startsWith('[')) {
        console.log(body.slice(0, 500))
      }
    } catch (e) {
      console.log('TRY fail', url, e.message)
    }
  }
}

main().catch(console.error)
