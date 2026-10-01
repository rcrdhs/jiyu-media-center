const fs = require('fs')
const https = require('https')

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122' } }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve(d))
      })
      .on('error', reject)
  })
}

function reviveNuxtData(raw) {
  const arr = JSON.parse(raw)
  function walk(v) {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /Reactive|Ref/.test(v[0])) {
      return walk(v[1])
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < arr.length) {
      return walk(arr[v])
    }
    return v
  }
  return walk(arr)
}

;(async () => {
  const html = await get('https://m2box.org/web/tv-series')
  const m = html.match(/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) {
    console.log('no nuxt data')
    return
  }
  const revived = reviveNuxtData(m[1])
  fs.writeFileSync(__dirname + '/m2box-nuxt.json', JSON.stringify(revived, null, 2))
  console.log('revived keys', Object.keys(revived))

  // Find show list in payload
  const data = revived.data || revived
  const flat = JSON.stringify(data)
  const titleHits = flat.match(/"title":"[^"]{3,80}"/g)?.slice(0, 10)
  console.log('title samples', titleHits)

  // walk for pager/list structures
  function findLists(obj, path = '') {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj) && obj.length > 5 && obj[0] && typeof obj[0] === 'object') {
      const keys = Object.keys(obj[0])
      if (keys.some((k) => /title|name|subject|poster|cover/i.test(k))) {
        console.log('\nlist at', path, 'len', obj.length, 'keys', keys.slice(0, 15))
        console.log('sample', JSON.stringify(obj[0], null, 2).slice(0, 800))
      }
    }
    if (Array.isArray(obj)) obj.forEach((v, i) => findLists(v, `${path}[${i}]`))
    else for (const [k, v] of Object.entries(obj)) findLists(v, path ? `${path}.${k}` : k)
  }
  findLists(revived)
})()
