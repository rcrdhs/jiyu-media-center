const fs = require('fs')
const js = fs.readFileSync('scripts/zenox-9742-9a290448d45250ed.js', 'utf8')
const js2 = fs.readFileSync('scripts/zenox-2951-ec49ed98039b4fb6.js', 'utf8')

// Find workers.dev / proxy hosts
for (const src of [js, js2]) {
  const hosts = [...src.matchAll(/https?:\/\/[a-zA-Z0-9._-]+\.(workers\.dev|xyz|lol|com|net|app)/g)].map(
    (m) => m[0],
  )
  console.log('hosts', [...new Set(hosts)])
}

// Find Temporary/Primary value strings near server list
const i = js2.indexOf("'Temporary'")
console.log('\n--- Temporary server list context ---')
console.log(js2.slice(Math.max(0, i - 500), i + 800).replace(/\\x20/g, ' '))

// Search FTqkc assignment differently - maybe unicode escaped
for (const file of ['zenox-9742-9a290448d45250ed.js', 'zenox-2951-ec49ed98039b4fb6.js']) {
  const s = fs.readFileSync('scripts/' + file, 'utf8')
  const m = [...s.matchAll(/FTqkc[^,]{0,80}/g)].slice(0, 5)
  console.log('\nFTqkc in', file, m.map((x) => x[0]))
  const m2 = [...s.matchAll(/workers\.dev[^'"]{0,40}/g)].slice(0, 10)
  console.log('workers', m2.map((x) => x[0]))
  const m3 = [...s.matchAll(/basement[^'"]{0,60}/gi)].slice(0, 10)
  console.log('basement', m3.map((x) => x[0]))
}
