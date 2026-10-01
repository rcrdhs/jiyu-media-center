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
    if (node.subject && node.resource && node.subject.subjectId) {
      best = node
    }
    for (const val of Object.values(node)) walk(val)
  }
  for (const entry of revived) walk(entry)
  return best
}

async function getPlay(subjectId, qs, referer) {
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${subjectId}${qs}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
    },
  })
  return res.json()
}

;(async () => {
  const slug = 'attack-on-titan-c0p85b63Xl2'
  const referer = `https://m2box.org/detail/${slug}`
  const html = await fetch(referer, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  const revived = reviveNuxtPayload(m[1])
  const payload = findDetailPayload(revived)
  console.log('title', payload?.subject?.title)
  console.log('subjectId', payload?.subject?.subjectId)
  console.log('resource keys', payload?.resource ? Object.keys(payload.resource) : null)
  console.log('resource sample', JSON.stringify(payload?.resource, null, 2).slice(0, 4000))

  const sid = payload?.subject?.subjectId
  for (let se = 0; se <= 4; se++) {
    for (let ep = 1; ep <= 3; ep++) {
      const r = await getPlay(sid, `&se=${se}&ep=${ep}`, referer)
      const streams = r?.data?.streams || []
      const hls = r?.data?.hls || []
      if (streams.length || hls.length) {
        console.log('\nHIT se', se, 'ep', ep)
        console.log(JSON.stringify(r.data, null, 2).slice(0, 3000))
      }
    }
  }

  // try without se/ep but with other params from user URL
  for (const qs of [
    '',
    '&type=/movie/detail',
    '&detailSe=1&detailEp=1',
    '&subjectType=2',
  ]) {
    const r = await getPlay(sid, qs, referer)
    if ((r?.data?.streams?.length || 0) + (r?.data?.hls?.length || 0) > 0) {
      console.log('hit', qs, JSON.stringify(r.data, null, 2).slice(0, 2000))
    }
  }
})()
