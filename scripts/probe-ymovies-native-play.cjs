/**
 * Probe YMovies embed → real stream URL for native play (Chernobyl s? / blackAF).
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const ID = 's2634' // #blackAF — or find Chernobyl

async function get(url, referer = ORIGIN + '/') {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'text/html,application/json,*/*',
    },
  })
  return { status: r.status, text: await r.text(), url }
}

;(async () => {
  // Find Chernobyl
  const search = await get(ORIGIN + '/movie/search/' + encodeURIComponent('Chernobyl Inside'))
  const hit = search.text.match(/href="(\/film\/[^"]*chernobyl[^"]*)"[^>]*title="([^"]+)"/i)
  console.log('chernobyl hit', hit && hit.slice(1))
  const id = (hit?.[1]?.match(/-(s[a-z0-9]+)$/i) || [])[1] || ID
  console.log('using id', id)

  const servers = await get(`${ORIGIN}/ajax/movie/episode/servers/${id}_1_1`)
  console.log('servers', servers.status, servers.text.slice(0, 800))
  let html = ''
  try {
    html = JSON.parse(servers.text).html || ''
  } catch {
    html = servers.text
  }
  const serverIds = [...html.matchAll(/data-id="([^"]+)"/gi)].map((m) => m[1])
  console.log('server tokens/ids', serverIds.slice(0, 10))

  // Also link ids like 11, 12
  const linkIds = [...html.matchAll(/data-linkid="([^"]+)"/gi)].map((m) => m[1])
  console.log('linkids', linkIds)

  for (const token of serverIds.slice(0, 4)) {
    for (const sid of ['11', '12', '1', '2', token]) {
      const src = await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${sid}`)
      if (!src.text || src.text.length < 10) continue
      console.log(`sources ${token}_${sid}`, src.status, src.text.slice(0, 400))
    }
  }

  // Try watching page for embed iframe
  const path = hit?.[1] || `/film/blackaf-${ID}`
  const watch = await get(`${ORIGIN}${path}/watching.html?ep=1_1`)
  const iframes = [...watch.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1])
  console.log('iframes', iframes.slice(0, 5))
  const embeds = [...watch.text.matchAll(/https?:\/\/[^"'\\\s]+fstream[^"'\\\s]*/gi)].map((m) => m[0])
  console.log('fstream', embeds.slice(0, 5))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
