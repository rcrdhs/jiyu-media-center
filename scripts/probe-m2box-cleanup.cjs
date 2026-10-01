async function play(sid, slug, se, ep, refererOverride) {
  const referer =
    refererOverride ||
    `https://m2box.org/movies/${slug}?id=${sid}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${sid}&se=${se}&ep=${ep}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
    },
  })
  const j = await res.json()
  const streams = j?.data?.streams || []
  const hls = j?.data?.hls || []
  return {
    se,
    ep,
    n: streams.length + hls.length,
    hasResource: j?.data?.hasResource,
    vipLocked: j?.data?.vipLocked,
    freeNum: j?.data?.freeNum,
    limited: j?.data?.limited,
    code: j?.code,
    message: j?.message,
    sample: streams[0]?.url || hls[0]?.url || null,
    rawKeys: j?.data ? Object.keys(j.data) : [],
  }
}

function resolveOnce(data, ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < data.length) {
    let v = data[ref]
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      /^(?:Shallow)?Reactive|Ref$/i.test(v[0])
    ) {
      return resolveOnce(data, v[1])
    }
    return v
  }
  return ref
}

;(async () => {
  // Find Clean Up Company
  let show = null
  for (let page = 1; page <= 20 && !show; page++) {
    const filter = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: 'https://m2box.org/web/tv-series',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({ page, perPage: 36, channelId: 2 }),
    }).then((r) => r.json())
    show = (filter?.data?.items || []).find((x) => /clean up company/i.test(x.title))
    if (show) console.log('found page', page)
  }
  if (!show) {
    console.log('not found in filter — try search')
    return
  }
  console.log('show', {
    title: show.title,
    sid: show.subjectId,
    path: show.detailPath,
    hasResource: show.hasResource,
    subjectType: show.subjectType,
  })

  const slug = show.detailPath.replace(/^\/detail\//, '')
  const sid = String(show.subjectId)
  const detailUrl = `https://m2box.org/detail/${slug}`
  const html = await fetch(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) =>
    r.text(),
  )
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)
  let resource = null
  let subject = null
  for (const entry of data) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if ('seasons' in entry && 'source' in entry) resource = entry
      if (entry.subject && entry.resource) {
        resource = typeof entry.resource === 'number' ? data[entry.resource] : entry.resource
        subject = typeof entry.subject === 'number' ? data[entry.subject] : entry.subject
      }
    }
  }
  // walk for subject+resource payload
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.subject && node.resource) {
      const s = typeof node.subject === 'number' ? data[node.subject] : node.subject
      const r = typeof node.resource === 'number' ? data[node.resource] : node.resource
      if (s?.subjectId || (typeof s === 'object' && 'subjectId' in (s || {}))) {
        subject = s
        resource = r
      }
    }
    for (const v of Object.values(node)) walk(v)
  }
  for (const entry of data) walk(entry)

  const subj = typeof subject === 'number' ? data[subject] : subject
  console.log('detail subjectId', resolveOnce(data, subj?.subjectId ?? subj))
  console.log('source', resolveOnce(data, resource?.source))

  const seasonsArr =
    typeof resource?.seasons === 'number' ? data[resource.seasons] : resource?.seasons
  if (Array.isArray(seasonsArr)) {
    for (let i = 0; i < seasonsArr.length; i++) {
      const season = data[seasonsArr[i]]
      console.log('season', i, {
        se: resolveOnce(data, season.se),
        maxEp: resolveOnce(data, season.maxEp),
      })
    }
  } else {
    console.log('no seasons array', seasonsArr)
  }

  // Try many referer / se / ep combos
  const tries = []
  for (let se = 0; se <= 3; se++) {
    for (let ep = 0; ep <= 3; ep++) {
      tries.push({ se, ep })
    }
  }
  for (const { se, ep } of tries) {
    const r = await play(sid, slug, se, ep)
    if (r.n || r.vipLocked || (se <= 1 && ep <= 1)) {
      console.log('play', JSON.stringify(r))
    }
  }

  // Alternate referers
  for (const referer of [
    detailUrl,
    `https://m2box.org/detail/${slug}?se=1&ep=1`,
    `https://m2box.org/movies/${slug}?id=${sid}&type=/tv/detail&detailSe=1&detailEp=1&lang=en`,
    `https://m2box.org/web/tv-series`,
  ]) {
    const r = await play(sid, slug, 1, 1, referer)
    console.log('alt referer', referer.slice(0, 70), r.n, r.hasResource, r.vipLocked)
  }
})()
