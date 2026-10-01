const ORIGIN = 'https://ww.ymovies.vip'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function get(url, ref = ORIGIN + '/') {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: ref,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
    redirect: 'follow',
  })
  const t = await r.text()
  return { status: r.status, text: t, finalUrl: r.url }
}

;(async () => {
  const servers = await get(`${ORIGIN}/ajax/movie/episode/servers/s2634_1_1`)
  console.log('servers', servers.status, servers.text.slice(0, 1200))
  let html = ''
  try {
    html = JSON.parse(servers.text).html || ''
  } catch {
    html = servers.text
  }
  const tokens = [...html.matchAll(/data-id="([^"]+)"/gi)].map((m) => m[1])
  const names = [...html.matchAll(/data-name="(\d+)"/gi)].map((m) => m[1])
  console.log('tokens', tokens.slice(0, 6), 'names', names.slice(0, 6))

  for (const token of tokens.slice(0, 3)) {
    for (const sid of [...new Set([names[0], '11', '12', '1'])].filter(Boolean)) {
      const src = await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${sid}`)
      console.log(`sources ${token}_${sid}`, src.status, src.text.slice(0, 500))
      try {
        const data = JSON.parse(src.text)
        if (data.src) {
          console.log('embed src', data.src)
          const emb = await get(data.src, ORIGIN + '/')
          console.log('embed fetch', emb.status, emb.finalUrl, emb.text.slice(0, 200).replace(/\s+/g, ' '))
          const emb2 = await get(data.src, 'https://fstream365.com/')
          console.log('embed self-ref', emb2.status, emb2.text.slice(0, 120).replace(/\s+/g, ' '))
        }
      } catch {
        /* ignore */
      }
    }
  }

  const watch = await get(`${ORIGIN}/film/blackaf-s2634/watching.html?ep=1_1`)
  console.log('watch', watch.status, watch.finalUrl)
  const iframes = [...watch.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1])
  console.log('iframes', iframes.slice(0, 5))

  const fmUrl = 'https://freemovies.lol/?player_tv=8110&s=1&e=1&sv=embedru&tv=true'
  for (const ref of ['https://freemovies.lol/', 'https://ww1.surf/', ORIGIN + '/']) {
    const fm = await get(fmUrl, ref)
    console.log('freemovies', ref, fm.status, fm.text.slice(0, 180).replace(/\s+/g, ' '))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
