async function getPlay(sid, se, ep, referer) {
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${sid}&se=${se}&ep=${ep}`
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
    },
  })
  const j = await r.json()
  const streams = j?.data?.streams || []
  const hls = j?.data?.hls || []
  return {
    streams: streams.length,
    hls: hls.length,
    first: streams[0]?.url || hls[0]?.url || null,
    resolutions: streams.map((s) => s.resolutions).join(','),
    vipLocked: j?.data?.vipLocked,
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
  const items = filter?.data?.items || []
  for (const item of items) {
    const slug = item.detailPath.replace(/^\/detail\//, '')
    const referer = `https://m2box.org/detail/${slug}`
    const sid = String(item.subjectId)
    let hit = null
    for (let se = 1; se <= 3 && !hit; se++) {
      for (let ep = 1; ep <= 5 && !hit; ep++) {
        const r = await getPlay(sid, se, ep, referer)
        if (r.streams || r.hls) hit = { se, ep, ...r }
      }
    }
    console.log(
      item.title.slice(0, 45).padEnd(45),
      sid,
      item.hasResource ? 'hasRes' : 'noRes',
      hit ? JSON.stringify(hit) : 'NO HIT',
    )
  }
})()
