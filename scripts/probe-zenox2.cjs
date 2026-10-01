const fs = require('fs')

async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }

  // Animation = TMDB TV genre 16
  for (const path of [
    '/tv?genre=16',
    '/tv?genre=16&page=1',
    '/tv?genre=16&sort=popular',
    '/movies?genre=16',
  ]) {
    const r = await fetch('https://zenox.lol' + path, { headers })
    const html = await r.text()
    const titles = [...html.matchAll(/<h3[^>]*>([^<]{1,120})<\/h3>/g)].map((m) => m[1].trim())
    const count = (html.match(/([\d,]+)\s+titles/i) || [])[1]
    const posters = [...html.matchAll(/image\.tmdb\.org\/t\/p\/w500\/([a-zA-Z0-9]+)\.jpg/g)].map(
      (m) => m[1],
    )
    console.log(
      JSON.stringify({
        path,
        status: r.status,
        count,
        titles: titles.slice(0, 25),
        posterCount: posters.length,
      }),
    )
  }

  // Download key JS chunks and hunt for API / embed / stream patterns
  const chunks = [
    '/_next/static/chunks/app/tv/page-b6a9d457b53e6db8.js',
    '/_next/static/chunks/4267-6068d2ee4cd6fc6c.js',
    '/_next/static/chunks/6857-e0cd604edf6f8959.js',
    '/_next/static/chunks/2951-ec49ed98039b4fb6.js',
    '/_next/static/chunks/9343-29a671a6bfac8d81.js',
    '/_next/static/chunks/5589-80b4177d1ddef60e.js',
    '/_next/static/chunks/main-app-c88536b2a73dafcc.js',
  ]
  const hits = []
  for (const path of chunks) {
    const r = await fetch('https://zenox.lol' + path, { headers })
    const js = await r.text()
    fs.writeFileSync('scripts/zenox-' + path.split('/').pop(), js)
    const patterns = [
      /https?:[^"'`\s]{8,120}/g,
      /\/api\/[^"'`\s]{2,80}/g,
      /vidsrc|videasy|embedsu|flixhq|2embed|multiembed|rivestream|tmdb|m3u8|playlist/gi,
      /genre[=:]?\s*16/g,
      /\/(?:tv|movie|watch|title|media)\/\$\{/g,
      /\/(?:tv|movie)\/[a-z-]+/g,
    ]
    for (const re of patterns) {
      const found = [...js.matchAll(re)].map((m) => m[0]).slice(0, 30)
      if (found.length) hits.push({ chunk: path.split('/').pop(), re: String(re), found: [...new Set(found)].slice(0, 25) })
    }
  }
  console.log('---JS HITS---')
  console.log(JSON.stringify(hits, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
