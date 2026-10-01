function resolveData(data) {
  const memo = new Map()
  function resolve(v, stack = new Set()) {
    if (v === null || v === undefined) return v
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < data.length) {
      if (stack.has(v)) return `CYCLE:${v}`
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

;(async () => {
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

  const item = (filter?.data?.items || []).find((x) => /money heist/i.test(x.title)) || filter?.data?.items?.[2]
  const slug = item.detailPath.replace(/^\/detail\//, '')
  const detailUrl = `https://m2box.org/detail/${slug}`
  const html = await fetch(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)
  const revived = resolveData(data)

  const payload = revived.find(
    (x) => x && typeof x === 'object' && x.subject && x.resource && x.subject.subjectId,
  )
  console.log('title', payload?.subject?.title, 'sid', payload?.subject?.subjectId)
  console.log('resource', JSON.stringify(payload?.resource, null, 2).slice(0, 5000))

  const sid = String(payload?.subject?.subjectId || item.subjectId)
  async function play(se, ep) {
    const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${sid}&se=${se}&ep=${ep}`
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: detailUrl,
        'User-Agent': 'Mozilla/5.0',
      },
    })
    const j = await r.json()
    const streams = j?.data?.streams?.length || 0
    const hls = j?.data?.hls?.length || 0
    if (streams || hls) {
      console.log('PLAY HIT', se, ep, streams, hls)
      console.log(JSON.stringify(j.data, null, 2).slice(0, 2000))
    }
    return { se, ep, streams, hls, hasResource: j?.data?.hasResource }
  }

  const seasons = payload?.resource?.seasons || []
  console.log('\nseasons parsed count', seasons.length)
  for (const season of seasons.slice(0, 5)) {
    console.log('season', season.se, 'maxEp', season.maxEp, 'allEp', season.allEp?.slice?.(0, 40))
    for (let ep = 1; ep <= Math.min(Number(season.maxEp) || 3, 5); ep++) {
      await play(season.se ?? 1, ep)
    }
  }

  // brute force small se/ep
  for (let se = 1; se <= 5; se++) {
    for (let ep = 1; ep <= 5; ep++) {
      const r = await play(se, ep)
      if (r.streams || r.hls) break
    }
  }
})()
