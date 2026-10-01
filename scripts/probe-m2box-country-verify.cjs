async function filterCountry(country, page = 1) {
  const j = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ page, perPage: 36, channelId: 2, country }),
  }).then((r) => r.json())
  const items = j?.data?.items || []
  const countries = {}
  for (const it of items) {
    const c = it.countryName || '(none)'
    countries[c] = (countries[c] || 0) + 1
  }
  return {
    country,
    page,
    n: items.length,
    hasMore: j?.data?.pager?.hasMore,
    countries,
    sample: items.slice(0, 5).map((x) => `${x.title} [${x.countryName}]`),
  }
}

;(async () => {
  for (const c of ['United States', 'United Kingdom', 'Korea', 'Japan', 'All', '']) {
    console.log(JSON.stringify(await filterCountry(c), null, 2))
  }

  // Count unique over a few pages per country
  for (const c of ['United States', 'United Kingdom', 'Korea', 'Japan']) {
    const seen = new Set()
    let mismatched = 0
    for (let p = 1; p <= 30; p++) {
      const j = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://m2box.org',
          Referer: 'https://m2box.org/web/tv-series',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ page: p, perPage: 36, channelId: 2, country: c }),
      }).then((r) => r.json())
      const items = j?.data?.items || []
      if (!items.length) break
      for (const it of items) {
        seen.add(String(it.subjectId))
        if (it.countryName !== c) mismatched += 1
      }
      if (!j?.data?.pager?.hasMore) break
    }
    console.log(`\n${c}: unique=${seen.size} mismatchedCountryName=${mismatched}`)
  }
})()
