const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const CHUNK = 'https://rivestream.ru/_next/static/chunks/pages/embed-a2f4195a653b219d.js'

async function main() {
  const js = await (await fetch(CHUNK, { headers: { 'User-Agent': UA } })).text()
  console.log('len', js.length)
  const terms = [
    'Fast-Server',
    'Fast Server',
    'Single-Serve',
    'Servers',
    'Direct',
    'Embed',
    'server',
    'provider',
    'vip',
    'embeds',
    'api/embed',
    'searchParams',
    'setServer',
    'currentServer',
    'serverList',
  ]
  for (const term of terms) {
    let from = 0
    let hits = 0
    while (hits < 3) {
      const idx = js.indexOf(term, from)
      if (idx < 0) break
      hits += 1
      from = idx + term.length
      console.log(
        `\n--- ${term} #${hits} @${idx} ---\n`,
        js.slice(Math.max(0, idx - 100), idx + 180).replace(/\n/g, ' '),
      )
    }
    if (!hits) console.log(term, 'none')
  }

  // Also try embed API with known embed providers
  for (const provider of ['self', 'prime', 'fast', 'fast-server', 'vip', 'vanguard', '6']) {
    const url =
      `https://scrapper.rivestream.app/api/provider?provider=${encodeURIComponent(provider)}` +
      `&id=502&season=1&episode=1`
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Origin: 'https://rivestream.ru',
        Referer: 'https://rivestream.ru/',
      },
    })
    const text = await res.text()
    console.log('\nprovider', provider, res.status, text.slice(0, 200))
  }

  for (const provider of ['self', 'prime']) {
    const url =
      `https://scrapper.rivestream.app/api/embed?provider=${encodeURIComponent(provider)}` +
      `&id=502&season=1&episode=1&type=tv`
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Origin: 'https://rivestream.ru',
        Referer: 'https://rivestream.ru/',
      },
    })
    const text = await res.text()
    console.log('\nembed', provider, res.status, text.slice(0, 400))
  }
}

main().catch(console.error)
