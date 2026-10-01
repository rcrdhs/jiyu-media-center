const fs = require('fs')
const html = fs.readFileSync(__dirname + '/m2box-list.html', 'utf8')

const hrefs = [...html.matchAll(/href="(\/[^"]+)"/gi)].map((m) => m[1])
const uniq = [...new Set(hrefs)].filter((h) => !h.includes('tv-series') && !h.includes('css') && !h.includes('.js'))
console.log('internal hrefs', uniq.slice(0, 40))

const titles = [...html.matchAll(/The Walking Dead|Naruto|Community/gi)]
console.log('title hits', titles.length)

// NUXT data block
const nuxt = html.match(/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
if (nuxt) {
  const raw = nuxt[1]
  console.log('nuxt data bytes', raw.length)
  const snippets = ['subjectId', 'subjectType', 'cover', 'Walking Dead', 'imdb', 'season', 'episode', 'playUrl', 'm3u8', 'h5-api']
  for (const s of snippets) {
    const idx = raw.indexOf(s)
    if (idx >= 0) console.log(s, 'at', idx, raw.slice(Math.max(0, idx - 40), idx + 120))
  }
}

// poster CDN
const posters = [...html.matchAll(/https:\/\/[^"'\s]+(?:pacdn|aoneroom)[^"'\s]+/gi)].map((m) => m[0])
console.log('cdn urls sample', [...new Set(posters)].slice(0, 8))
