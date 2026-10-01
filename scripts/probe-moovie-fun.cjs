async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/json',
    },
    redirect: 'follow',
  })
  const text = await res.text()
  return { status: res.status, text, ct: res.headers.get('content-type') || '' }
}

function summarizeHtml(url, status, text) {
  const title = text.match(/<title[^>]*>([^<]+)/i)?.[1]
  const cf = /just a moment|cloudflare|security verification|cf-browser-verification|turnstile/i.test(
    text,
  )
  const login = /sign in|log in|login required|create account/i.test(text)
  const next = /__NEXT_DATA__|\/_next\//.test(text)
  const links = [
    ...new Set([...text.matchAll(/href="([^"]+)"/gi)].map((m) => m[1])),
  ]
    .filter((h) => /anime|watch|tv|movie|series|episode|\/a\//i.test(h))
    .slice(0, 20)
  console.log('\n===', url)
  console.log({ status, len: text.length, title, cf, login, next, links })
}

async function main() {
  for (const url of [
    'https://moovie.fun/',
    'https://moovie.fun/anime',
    'https://moovie.fun/tv',
    'https://moovie.fun/movies',
    'https://moovie.fun/api/anime',
    'https://moovie.fun/api/v1/anime',
  ]) {
    try {
      const r = await get(url)
      if (r.ct.includes('json')) {
        console.log('\n===', url, r.status, 'json', r.text.slice(0, 400))
      } else {
        summarizeHtml(url, r.status, r.text)
      }
    } catch (e) {
      console.log(url, e.message)
    }
  }
}

main().catch(console.error)
