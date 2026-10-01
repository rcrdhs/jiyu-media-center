/**
 * Decrypt / properly call fstream365 getSources.
 */
const BASE = 'https://fstream365.com'
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function get(url, referer, extra = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer || BASE + '/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE,
      ...extra,
    },
  })
  const buf = Buffer.from(await r.arrayBuffer())
  return {
    status: r.status,
    text: buf.toString('utf8'),
    hex: buf.slice(0, 40).toString('hex'),
    len: buf.length,
    ct: r.headers.get('content-type'),
  }
}

;(async () => {
  const servers = await get(`${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`, ORIGIN + '/')
  const sh = JSON.parse(servers.text).html
  const token = sh.match(/data-id="([^"]+)"/)[1]
  const name = sh.match(/data-name="(\d+)"/)[1]
  const embed = JSON.parse(
    (await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, ORIGIN + '/')).text,
  ).src

  const page = await get(embed, ORIGIN + '/')
  const cfg = JSON.parse(page.text.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])
  console.log(cfg)

  const qs = new URLSearchParams({
    id: cfg.id,
    hash: cfg.hash,
    mid: cfg.mid,
    server: cfg.server,
    type: cfg.type || 'movie',
  })

  for (const path of [
    `/ajax/getSources?${qs}`,
    `/ajax/getSources?id=${encodeURIComponent(cfg.id)}&h=${encodeURIComponent(cfg.hash)}`,
    `/ajax/getSources?id=${encodeURIComponent(cfg.mid)}`,
    `/ajax/getSources?id=${encodeURIComponent(Buffer.from(cfg.mid, 'base64').toString())}`,
  ]) {
    const r = await get(BASE + path, embed)
    console.log(path.slice(0, 80), r.status, r.ct, r.len, r.hex, r.text.slice(0, 200))
  }

  // Download script properly
  const jsR = await fetch(`${BASE}/assets/js/player/script.min.js?v1.0.68`, {
    headers: { 'User-Agent': UA },
  })
  const js = await jsR.text()
  console.log('js len', js.length)

  // Find all /ajax/ occurrences with nearby chars
  let from = 0
  let n = 0
  while (n < 15) {
    const at = js.indexOf('/ajax/', from)
    if (at < 0) break
    console.log('ajax', JSON.stringify(js.slice(at, at + 40)))
    from = at + 6
    n++
  }

  // Look for AES decrypt patterns
  for (const key of ['AES', 'decrypt', 'enc.Utf8', 'getSources', 'ciphertext', 'Passphrase', 'secret']) {
    const at = js.indexOf(key)
    if (at >= 0) console.log(key, js.slice(at - 40, at + 80).replace(/\s+/g, ' '))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
