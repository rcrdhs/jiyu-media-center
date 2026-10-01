const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function get(url, ref) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: ref || 'https://freemovies.lol/', Accept: '*/*' },
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, url: r.url, text }
}

;(async () => {
  // post 8110 from user screenshot — resolve getPlayTV via normal fetch
  const postId = '8110'
  const urls = [
    `https://freemovies.lol/getPlayTV.php?id=${postId}&s=1&e=1&sv=embedru&playtv=true`,
    `https://vsembed.ru/embed/tv/${postId}/1/1`,
    `https://vidsrc.xyz/embed/tv?tmdb=${postId}&season=1&episode=1`,
    `https://vidsrc.to/embed/tv/${postId}/1/1`,
  ]
  for (const u of urls) {
    const r = await get(u, `https://freemovies.lol/?player_tv=${postId}&s=1&e=1&sv=embedru&tv=true`)
    console.log('\n===', r.status, r.url.slice(0, 100), 'len', r.text.length)
    console.log(r.text.slice(0, 400).replace(/\s+/g, ' '))
    const iframes = [...r.text.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1])
    console.log('iframes', iframes.slice(0, 5))
  }

  // YMovies: open watching page vs bare fstream without referer simulation
  const watch = 'https://ww.ymovies.vip/film/blackaf-s2634/watching.html?ep=1_1'
  const w = await get(watch, 'https://ww.ymovies.vip/')
  console.log('\nwatch', w.status, w.text.includes('fstream'), w.text.includes('iframe'))

  // Simulate Electron: no referer to fstream root / truncated
  for (const u of [
    'https://fstream365.com/',
    'https://fstream365.com/embed/movie/',
    'https://fstream365.com/embed/',
  ]) {
    const r = await get(u, '')
    console.log('fstream bare', u, r.status, r.text.slice(0, 80).replace(/\s+/g, ' '))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
