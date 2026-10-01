const fs = require('fs')

async function main() {
  const headers = { 'User-Agent': 'Mozilla/5.0' }
  // Download the big media-related chunks we missed
  const files = [
    '3519-420d34abaffbe772.js',
    '9742-9a290448d45250ed.js',
    'b5c62bdb-7108dd2ba2f110fe.js',
    '3293-765026952266b3ae.js',
    '5619-bf7e8c228a6d6ed2.js',
  ]
  for (const f of files) {
    const js = await (await fetch('https://zenox.lol/_next/static/chunks/' + f, { headers })).text()
    fs.writeFileSync('scripts/zenox-' + f, js)
  }

  const all = fs
    .readdirSync('scripts')
    .filter((f) => f.startsWith('zenox-') && f.endsWith('.js'))
    .map((f) => ({ f, js: fs.readFileSync('scripts/' + f, 'utf8') }))

  for (const needle of [
    '/api/v1/stream',
    'api/v1/stream',
    'bub.zenox',
    'trex.zenox',
    'Temporary',
    'Source tried',
    'tmdbId',
    'mediaType',
  ]) {
    for (const { f, js } of all) {
      let i = js.indexOf(needle)
      if (i < 0) continue
      console.log('\n====', needle, 'in', f, '====')
      console.log(js.slice(Math.max(0, i - 180), i + 280).replace(/\\x20/g, ' '))
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
