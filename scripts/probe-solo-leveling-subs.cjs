async function probe(id, s, e) {
  const providers = ['citadel', 'flowcast', 'apex', 'solstice', 'pulse', 'quasar']
  console.log(`\nTMDB ${id} S${s}E${e}`)
  for (const provider of providers) {
    const url = `https://scrapper.rivestream.app/api/provider?provider=${provider}&id=${id}&season=${s}&episode=${e}`
    try {
      const r = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://rivestream.ru',
          Referer: 'https://rivestream.ru/',
        },
      })
      const j = await r.json()
      const caps = j?.data?.captions || []
      const sources = j?.data?.sources || []
      const eng = caps.find((c) => /english|\beng\b/i.test(`${c.label} ${c.language}`))
      console.log(
        provider,
        'sources',
        sources.length,
        'caps',
        caps.length,
        eng ? `ENG ${eng.file?.slice(0, 80)}` : caps[0] ? `first ${caps[0].label}` : 'none',
      )
    } catch (err) {
      console.log(provider, err.message)
    }
  }
}

async function main() {
  // Solo Leveling search
  const key = 'd64117f26031a428449f102ced3aba73'
  const search = await fetch(
    `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent('Solo Leveling')}`,
  ).then((r) => r.json())
  const hits = (search.results || []).slice(0, 5).map((x) => ({ id: x.id, name: x.name }))
  console.log('search', hits)
  const id = String(hits[0]?.id || '127532')
  await probe(id, 2, 1)
  await probe(id, 1, 1)
}

main().catch(console.error)
