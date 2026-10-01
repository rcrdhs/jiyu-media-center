/**
 * Dig fstream365 player JS for stream API endpoints.
 */
const BASE = 'https://fstream365.com'
const UA = 'Mozilla/5.0'

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: BASE + '/' } })
  return r.text()
}

;(async () => {
  const embedPath =
    '/embed/movie/52586a3176563141725757713963622b706f2b3472747a4d672f43356e48575437684f615272777a50763154344b6e5963594330626858524236686e5532495548544471676b7942715530544a7a3859694a63715764634e356769375953682f4b5863415468663241385230684c744a447a415253365457304a2f7a3239646c/exmovie?srv=6'
  const page = await get(BASE + embedPath)
  console.log('page snippet around data', page.match(/data-[a-z-]+="[^"]*"/gi)?.slice(0, 30))
  console.log('body', page.slice(page.indexOf('<body'), page.indexOf('<body') + 800))

  for (const file of ['script.min.js?v1.0.68', 'player.min.js?v1.0.68', 'apd.min.js?v1.0.68']) {
    const js = await get(`${BASE}/assets/js/player/${file}`)
    console.log('\n====', file, js.length)
    // extract readable string literals containing api/ajax/m3u8
    const strings = [...js.matchAll(/["'`](\/?[a-z0-9_./?=&-]{4,120})["'`]/gi)]
      .map((m) => m[1])
      .filter((s) => /api|ajax|m3u8|source|video|stream|embed|getS|playlist|file/i.test(s))
    console.log('strings', [...new Set(strings)].slice(0, 40))

    // context around getS / /api/
    for (const key of ['getS', '/api/', 'm3u8', 'xhr', 'fetch(', '$.ajax', 'sources']) {
      let i = 0
      let from = 0
      while (i < 3) {
        const at = js.indexOf(key, from)
        if (at < 0) break
        console.log('ctx', key, js.slice(Math.max(0, at - 60), at + 100).replace(/\s+/g, ' '))
        from = at + key.length
        i++
      }
    }
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
