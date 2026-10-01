/**
 * Retry getSources with cookie jar + Chrome client hints (match Jiyu desktop).
 */
const ORIGIN = 'https://ww.ymovies.vip'
const BASE = 'https://fstream365.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function fetchJar(url, jar, referer) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer || BASE + '/',
    'Sec-CH-UA': '"Google Chrome";v="150", "Chromium";v="150", "Not_A Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  const r = await fetch(url, { headers, redirect: 'manual' })
  const set = r.headers.getSetCookie?.() || []
  for (const c of set) {
    const [kv] = c.split(';')
    const i = kv.indexOf('=')
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1))
  }
  // also older
  const sc = r.headers.get('set-cookie')
  if (sc && !set.length) {
    for (const part of sc.split(/,(?=[^;]+?=)/)) {
      const [kv] = part.split(';')
      const i = kv.indexOf('=')
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
  }
  return { status: r.status, text: await r.text(), headers: r.headers, url: r.url }
}

;(async () => {
  const jar = new Map()

  const servers = await fetchJar(`${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`, jar, ORIGIN + '/')
  const sh = JSON.parse(servers.text).html
  const token = sh.match(/data-id="([^"]+)"/)[1]
  const name = sh.match(/data-name="(\d+)"/)[1]
  const src = JSON.parse(
    (await fetchJar(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, jar, ORIGIN)).text,
  ).src
  console.log('embed', src)
  console.log('jar after ymovies', jar)

  const page = await fetchJar(src, jar, ORIGIN + '/')
  console.log('embed status', page.status, 'len', page.text.length)
  console.log('jar after embed', jar)
  const cfg = JSON.parse(page.text.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])

  const id = encodeURIComponent(cfg.id)
  const urls = [
    `${BASE}/ajax/getSources?id=${id}`,
    `${BASE}/ajax/getSources?id=${id}&hash=${encodeURIComponent(cfg.hash)}`,
    `${BASE}/ajax/getSources?id=${id}&e=${Date.now()}`,
  ]

  for (const u of urls) {
    const r = await fetchJar(u, jar, src)
    console.log(r.status, r.text.length, u.slice(0, 90))
    console.log(r.text.slice(0, 300) || '(empty)')
  }

  // Use mid decoded id style v_313406
  const midPlain = Buffer.from(cfg.mid, 'base64').toString()
  console.log('midPlain', midPlain)
  const r2 = await fetchJar(`${BASE}/ajax/getSources?id=${encodeURIComponent(midPlain)}`, jar, src)
  console.log('mid id', r2.status, r2.text.length, r2.text.slice(0, 300))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
