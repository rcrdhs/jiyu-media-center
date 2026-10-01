;(async () => {
  // Baseline page 1
  const base = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ page: 1, perPage: 5, channelId: 2 }),
  }).then((r) => r.json())

  const item = base?.data?.items?.[0]
  console.log('sample keys', item && Object.keys(item))
  console.log('sample country-ish', {
    country: item?.country,
    countryName: item?.countryName,
    region: item?.region,
    area: item?.area,
    nation: item?.nation,
    tags: item?.tags,
  })
  console.log('full sample', JSON.stringify(item, null, 2).slice(0, 1500))

  // Try country filter bodies
  const tries = [
    { page: 1, perPage: 5, channelId: 2, country: 'United States' },
    { page: 1, perPage: 5, channelId: 2, country: 'US' },
    { page: 1, perPage: 5, channelId: 2, countryName: 'United States' },
    { page: 1, perPage: 5, channelId: 2, area: 'United States' },
    { page: 1, perPage: 5, channelId: 2, countries: ['United States'] },
    { page: 1, perPage: 5, channelId: 2, filter: { country: 'United States' } },
    { page: 1, perPage: 5, channelId: 2, countryId: 1 },
    { page: 1, perPage: 5, channelId: 2, ops: [{ field: 'country', op: 'eq', value: 'United States' }] },
  ]
  for (const body of tries) {
    const j = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: 'https://m2box.org/web/tv-series',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(body),
    }).then((r) => r.json())
    const titles = (j?.data?.items || []).map((x) => x.title).slice(0, 3)
    console.log('\nbody', JSON.stringify(body))
    console.log('code', j?.code, 'count', j?.data?.items?.length, 'titles', titles)
  }

  // Fetch list HTML / nuxt for country filter ids
  const html = await fetch('https://m2box.org/web/tv-series', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const hits = []
  if (raw) {
    const data = JSON.parse(raw)
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      if (typeof v === 'string' && /united states|united kingdom|korea|japan|country/i.test(v)) {
        hits.push([i, v])
      }
    }
  }
  console.log('\ncountry strings in nuxt', hits.slice(0, 40))
})()
