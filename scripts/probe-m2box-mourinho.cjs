async function play(sid, slug, se, ep) {
  const referer = `https://m2box.org/movies/${slug}?id=${sid}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${sid}&se=${se}&ep=${ep}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
    },
  })
  const j = await res.json()
  const streams = j?.data?.streams || []
  const hls = j?.data?.hls || []
  return {
    se,
    ep,
    n: streams.length + hls.length,
    res: streams.map((s) => s.resolutions).join(','),
    hasResource: j?.data?.hasResource,
    vipLocked: j?.data?.vipLocked,
    code: j?.code,
    message: j?.message,
  }
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

  const show = (filter?.data?.items || []).find((x) => /mourinho/i.test(x.title))
  if (!show) {
    console.log('Mourinho not on page 1; searching…')
  }
  console.log('show', show?.title, show?.subjectId, show?.detailPath, show?.hasResource)

  const sid = String(show.subjectId)
  const slug = show.detailPath.replace(/^\/detail\//, '')

  // Dump raw Nuxt resource without broken reviver — look at integer slots near seasons
  const html = await fetch(`https://m2box.org/detail/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)

  // Find resource object index
  let resourceIdx = -1
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v && typeof v === 'object' && !Array.isArray(v) && 'seasons' in v && 'source' in v) {
      resourceIdx = i
      console.log('resource raw', i, JSON.stringify(v))
    }
  }

  // Dump seasons array raw
  if (resourceIdx >= 0) {
    const seasonsRef = data[resourceIdx].seasons
    console.log('seasons ref', seasonsRef, 'value', JSON.stringify(data[seasonsRef]).slice(0, 500))
    const seasonsArr = data[seasonsRef]
    if (Array.isArray(seasonsArr)) {
      for (const seasonRef of seasonsArr) {
        const season = data[seasonRef]
        console.log('season raw', seasonRef, JSON.stringify(season))
        if (season && typeof season === 'object') {
          for (const [k, v] of Object.entries(season)) {
            console.log('  ', k, '->', v, typeof data[v] === 'undefined' ? '' : JSON.stringify(data[v]).slice(0, 200))
          }
        }
      }
    }
  }

  // Brute se/ep
  for (let se = 1; se <= 4; se++) {
    for (let ep = 1; ep <= 6; ep++) {
      const r = await play(sid, slug, se, ep)
      if (r.n) console.log('HIT', r)
      else if (ep === 1) console.log('miss', se, ep, r.hasResource, r.vipLocked, r.code)
    }
  }
})()
