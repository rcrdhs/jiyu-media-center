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
    first: streams[0]?.url || hls[0]?.url,
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
    body: JSON.stringify({ page: 1, perPage: 20, channelId: 2 }),
  }).then((r) => r.json())

  const item = (filter?.data?.items || []).find((x) => /money heist|breaking bad|naruto|13 reasons/i.test(x.title))
  if (!item) {
    console.log('pick first', filter?.data?.items?.[0]?.title)
  }
  const show = item || filter?.data?.items?.[0]
  const slug = show.detailPath.replace(/^\/detail\//, '')
  const sid = String(show.subjectId)
  console.log('show', show.title)

  for (let ep = 1; ep <= 5; ep++) {
    const r = await play(sid, slug, 1, ep)
    console.log('S1E' + ep, r.n ? r.res : 'empty')
  }
  for (let se = 2; se <= 3; se++) {
    const r = await play(sid, slug, se, 1)
    console.log('S' + se + 'E1', r.n ? r.res : 'empty')
  }
})()
