async function main() {
  const providers = ['apex', 'solstice', 'primevids', 'citadel', 'flowcast']
  // Attack on Titan TMDB 1429 or popular anime
  const tmdbId = '85937' // Demon Slayer?
  const id = '1429'
  for (const provider of providers) {
    const url = `https://scrapper.rivestream.app/api/provider?provider=${provider}&id=${id}&season=1&episode=1`
    try {
      const r = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://rivestream.ru',
          Referer: 'https://rivestream.ru/',
        },
      })
      const t = await r.text()
      const hasSub = /sub|caption|vtt|srt|track/i.test(t)
      console.log(provider, r.status, 'len', t.length, 'subish', hasSub)
      if (hasSub) console.log(t.slice(0, 500))
      try {
        const j = JSON.parse(t)
        const keys = j && typeof j === 'object' ? Object.keys(j) : []
        console.log('  keys', keys)
        if (j?.data) console.log('  data keys', Object.keys(j.data))
        const src = j?.sources || j?.data?.sources
        if (Array.isArray(src)) console.log('  sample', JSON.stringify(src[0]).slice(0, 300))
      } catch {}
    } catch (e) {
      console.log(provider, e.message)
    }
  }
}
main()
