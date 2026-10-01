const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

const CHUNKS = [
  'https://rivestream.ru/_next/static/chunks/2751-11dbb3731c0eb357.js',
  'https://rivestream.ru/_next/static/chunks/7300-4265723c6b372545.js',
  'https://rivestream.ru/_next/static/chunks/1446-1a6a239c6109bc36.js',
  'https://rivestream.ru/_next/static/chunks/823c5380-1dfb1d3849cbbdbc.js',
  'https://rivestream.ru/_next/static/chunks/a0f95e74-deee7f8b88cc1338.js',
  'https://rivestream.ru/_next/static/chunks/37a763b4-5a3b4f5484a24d2c.js',
  'https://rivestream.ru/_next/static/chunks/257e8032-e4b56c932d7278cd.js',
  'https://rivestream.ru/_next/static/chunks/d9067523-4b2107309ae8968c.js',
  'https://rivestream.ru/_next/static/chunks/2e3a845b-4202a7c39dffe10c.js',
  'https://rivestream.ru/_next/static/chunks/3a17f596-6fe8ea4c98328343.js',
]

async function main() {
  for (const url of CHUNKS) {
    const js = await (await fetch(url, { headers: { 'User-Agent': UA } })).text()
    const interesting = []
    for (const term of [
      'Fast-Server',
      'Fast Server',
      'Single-Serve',
      'No options found',
      'all servers failed',
      'Servers & Mode',
      'Direct',
      'isEmbeded',
      'nonEmbed',
      'serverList',
      'embedServers',
      'vipstream',
      'api/embeds',
      'Server ',
    ]) {
      if (js.includes(term)) interesting.push(term)
    }
    if (interesting.length) {
      console.log('\nFILE', url.slice(-50), 'len', js.length, interesting.join(', '))
      for (const term of interesting.slice(0, 6)) {
        const idx = js.indexOf(term)
        console.log(
          ' ',
          term,
          '=>',
          js.slice(Math.max(0, idx - 120), idx + 200).replace(/\s+/g, ' '),
        )
      }
    } else {
      console.log('skip', url.slice(-40), js.length)
    }
  }
}

main().catch(console.error)
