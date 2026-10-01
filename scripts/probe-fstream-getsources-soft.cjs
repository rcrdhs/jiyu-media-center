const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const YM = 'https://ww.ymovies.vip'

async function text(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
  })
  return { status: r.status, text: await r.text() }
}

;(async () => {
  const servers = await text(`${YM}/ajax/movie/episode/servers/soft_1_1`, {
    Referer: YM + '/',
    'X-Requested-With': 'XMLHttpRequest',
  })
  const html = JSON.parse(servers.text).html
  const token = (html.match(/data-id="([^"]+)"/i) || [])[1]
  const embed = JSON.parse(
    (
      await text(`${YM}/ajax/movie/episode/server/sources/${token}_11`, {
        Referer: YM + '/',
        'X-Requested-With': 'XMLHttpRequest',
      })
    ).text,
  ).src
  const page = (await text(embed, { Referer: YM + '/' })).text
  const vMatch = page.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)
  const cfg = JSON.parse(vMatch[1])
  console.log('vConfig keys', Object.keys(cfg))
  console.log(
    JSON.stringify(
      {
        title: cfg.title,
        server: cfg.server,
        id: String(cfg.id).slice(0, 80),
        h: cfg.h,
        a: cfg.a,
        t: cfg.t,
        type: cfg.type,
        episodeId: cfg.episodeId,
      },
      null,
      2,
    ),
  )

  const js = (await text('https://fstream365.com/assets/js/player/script.min.js?v1.0.68', { Referer: embed })).text

  // Find getSources URL building
  const patterns = [
    /getSources\?[^"'`]{0,120}/g,
    /\/ajax\/getSources[^"'`]{0,80}/g,
    /ajax\/[^"'`]{0,40}Sources[^"'`]{0,40}/gi,
    /["']\/[^"']*source[^"']*["']/gi,
  ]
  for (const re of patterns) {
    const hits = [...js.matchAll(re)].map((m) => m[0]).slice(0, 10)
    if (hits.length) console.log(re, hits)
  }

  // Search for "Sources" near fetch/ajax
  let idx = 0
  let n = 0
  while ((idx = js.indexOf('Sources', idx + 1)) !== -1 && n < 8) {
    console.log('---', js.slice(idx - 80, idx + 120).replace(/\s+/g, ' '))
    n++
  }

  // Try common getSources with config fields
  const candidates = []
  if (cfg.id) {
    const base = 'https://fstream365.com/ajax/getSources/'
    const q = new URLSearchParams()
    q.set('id', cfg.id)
    if (cfg.h) q.set('h', cfg.h)
    if (cfg.a) q.set('a', cfg.a)
    if (cfg.t) q.set('t', String(cfg.t))
    candidates.push(base + '?' + q.toString())
    candidates.push(`https://fstream365.com/ajax/embed/getSources?id=${encodeURIComponent(cfg.id)}`)
  }

  for (const u of candidates) {
    for (const ref of [embed, YM + '/', 'https://fstream365.com/', '']) {
      const r = await text(u, {
        Referer: ref || undefined,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://fstream365.com',
      })
      console.log('try', r.status, 'ref=' + (ref || 'none').slice(0, 40), u.slice(0, 100), r.text.slice(0, 180).replace(/\s+/g, ' '))
    }
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
