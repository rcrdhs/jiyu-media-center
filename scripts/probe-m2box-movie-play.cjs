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
  const json = await res.json()
  return { status: res.status, json }
}

;(async () => {
  // From user screenshot URL pattern
  const movieId = '43990118050448720'
  const referer =
    'https://m2box.org/movies/love-and-hip-hop-miami-yNWNdHstf3?id=43990118050448720&type=/movie/detail&detailSe=&detailEp=&lang=en'

  const tries = [
    `subject_id=${movieId}`,
    `subject_id=${movieId}&se=1&ep=1`,
    `subject_id=${movieId}&type=/movie/detail`,
    `subject_id=${movieId}&detailSe=1&detailEp=1`,
    `subject_id=${movieId}&subjectType=1`,
    `subject_id=${movieId}&subjectType=6`,
  ]
  for (const qs of tries) {
    const r = await getPlay(qs, referer)
    const d = r.json?.data || {}
    console.log(qs, {
      streams: d.streams?.length,
      hls: d.hls?.length,
      hasResource: d.hasResource,
      vipLocked: d.vipLocked,
    })
    if (d.streams?.length || d.hls?.length) {
      console.log(JSON.stringify(d, null, 2).slice(0, 2500))
    }
  }

  // fetch movie detail SSR for subject id
  const html = await fetch('https://m2box.org/movies/love-and-hip-hop-miami-yNWNdHstf3', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const sid = html.match(/"subjectId":"(\d+)"/)?.[1]
  console.log('SSR subjectId', sid)
  if (sid) {
    const r = await getPlay(`subject_id=${sid}&se=1&ep=1`, referer)
    console.log('play with SSR id', JSON.stringify(r.json?.data, null, 2)?.slice(0, 2000))
  }
})()
