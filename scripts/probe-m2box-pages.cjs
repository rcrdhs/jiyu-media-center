const fs = require('fs')

function reviveNuxtPayload(raw) {
  const data = JSON.parse(raw)
  const memo = new Map()

  function resolve(v, stack = new Set()) {
    if (v === null || v === undefined) return v
    const t = typeof v
    if (t === 'number' && Number.isInteger(v) && v >= 0 && v < data.length) {
      if (stack.has(v)) return null
      stack.add(v)
      const out = resolve(data[v], stack)
      stack.delete(v)
      return out
    }
    if (t !== 'object') return v
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
    for (const [k, val] of Object.entries(v)) {
      out[k] = resolve(val, stack)
    }
    return out
  }
  return data.map((_, i) => resolve(i))
}

function extractM2BoxSubjects(revived) {
  const subjects = []
  const seen = new Set()
  let pager = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.pager && typeof node.pager === 'object' && node.items) {
      pager = node.pager
    }
    if (
      (typeof node.subjectId === 'number' || typeof node.subjectId === 'string') &&
      typeof node.title === 'string' &&
      typeof node.detailPath === 'string'
    ) {
      const id = String(node.subjectId)
      if (!seen.has(id)) {
        seen.add(id)
        subjects.push(node)
      }
    }
    for (const val of Object.values(node)) walk(val)
  }
  for (const entry of revived) walk(entry)
  return { subjects, pager }
}

async function run(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  })
  const html = await res.text()
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) {
    console.log('no data', url)
    return
  }
  const revived = reviveNuxtPayload(m[1])
  const { subjects, pager } = extractM2BoxSubjects(revived)
  console.log(url, subjects.length, subjects.slice(0, 2).map((s) => s.title), pager)
}

;(async () => {
  await run('https://m2box.org/web/tv-series')
  await run('https://m2box.org/web/tv-series?page=2')
})()
