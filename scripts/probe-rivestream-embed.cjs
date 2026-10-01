async function analyzeEmbed(name, id) {
  const url = `https://rivestream.ru/embed?type=tv&id=${id}&season=1&episode=1`
  const html = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://rivestream.ru/',
    },
  }).then((r) => ({ status: r.status, text: r.text() }))
  const text = await html.text
  const loginGate = /sign in|log in|login required|create account|authentication/i.test(text)
  const hasVideoTag = /<video/i.test(text)
  const iframeSrcs = [...text.matchAll(/src=\"([^\"]+)\"/g)]
    .map((m) => m[1])
    .filter((s) => /embed|player|m3u8|stream|video|iframe/i.test(s))
    .slice(0, 8)
  const m3u8 = [...text.matchAll(/https?:[^\"'\s]+\.m3u8[^\"'\s]*/g)].map((m) => m[0]).slice(0, 3)
  return {
    show: name,
    url,
    status: html.status,
    len: text.length,
    loginGate,
    hasVideoTag,
    iframeSrcs,
    m3u8,
    title: (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '',
    snippet: text.replace(/\s+/g, ' ').slice(0, 400),
  }
}

async function main() {
  const shows = [
    ['Game of Thrones', 1399],
    ['Breaking Bad', 1396],
    ['Stranger Things', 66732],
    ['The Office', 2316],
    ['Reacher', 108978],
  ]
  for (const [name, id] of shows) {
    console.log(JSON.stringify(await analyzeEmbed(name, id), null, 2))
  }

  const home = await fetch('https://rivestream.ru/tv', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) =>
    r.text(),
  )
  console.log('\nHOME len', home.length)
  console.log('HOME has login', /sign in|log in|login/i.test(home))
  console.log('HOME sample', home.replace(/\s+/g, ' ').slice(0, 600))
}

main().catch(console.error)
