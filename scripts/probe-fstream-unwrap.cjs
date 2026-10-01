/**
 * Unwrap fstream365 embed → m3u8/mp4 for native Jiyu play.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const ID = 's6ptq'

async function get(url, referer) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer || ORIGIN + '/',
      Accept: '*/*',
    },
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, text, url: r.url, headers: Object.fromEntries(r.headers) }
}

function findUrls(text) {
  const out = new Set()
  for (const m of text.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)) {
    const u = m[0].replace(/[),.;]+$/, '')
    if (/\.(m3u8|mp4|mpd)(\?|$)/i.test(u) || /playlist|manifest|source|stream|video/i.test(u)) {
      out.add(u.slice(0, 200))
    }
  }
  for (const m of text.matchAll(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/gi)) {
    out.add(m[1].slice(0, 200))
  }
  for (const m of text.matchAll(/file\s*[:=]\s*["']([^"']+)["']/gi)) out.add(m[1].slice(0, 200))
  for (const m of text.matchAll(/sources?\s*[:=]\s*(\[[^\]]+\])/gi)) out.add(m[1].slice(0, 300))
  return [...out]
}

;(async () => {
  const servers = await get(`${ORIGIN}/ajax/movie/episode/servers/${ID}_1_1`)
  const html = JSON.parse(servers.text).html
  const token = html.match(/data-id="([^"]+)"/)[1]
  const name = html.match(/data-name="(\d+)"/)?.[1] || '11'
  console.log('token len', token.length, 'name', name)

  const srcJson = await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`)
  const embed = JSON.parse(srcJson.text).src
  console.log('embed', embed)

  const page = await get(embed, ORIGIN + '/')
  console.log('embed page', page.status, page.url, 'len', page.text.length)
  console.log('urls', findUrls(page.text))
  // scripts
  const scripts = [...page.text.matchAll(/src=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1])
  console.log('scripts', scripts.slice(0, 15))

  // inline script chunks with file/source
  const idx = page.text.search(/m3u8|file:|sources|jwplayer|Clappr|plyr/i)
  console.log('hit at', idx, page.text.slice(Math.max(0, idx - 80), idx + 400))

  for (const s of scripts.slice(0, 8)) {
    const url = s.startsWith('http') ? s : new URL(s, page.url).href
    if (!/player|embed|movie|stream|main|app/i.test(url)) continue
    const js = await get(url, page.url)
    const found = findUrls(js.text)
    if (found.length) console.log('from', url, found.slice(0, 8))
    const api = [...js.text.matchAll(/\/api\/[^"'\\\s]+|ajax\/[^"'\\\s]+|getVideo|get_source|playlist/gi)].slice(0, 20)
    if (api.length) console.log('api-ish', url.split('/').pop(), [...new Set(api.map((m) => m[0]))])
  }

  // Try common fstream patterns
  for (const path of [
    embed.replace('/embed/', '/api/'),
    embed + '&type=json',
    embed.replace('exmovie', 'get'),
  ]) {
    const r = await get(path, embed)
    if (r.status === 200 && r.text.length < 5000) {
      console.log('try', path.slice(0, 100), r.text.slice(0, 300))
    }
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
