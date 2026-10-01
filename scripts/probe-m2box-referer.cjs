async function play(qs, referer) {
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?${qs}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
    },
  })
  const j = await res.json()
  const d = j?.data || {}
  const n = (d.streams?.length || 0) + (d.hls?.length || 0)
  if (n) console.log('HIT', qs, '\n referer', referer.slice(0, 100), '\n', JSON.stringify(d, null, 2).slice(0, 1200))
  return n
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
    body: JSON.stringify({ page: 1, perPage: 10, channelId: 2 }),
  }).then((r) => r.json())

  const item = filter?.data?.items?.[0]
  const slug = item.detailPath.replace(/^\/detail\//, '')
  const sid = String(item.subjectId)
  console.log('show', item.title, sid)

  const referers = [
    `https://m2box.org/detail/${slug}`,
    `https://m2box.org/detail/${slug}?se=1&ep=1`,
    `https://m2box.org/movies/${slug}?id=${sid}&type=/movie/detail&detailSe=1&detailEp=1&lang=en`,
    `https://m2box.org/movies/${slug}?id=${sid}&type=/tv/detail&detailSe=1&detailEp=1&lang=en`,
    `https://m2box.org/web/tv-series`,
  ]

  const qss = [
    `subject_id=${sid}&se=1&ep=1`,
    `subject_id=${sid}&se=1&ep=1&lang=en`,
    `subject_id=${sid}&se=1&ep=1&subjectType=2`,
    `subject_id=${sid}&se=1&ep=1&subjectType=6`,
    `subject_id=${sid}&se=1&ep=1&type=/tv/detail`,
    `subject_id=${sid}&detailSe=1&detailEp=1`,
  ]

  for (const referer of referers) {
    for (const qs of qss) {
      const n = await play(qs, referer)
      if (n) process.exit(0)
    }
  }
  console.log('no hits for series')

  // movie sanity
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
  const movie = movies?.data?.items?.find((x) => x.hasResource) || movies?.data?.items?.[0]
  const mslug = movie.detailPath.replace(/^\/detail\//, '')
  const msid = String(movie.subjectId)
  const mref = `https://m2box.org/movies/${mslug}?id=${msid}&type=/movie/detail&lang=en`
  await play(`subject_id=${msid}&se=1&ep=1`, mref)
})()
