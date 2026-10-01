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

async function filter(body) {
  const res = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  return {
    body,
    count: json?.data?.items?.length || 0,
    pager: json?.data?.pager,
    titles: (json?.data?.items || []).slice(0, 2).map((i) => i.title),
  }
}

;(async () => {
  const html = fs.readFileSync(__dirname + '/m2box-list.html', 'utf8')
  const flat = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)[1]
  const revived = reviveNuxtPayload(flat)
  const text = JSON.stringify(revived)
  for (const key of ['channelId', 'subjectType', 'filterId', 'tabId', 'pageType', 'categoryId']) {
    const re = new RegExp(`"${key}":(\\d+|\"[^\"]+\")`, 'g')
    const hits = [...text.matchAll(re)].slice(0, 8).map((m) => m[0])
    if (hits.length) console.log(key, hits)
  }

  for (const channelId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const r = await filter({ page: 1, perPage: 36, channelId })
    console.log('channel', channelId, r.titles, r.pager?.totalCount)
  }

  let page = 1
  const seen = new Set()
  while (page <= 5) {
    const res = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://m2box.org',
        Referer: 'https://m2box.org/web/tv-series',
      },
      body: JSON.stringify({ page, perPage: 36, channelId: 2 }),
    })
    const json = await res.json()
    const items = json?.data?.items || []
    let added = 0
    for (const item of items) {
      const id = String(item.subjectId)
      if (!seen.has(id)) {
        seen.add(id)
        added++
      }
    }
    console.log('page', page, 'items', items.length, 'new', added, 'total', seen.size, 'hasMore', json?.data?.pager?.hasMore)
    if (!json?.data?.pager?.hasMore) break
    page += 1
  }
})()
