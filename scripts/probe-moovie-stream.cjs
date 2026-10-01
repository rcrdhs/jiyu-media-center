const KEY = 'dfa4c2c7c1de1005adee824dc5593672'

async function get(url) {
  const res = await fetch(url)
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  const t = await fetch('https://moovie.fun/assets/js/index-CTe1t-FR.js').then((r) => r.text())
  for (const term of [
    'mappletv',
    'filmu.in',
    'jellify',
    'StreamAnime',
    '/anime/',
    'with_keywords',
    '210024',
    'keyword',
    'animation',
  ]) {
    let i = t.indexOf(term)
    let n = 0
    while (i >= 0 && n < 3) {
      console.log('\n', term, n, t.slice(Math.max(0, i - 100), i + 260).replace(/\s+/g, ' '))
      i = t.indexOf(term, i + term.length)
      n++
    }
  }

  // Anime-ish TMDB discover (animation genre 16)
  const anime = await get(
    `https://api.themoviedb.org/3/discover/tv?api_key=${KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=1`,
  )
  console.log('\nTMDB anime-ish discover', {
    total: anime.json?.total_results,
    pages: anime.json?.total_pages,
    first: anime.json?.results?.[0]?.name,
  })

  const trending = await get(
    `https://api.themoviedb.org/3/trending/tv/week?api_key=${KEY}`,
  )
  console.log('TMDB trending tv count', trending.json?.results?.length)

  // Try common stream URL patterns without browser
  for (const url of [
    'https://moovie.fun/anime/37854/watch',
    'https://moovie.fun/anime/37854/1',
    'https://moovie.fun/anime/37854/season/1/episode/1',
    'https://moovie.fun/watch/anime/37854',
    'https://moovie.fun/stream/anime/37854',
    'https://embed.filmu.in/embed/tv/37854/1/1',
    'https://jellify.live/embed/tv/37854/1/1',
  ]) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://moovie.fun/' },
      redirect: 'manual',
    })
    const text = await res.text()
    console.log(url, res.status, res.headers.get('location') || '', text.slice(0, 80).replace(/\s+/g, ' '))
  }
}

main().catch(console.error)
