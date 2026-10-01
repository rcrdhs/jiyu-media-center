const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const fs = require('fs')

async function main() {
  const js = await (
    await fetch('https://rivestream.ru/_next/static/chunks/1446-1a6a239c6109bc36.js', {
      headers: { 'User-Agent': UA },
    })
  ).text()
  fs.writeFileSync('scripts/_rive-embed-chunk.js', js)

  // Extract iframe conditions: "XXX"===e_&&
  const re = /"([A-Z0-9]+)"===e_&&[^?]{0,80}\?[^:]{0,40}\(0,o\.jsx\)\("iframe"[^]*?src:([^,]+),/g
  let m
  const hits = []
  while ((m = re.exec(js))) {
    hits.push({ code: m[1], srcExpr: m[2].slice(0, 200) })
  }
  console.log('iframe hits', hits.length)
  console.log(hits.slice(0, 30))

  // Simpler: dump each CODE===e_ block start
  const re2 = /"([A-Z0-9]+)"===e_&&/g
  const codes = []
  while ((m = re2.exec(js))) codes.push({ code: m[1], at: m.index })
  console.log(
    'codes',
    codes.map((c) => c.code),
  )

  for (const c of codes.slice(0, 15)) {
    console.log('\n', c.code, js.slice(c.at, c.at + 350).replace(/\s+/g, ' '))
  }

  // rotation helper ti
  const i = js.indexOf('let ti=(0,a.useCallback)')
  console.log('\n=== ti ===\n', js.slice(i, i + 900).replace(/\s+/g, ' '))
}

main().catch(console.error)
