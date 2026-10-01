async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/json',
    },
    redirect: 'follow',
  })
  return { status: res.status, url: res.url, text: await res.text(), ct: res.headers.get('content-type') || '' }
}

async function main() {
  console.log('=== RiveStream /tv page ===')
  const home = await fetchText('https://rivestream.ru/tv')
  console.log('status', home.status, 'len', home.text.length)

  const tvPaths = new Set()
  for (const m of home.text.matchAll(/\/tv\/[a-z0-9-]+-\d+/gi)) tvPaths.add(m[0].toLowerCase())
  for (const m of home.text.matchAll(/\/tv\/(\d+)/gi)) tvPaths.add('/tv/' + m[1])
  console.log('unique tv slugs in HTML', tvPaths.size)

  const totals = home.text.match(/total_(?:pages|results)[^0-9]{0,8}\d+/gi)
  console.log('total hints', totals?.slice(0, 15))

  const apiHints = [...new Set([...home.text.matchAll(/\/api\/[a-zA-Z0-9_/-]+/g)].map((m) => m[0]))]
  console.log('api hints', apiHints.slice(0, 25))

  const tries = [
    'https://rivestream.ru/api/tv?page=1',
    'https://rivestream.ru/api/discover/tv?page=1',
    'https://rivestream.ru/api/v1/tv?page=1',
    'https://rivestream.ru/tv?page=2',
    'https://rivestream.ru/sitemap.xml',
  ]
  for (const url of tries) {
    const r = await fetchText(url)
    console.log('\nTRY', url, r.status, r.ct.slice(0, 40), 'len', r.text.length)
    if (r.ct.includes('json') || r.text.startsWith('{') || r.text.startsWith('[')) {
      console.log(r.text.slice(0, 600))
    }
  }
}

main().catch(console.error)
