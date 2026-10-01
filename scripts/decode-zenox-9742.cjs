const fs = require('fs')
const js = fs.readFileSync('scripts/zenox-9742-9a290448d45250ed.js', 'utf8')

for (const k of ['mhYFb', 'wZqRX', 'WLCau', 'zbHFF', 'LUqZl', 'FTqkc', 'SlhRY', 'Oirrq', 'uULJH']) {
  const re = new RegExp("'" + k + "'\\s*:\\s*'([^']*)'")
  const m = js.match(re)
  console.log(k, m && m[1])
}

const apis = [...js.matchAll(/['"](\/api\/[^'"]{3,100})['"]/g)].map((m) => m[1])
console.log('api strings', [...new Set(apis)])

// Dump a larger window around the tmdbId fetch
const i = js.indexOf("['tmdbId']")
console.log('\n--- tmdbId fetch window ---')
console.log(js.slice(Math.max(0, i - 800), i + 900).replace(/\\x20/g, ' '))

// Find all string literals that look like endpoints
const strs = [...js.matchAll(/'(\/[a-z0-9][^']{2,80})'/gi)].map((m) => m[1])
console.log(
  '\npath-like',
  [...new Set(strs)].filter((s) => /api|stream|source|play|resolve|provider|proxy/i.test(s)).slice(0, 60),
)
