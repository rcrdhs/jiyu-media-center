const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const YM = 'https://ww.ymovies.vip'
const FM = 'https://freemovies.lol'

async function get(url, ref, extra = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      ...(ref ? { Referer: ref } : {}),
      ...extra,
    },
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, url: r.url, text, len: text.length }
}

;(async () => {
  // YMovies search
  const search = await get(`${YM}/movie/search/${encodeURIComponent('16 and Pregnant')}`, YM + '/')
  const hits = [...search.text.matchAll(/href="(\/film\/[^"]+)"[^>]*title="([^"]*)"/gi)].map((m) => [
    m[1],
    m[2],
  ])
  console.log('ym hits', hits.slice(0, 8))
  const path = hits.find((h) => /16.*pregnant/i.test(h[1] + h[0]))?.[0] || hits[0]?.[0]
  console.log('ym path', path)
  if (path) {
    const id = (path.match(/-(s[a-z0-9]+)$/i) || [])[1]
    console.log('ym id', id)
    const servers = await get(`${YM}/ajax/movie/episode/servers/${id}_1_1`, YM + '/', {
      'X-Requested-With': 'XMLHttpRequest',
    })
    console.log('servers', servers.status, servers.text.slice(0, 400))
    let html = ''
    try {
      html = JSON.parse(servers.text).html || ''
    } catch {
      html = servers.text
    }
    const token = (html.match(/data-id="([^"]+)"/i) || [])[1]
    const name = (html.match(/data-name="(\d+)"/i) || [])[1] || '11'
    if (token) {
      const src = await get(`${YM}/ajax/movie/episode/server/sources/${token}_${name}`, YM + '/', {
        'X-Requested-With': 'XMLHttpRequest',
      })
      console.log('sources', src.text.slice(0, 500))
      try {
        const embed = JSON.parse(src.text).src
        const withRef = await get(embed, YM + '/')
        const noRef = await get(embed)
        console.log('embed+ref', withRef.status, withRef.text.includes('<video'), withRef.text.slice(0, 200).replace(/\s+/g, ' '))
        console.log('embed-noref', noRef.status, noRef.text.slice(0, 120).replace(/\s+/g, ' '))
        // look for m3u8 / sources in embed html
        const m3u = [...withRef.text.matchAll(/https?:[^"'\\\s]+\.m3u8[^"'\\\s]*/gi)].map((m) => m[0])
        const scripts = [...withRef.text.matchAll(/src="([^"]+\.js[^"]*)"/gi)].map((m) => m[1]).slice(0, 8)
        console.log('m3u', m3u.slice(0, 5), 'scripts', scripts)
      } catch (e) {
        console.log('embed parse fail', e.message)
      }
    }
  }

  // NetMirror / freemovies search via category is heavy — try WP search
  const fmSearch = await get(`${FM}/?s=${encodeURIComponent('16 and Pregnant')}`, FM + '/')
  const fmHits = [...fmSearch.text.matchAll(/href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>\s*<img[^>]+alt="([^"]*)"/gi)]
    .map((m) => [m[1], m[2]])
    .filter((h) => /pregnant/i.test(h[1]))
  console.log('fm hits', fmHits.slice(0, 5), 'status', fmSearch.status, 'len', fmSearch.len)

  // vsembed common tmdb for 16 and Pregnant = 4656?
  for (const id of ['4656', '8110', '294593']) {
    const vs = await get(`https://vsembed.ru/embed/tv/${id}/1/1`, FM + '/')
    console.log('vs', id, vs.status, vs.text.includes('Player'), (vs.text.match(/<title>([^<]*)/) || [])[1])
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
