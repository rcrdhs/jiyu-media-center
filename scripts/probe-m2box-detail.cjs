const fs = require('fs')

function reviveNuxtPayload(raw) {
  const data = JSON.parse(raw)
  const memo = new Map()
  function resolve(v, stack = new Set()) {
    if (v === null || v === undefined) return v
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < data.length) {
      if (stack.has(v)) return null
      stack.add(v)
      const out = resolve(data[v], stack)
      stack.delete(v)
      return out
    }
    if (typeof v !== 'object') return v
    if (memo.has(v)) return memo.get(v)
    if (Array.isArray(v)) {
      if (
        v.length === 2 &&
        typeof v[0] === 'string' &&
        /^(?:Shallow)?Reactive|Ref|Empty|Set|Map|Object|Array$/i.test(v[0])
      ) {
        return resolve(v[1], stack)
      }
      const arr = v.map((item) => resolve(item, stack))
      memo.set(v, arr)
      return arr
    }
    const out = {}
    memo.set(v, out)
    for (const [k, val] of Object.entries(v)) out[k] = resolve(val, stack)
    return out
  }
  return data.map((_, i) => resolve(i))
}

function walk(obj, hits, path = '') {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, hits, `${path}[${i}]`))
    return
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (/season|episode|resource|play|stream|m3u8|subjectId|se\b|ep\b/i.test(k)) {
      hits.push({ path: p, value: typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v })
    }
    walk(v, hits, p)
  }
}

;(async () => {
  const slug = process.argv[2] || 'attack-on-titan-c0p85b63Xl2'
  const res = await fetch(`https://m2box.org/detail/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const html = await res.text()
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) {
    console.log('no nuxt')
    return
  }
  const revived = reviveNuxtPayload(m[1])
  const hits = []
  for (const entry of revived) walk(entry, hits)
  console.log('interesting fields', hits.slice(0, 40))

  const flat = JSON.stringify(revived)
  const subjectMatch = flat.match(/"subjectId":"(\d+)"/)
  console.log('subjectId', subjectMatch?.[1])

  // search bundle for api paths
  const js = await fetch('https://spa.aoneroom.com/ssrStatic/m2boxorg/public/_nuxt/K0LPz00A.js').then((r) =>
    r.text(),
  )
  const paths = [...js.matchAll(/wefeed-h5api-bff\/[^"'`]+/g)].map((x) => x[0])
  console.log('api paths', [...new Set(paths)].sort())
})()
