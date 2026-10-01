const CryptoJS = (() => {
  try {
    return require('crypto-js')
  } catch {
    return null
  }
})()
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const YM = 'https://ww.ymovies.vip'

async function text(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
  })
  return { status: r.status, text: await r.text(), headers: r.headers }
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
  const cfg = JSON.parse(page.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])
  console.log('cfg', {
    id: cfg.id?.slice?.(0, 40) || cfg.id,
    hash: cfg.hash?.slice?.(0, 40) || cfg.hash,
    mid: cfg.mid,
    time: cfg.time,
    server: cfg.server,
  })

  const qs = new URLSearchParams({ id: cfg.id })
  if (cfg.hash) qs.set('h', cfg.hash)
  if (cfg.mid) qs.set('a', cfg.mid)
  if (cfg.time) qs.set('t', String(cfg.time))
  const urls = [
    `https://fstream365.com/ajax/getSources/?${qs}`,
    `https://fstream365.com/ajax/getSources/?id=${encodeURIComponent(cfg.id)}`,
    `https://fstream365.com/ajax/getSources/?id=${encodeURIComponent(cfg.id)}&h=${encodeURIComponent(cfg.hash || '')}&a=${encodeURIComponent(cfg.mid || '')}&t=${encodeURIComponent(String(cfg.time || ''))}`,
  ]

  for (const u of urls) {
    const r = await text(u, {
      Referer: YM + '/',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://fstream365.com',
    })
    console.log('\nURL', u.slice(0, 140))
    console.log('status', r.status, 'len', r.text.length, 'body', r.text.slice(0, 250))
    try {
      const data = JSON.parse(r.text)
      console.log('keys', Object.keys(data), 'sources type', typeof data.sources)
      if (typeof data.sources === 'string' && data.sources.startsWith('eyJ')) {
        const outer = JSON.parse(Buffer.from(data.sources, 'base64').toString('utf8'))
        console.log('outer keys', Object.keys(outer), 'ct', String(outer.ct).slice(0, 40))
      }
      if (Array.isArray(data.sources)) {
        console.log('sources arr', data.sources.slice(0, 3))
      }
      if (data.tracks) console.log('tracks', data.tracks)
    } catch (e) {
      console.log('json fail', e.message)
    }
  }

  // Also try server c7
  for (const sid of ['12', '11']) {
    const src2 = JSON.parse(
      (
        await text(`${YM}/ajax/movie/episode/server/sources/${token}_${sid}`, {
          Referer: YM + '/',
          'X-Requested-With': 'XMLHttpRequest',
        })
      ).text,
    ).src
    console.log('\nalt server', sid, src2?.slice(0, 80))
  }

  // Media: check if m3u8 hosts need special headers — look in player.min.js for host patterns
  const player = (await text('https://fstream365.com/assets/js/player/player.min.js?v1.0.68', { Referer: embed })).text
  const hosts = [...player.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:mcloud|bunny|cloudfront|owcdn|cdn)[a-z0-9.-]*/gi)].slice(0, 10)
  console.log('player hosts', hosts.map((m) => m[0]))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
