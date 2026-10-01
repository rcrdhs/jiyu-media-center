async function main() {
  const t = await fetch('https://moovie.fun/assets/js/index-CTe1t-FR.js').then((r) => r.text())
  console.log('len', t.length)
  const terms = [
    'themoviedb',
    'mapple',
    'embed',
    'tmdb',
    'anilist',
    'login',
    'm3u8',
    'discover',
    'anime',
    'vidsrc',
    'provider',
    'api_key',
    'total_results',
  ]
  for (const term of terms) {
    let i = t.indexOf(term)
    let n = 0
    while (i >= 0 && n < 2) {
      console.log('\n', term, n, t.slice(Math.max(0, i - 80), i + 220).replace(/\s+/g, ' '))
      i = t.indexOf(term, i + term.length)
      n++
    }
  }
  const urls = [
    ...new Set([...t.matchAll(/https?:\/\/[a-zA-Z0-9._\-\/?=&%]+/g)].map((m) => m[0])),
  ].filter((u) => /tmdb|mapple|embed|api|anilist|vidsrc|moovie|cloudflare/i.test(u))
  console.log('\nurls', urls.slice(0, 50))
}

main().catch(console.error)
