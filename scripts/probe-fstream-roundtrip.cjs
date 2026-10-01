const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function get(url, ref) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      ...(ref ? { Referer: ref } : {}),
      Accept: 'text/html,*/*',
    },
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, url: r.url, title: (text.match(/<title>([^<]*)/i) || [])[1], head: text.slice(0, 120).replace(/\s+/g, ' ') }
}

;(async () => {
  const origin = 'https://ww.ymovies.vip'
  const servers = await get(`${origin}/ajax/movie/episode/servers/s2634_1_1`, origin + '/')
  const html = JSON.parse(servers.head.includes('{') ? (await (await fetch(`${origin}/ajax/movie/episode/servers/s2634_1_1`, { headers: { 'User-Agent': UA, Referer: origin + '/', 'X-Requested-With': 'XMLHttpRequest' } })).text()) : '{}')
  const full = await (await fetch(`${origin}/ajax/movie/episode/servers/s2634_1_1`, { headers: { 'User-Agent': UA, Referer: origin + '/', 'X-Requested-With': 'XMLHttpRequest' } })).text()
  const data = JSON.parse(full)
  const token = (data.html.match(/data-id="([^"]+)"/) || [])[1]
  const srcFull = await (await fetch(`${origin}/ajax/movie/episode/server/sources/${token}_11`, { headers: { 'User-Agent': UA, Referer: origin + '/', 'X-Requested-With': 'XMLHttpRequest' } })).text()
  const src = JSON.parse(srcFull).src
  console.log('src', src)

  // Round-trip like the app: encode in query, decode, new URL().toString()
  const encoded = encodeURIComponent(src)
  const decoded = decodeURIComponent(encoded)
  const normalized = new URL(decoded).toString()
  console.log('roundtrip equal', src === normalized, 'decoded===src', decoded === src)
  console.log('normalized', normalized)

  for (const [label, u, ref] of [
    ['fresh+ref', src, origin + '/'],
    ['fresh+noref', src, ''],
    ['normalized+ref', normalized, origin + '/'],
    ['no-query', src.replace(/\?.*$/, ''), origin + '/'],
    ['truncated-path', src.slice(0, src.indexOf('/exmovie')), origin + '/'],
    ['root', 'https://fstream365.com/', origin + '/'],
  ]) {
    const r = await get(u, ref || undefined)
    console.log(label, r.status, r.title, r.head.slice(0, 90))
  }

  // vsembed direct
  const vs = await get('https://vsembed.ru/embed/tv/8110/1/1', 'https://freemovies.lol/')
  console.log('vsembed', vs.status, vs.title)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
