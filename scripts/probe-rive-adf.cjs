const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function main() {
  const js = await (
    await fetch('https://rivestream.ru/_next/static/chunks/1446-1a6a239c6109bc36.js', {
      headers: { 'User-Agent': UA },
    })
  ).text()

  const idx = js.indexOf('Fast-Server')
  console.log('=== around Fast-Server ===\n', js.slice(idx - 900, idx + 1400))

  for (const term of [
    'api/embed',
    'embeds?',
    'provider=',
    'setSource',
    'erroredServer',
    'onServerError',
    'all servers failed',
    'Network error',
  ]) {
    const i = js.indexOf(term)
    console.log('\n===', term, i, '===')
    if (i >= 0) console.log(js.slice(Math.max(0, i - 150), i + 250).replace(/\s+/g, ' '))
  }

  const re = /label:"([^"]+)",value:"([^"]+)"/g
  const labels = []
  let m
  while ((m = re.exec(js))) {
    if (/Server|VIP|Prime|Fast|Agg|Best|Multi|Single/i.test(m[1]) || /^[A-Z0-9_]{2,12}$/.test(m[2])) {
      labels.push(`${m[1]}=${m[2]}`)
    }
  }
  console.log('\nLABELS\n', [...new Set(labels)].join('\n'))

  // Probe embed provider endpoints for ADF (Fast-Server)
  for (const provider of ['ADF', 'PRIME', 'VAP', 'VUP', 'SUP', 'AGGREGATOR', 'SMASH', 'PLAY', 'self', 'prime']) {
    for (const path of [
      `https://scrapper.rivestream.app/api/embed?provider=${provider}&id=502&season=1&episode=1&type=tv`,
      `https://scrapper.rivestream.app/api/provider?provider=${provider}&id=502&season=1&episode=1`,
    ]) {
      const res = await fetch(path, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          Origin: 'https://rivestream.ru',
          Referer: 'https://rivestream.ru/',
        },
      })
      const text = await res.text()
      if (text.includes('"data":null') || text.includes('Invalid provider')) continue
      console.log('\nOK', path, text.slice(0, 300))
    }
  }
}

main().catch(console.error)
