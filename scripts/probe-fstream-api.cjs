/**
 * Call fstream365 getSources / api with vConfig from embed.
 */
const BASE = 'https://fstream365.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const ORIGIN = 'https://ww.ymovies.vip'

async function get(url, referer) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer || BASE + '/',
      Accept: 'application/json,text/plain,*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  })
  const text = await r.text()
  return { status: r.status, text, url: r.url }
}

;(async () => {
  // Get fresh embed
  const servers = await get(
    `${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`,
    ORIGIN + '/',
  )
  const token = JSON.parse(servers.text).html.match(/data-id="([^"]+)"/)[1]
  const name = JSON.parse(servers.text).html.match(/data-name="(\d+)"/)[1]
  const embed = JSON.parse(
    (
      await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, ORIGIN + '/')
    ).text,
  ).src
  console.log('embed', embed)

  const page = await get(embed, ORIGIN + '/')
  const cfg = JSON.parse(page.text.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])
  console.log('vConfig', cfg)

  const id = cfg.id
  const hash = cfg.hash
  const mid = cfg.mid
  const server = cfg.server

  const candidates = [
    `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}`,
    `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}&hash=${encodeURIComponent(hash)}`,
    `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}&_hash=${encodeURIComponent(hash)}&mid=${encodeURIComponent(mid)}`,
    `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}&hash=${encodeURIComponent(hash)}&mid=${encodeURIComponent(mid)}&server=${server}`,
    `${BASE}/ajax/getSource?id=${encodeURIComponent(id)}`,
    `${BASE}/ajax/sources?id=${encodeURIComponent(id)}`,
    `${BASE}/api/${encodeURIComponent(id)}`,
    `${BASE}/api/${encodeURIComponent(mid)}`,
    `${BASE}/api/source/${encodeURIComponent(id)}`,
    `${BASE}/ajax/embed/getSources?id=${id}`,
  ]

  // Also decode mid from base64-ish
  try {
    console.log('mid decoded', Buffer.from(mid, 'base64').toString())
  } catch {}

  for (const url of candidates) {
    const r = await get(url, embed)
    console.log('\n', r.status, url.slice(0, 100))
    console.log(r.text.slice(0, 400))
  }

  // Search script for exact endpoint construction
  const js = await get(`${BASE}/assets/js/player/script.min.js?v1.0.68`)
  // deobfuscate lightly: find '/ajax/getS' neighbors as hex strings
  const at = js.indexOf("'/ajax/getS'")
  console.log('\naround getS quote', js.slice(at, at + 200))
  const at2 = js.indexOf('/ajax/getS')
  console.log('around getS', js.slice(at2 - 20, at2 + 250))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
