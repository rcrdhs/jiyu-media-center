async function getPlay(qs, referer) {
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?${qs}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
    },
  })
  return res.json()
}

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

function findDetailPayload(revived) {
  let best = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.subject && node.resource && node.subject.subjectId) best = node
    for (const val of Object.values(node)) walk(val)
  }
  for (const entry of revived) walk(entry)
  return best
}

;(async () => {
  const slug = process.argv[2] || 'naruto-abc'
  // pick Naruto from filter
  const filter = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ page: 1, perPage: 50, channelId: 2 }),
  }).then((r) => r.json())

  const item = (filter?.data?.items || []).find((x) => /naruto/i.test(x.title)) || filter?.data?.items?.[6]
  if (!item) {
    console.log('no item')
    return
  }
  const slug2 = item.detailPath.replace(/^\/detail\//, '')
  const referer = `https://m2box.org/detail/${slug2}`
  const sid = String(item.subjectId)
  console.log('title', item.title, 'sid', sid, 'hasResource', item.hasResource)

  const html = await fetch(referer, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  const payload = findDetailPayload(reviveNuxtPayload(m[1]))
  console.log('detail subjectId', payload?.subject?.subjectId)
  console.log('seasons count', payload?.resource?.seasons?.length)
  if (payload?.resource?.seasons?.[0]) {
    console.log('season0', JSON.stringify(payload.resource.seasons[0], null, 2).slice(0, 800))
  }

  const tries = []
  for (let se = 0; se <= 6; se++) {
    for (let ep = 0; ep <= 10; ep++) {
      tries.push(`subject_id=${sid}&se=${se}&ep=${ep}`)
    }
  }
  tries.push(`subject_id=${sid}&se=1&ep=1&type=/tv/detail`)
  tries.push(`subject_id=${sid}&se=1&ep=1&subjectType=2`)

  for (const qs of tries) {
    const r = await getPlay(qs, referer)
    const d = r?.data || {}
    if ((d.streams?.length || 0) + (d.hls?.length || 0) > 0) {
      console.log('HIT', qs, d.streams?.length, d.hls?.length)
      console.log(JSON.stringify(d, null, 2).slice(0, 1500))
      break
    }
  }

  // try movies channel item
  const movies = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/movies',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ page: 1, perPage: 5, channelId: 1 }),
  }).then((r) => r.json())
  const movie = movies?.data?.items?.[0]
  if (movie) {
    const mslug = movie.detailPath.replace(/^\/detail\//, '')
    const mref = `https://m2box.org/movies/${mslug}?id=${movie.subjectId}`
    const r = await getPlay(`subject_id=${movie.subjectId}&se=1&ep=1`, mref)
    console.log('\nmovie', movie.title, (r?.data?.streams?.length || 0) + (r?.data?.hls?.length || 0))
  }
})()
