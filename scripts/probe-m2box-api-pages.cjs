async function post(channelId, page) {
  const res = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
    },
    body: JSON.stringify({ page, perPage: 36, channelId }),
  })
  return res.json()
}

;(async () => {
  const seen = new Set()
  for (let page = 1; page <= 25; page++) {
    const json = await post(2, page)
    const items = json?.data?.items || []
    let added = 0
    for (const item of items) {
      const id = String(item.subjectId)
      if (!seen.has(id)) {
        seen.add(id)
        added++
      }
    }
    console.log('page', page, 'batch', items.length, 'new', added, 'total', seen.size, 'hasMore', json?.data?.pager?.hasMore)
    if (!json?.data?.pager?.hasMore) break
  }
})()
