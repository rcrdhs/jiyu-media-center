async function filter(channelId, page = 1) {
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
  const json = await res.json()
  const items = json?.data?.items || []
  return {
    channelId,
    count: items.length,
    titles: items.slice(0, 2).map((i) => i.title),
    hasMore: json?.data?.pager?.hasMore,
  }
}

const paths = [
  '/web/tv-series',
  '/web/movies',
  '/web/movie',
  '/web/anime',
  '/web/kids',
  '/web/series',
]

;(async () => {
  for (let id = 1; id <= 12; id++) console.log(await filter(id))
})()
