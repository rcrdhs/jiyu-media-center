/**
 * Extract fstream getSources URL from obfuscated script + try POST.
 */
const fs = require('fs')
const BASE = 'https://fstream365.com'
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function get(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      Referer: opts.referer || BASE + '/',
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: opts.body,
  })
  const text = await r.text()
  return { status: r.status, text, len: text.length, ct: r.headers.get('content-type') }
}

;(async () => {
  const js = await (await fetch(`${BASE}/assets/js/player/script.min.js?v1.0.68`)).text()
  fs.writeFileSync('D:/app/scripts/fstream-script.min.js', js)

  // Find decryptSources and surrounding 2000 chars
  const d = js.indexOf('function decryptSources')
  console.log('decryptSources block:\n', js.slice(d, d + 2500))

  // Find references to getS
  let from = 0
  for (let i = 0; i < 8; i++) {
    const at = js.indexOf('getS', from)
    if (at < 0) break
    console.log('\ngetS ctx', js.slice(Math.max(0, at - 100), at + 150).replace(/\s+/g, ' '))
    from = at + 4
  }

  // Fresh embed config
  const servers = await get(`${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`, {
    referer: ORIGIN + '/',
  })
  const sh = JSON.parse(servers.text).html
  const token = sh.match(/data-id="([^"]+)"/)[1]
  const name = sh.match(/data-name="(\d+)"/)[1]
  const embed = JSON.parse(
    (await get(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, { referer: ORIGIN })).text,
  ).src
  const page = await get(embed, { referer: ORIGIN })
  const cfg = JSON.parse(page.text.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])

  // Try rabbitstream-style endpoints used by similar players
  const id = cfg.id
  const tries = [
    { url: `${BASE}/ajax/embed/getSources?id=${encodeURIComponent(id)}` },
    { url: `${BASE}/ajax/embed-4/getSources?id=${encodeURIComponent(id)}` },
    { url: `${BASE}/ajax/embed-5/getSources?id=${encodeURIComponent(id)}` },
    { url: `${BASE}/ajax/episode/sources?id=${encodeURIComponent(id)}` },
    { url: `${BASE}/ajax/getSources`, method: 'POST', body: `id=${encodeURIComponent(id)}` },
    {
      url: `${BASE}/ajax/getSources`,
      method: 'POST',
      body: `id=${encodeURIComponent(id)}&hash=${encodeURIComponent(cfg.hash)}`,
    },
    { url: `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}&_k=${encodeURIComponent(cfg.hash)}` },
    { url: `${BASE}/ajax/getSources?id=${encodeURIComponent(id)}&e=${encodeURIComponent(cfg.hash)}` },
  ]

  for (const t of tries) {
    const r = await get(t.url, { ...t, referer: embed })
    console.log(t.method || 'GET', t.url.slice(0, 90), r.status, r.len, r.text.slice(0, 180))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
