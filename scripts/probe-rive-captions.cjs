async function main() {
  const providers = [
    'apex',
    'solstice',
    'primevids',
    'citadel',
    'flowcast',
    'pulse',
    'quasar',
    'horizon',
    'hindicast',
    'guru',
  ]
  // Anime: Spy x Family 120089, Demon Slayer 85937, AOT 1429
  for (const id of ['85937', '120089', '1429', '94605']) {
    console.log('\n=== TMDB', id, '===')
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
        const j = await r.json()
        const caps = j?.data?.captions || j?.captions || []
        const sources = j?.data?.sources || j?.sources || []
        if (!Array.isArray(caps) || caps.length === 0) continue
        console.log(provider, 'captions', caps.length, JSON.stringify(caps[0]).slice(0, 250))
        console.log(
          '  sources',
          sources.slice(0, 1).map((s) => s.quality || s.format),
        )
      } catch (e) {
        console.log(provider, e.message)
      }
    }
  }
}
main()
