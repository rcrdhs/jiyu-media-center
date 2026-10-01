const fs = require('fs')

async function get(path) {
  const r = await fetch('https://zenox.lol' + path, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json,text/html,*/*',
      Referer: 'https://zenox.lol/tv',
    },
  })
  const ct = r.headers.get('content-type') || ''
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { path, status: r.status, ct, len: text.length, json, sample: text.slice(0, 400) }
}

async function main() {
  const tries = [
    '/api/details/series-94664',
    '/api/details/94664',
    '/api/details/tv/94664',
    '/api/details?id=94664&type=tv',
    '/api/details?media=series-94664',
    '/api/season/94664',
    '/api/season/94664/1',
    '/api/season/series-94664/1',
    '/api/search?q=bleach',
    '/api/search?q=bleach&type=tv',
  ]
  const out = []
  for (const path of tries) {
    const r = await get(path)
    out.push({
      path: r.path,
      status: r.status,
      ct: r.ct,
      len: r.len,
      keys: r.json && typeof r.json === 'object' ? Object.keys(r.json) : null,
      sample: r.json ? JSON.stringify(r.json).slice(0, 500) : r.sample.replace(/\s+/g, ' ').slice(0, 200),
    })
    if (r.json) {
      fs.writeFileSync(
        'scripts/zenox-' + path.replace(/[/?&=]/g, '_').slice(0, 80) + '.json',
        JSON.stringify(r.json, null, 2),
      )
    }
  }
  console.log(JSON.stringify(out, null, 2))

  // Grep downloaded chunk for details/season URL builders
  const chunk = fs.readFileSync('scripts/zenox-9343-29a671a6bfac8d81.js', 'utf8')
  const idx = chunk.indexOf('/api/details/')
  console.log('--- context /api/details/ ---')
  console.log(chunk.slice(Math.max(0, idx - 200), idx + 400))
  const idx2 = chunk.indexOf('/api/season/')
  console.log('--- context /api/season/ ---')
  console.log(chunk.slice(Math.max(0, idx2 - 200), idx2 + 400))

  // Find embed / player / source strings in all zenox-*.js
  const files = fs.readdirSync('scripts').filter((f) => f.startsWith('zenox-') && f.endsWith('.js'))
  const interesting = []
  for (const f of files) {
    const js = fs.readFileSync('scripts/' + f, 'utf8')
    for (const re of [
      /embed[^"'`]{0,40}/gi,
      /player[^"'`]{0,40}/gi,
      /sources?[^"'`]{0,40}/gi,
      /vidsrc[^"'`]{0,60}/gi,
      /videasy[^"'`]{0,60}/gi,
      /2embed[^"'`]{0,60}/gi,
      /multiembed[^"'`]{0,60}/gi,
      /iframe[^"'`]{0,60}/gi,
      /m3u8[^"'`]{0,60}/gi,
      /\/api\/[a-z0-9_/-]{2,60}/gi,
    ]) {
      const found = [...js.matchAll(re)].map((m) => m[0]).slice(0, 15)
      if (found.length) interesting.push({ f, re: String(re), found: [...new Set(found)].slice(0, 12) })
    }
  }
  console.log('--- interesting ---')
  console.log(JSON.stringify(interesting, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
