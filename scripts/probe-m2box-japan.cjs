;(async () => {
  const seen = new Set()
  for (let p = 1; p <= 50; p++) {
    const j = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: 'https://m2box.org/web/tv-series',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({ page: p, perPage: 36, channelId: 2, country: 'Japan' }),
    }).then((r) => r.json())
    const items = j?.data?.items || []
    console.log('page', p, 'n', items.length, 'hasMore', j?.data?.pager?.hasMore, 'first', items[0]?.title, items[0]?.countryName)
    for (const it of items) seen.add(String(it.subjectId))
    if (!items.length || !j?.data?.pager?.hasMore) break
  }
  console.log('Japan unique', seen.size)
})()
