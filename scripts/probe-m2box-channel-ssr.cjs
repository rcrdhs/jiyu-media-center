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

const html = fs.readFileSync(__dirname + '/m2box-list.html', 'utf8')
const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
const revived = reviveNuxtPayload(m[1])
const flat = JSON.stringify(revived)
console.log('channelId hits', flat.match(/"channelId":\d+/g)?.slice(0, 10))
console.log('filterItemsData snippet', flat.match(/"filterItemsData":\{[^]{0,800}/)?.[0])
