;(async () => {
  const referer = 'https://m2box.org/detail/naruto-english-abc'
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
  const item =
    (filter?.data?.items || []).find((x) => /naruto/i.test(x.title)) ||
    (filter?.data?.items || []).find((x) => x.hasResource) ||
    filter?.data?.items?.[0]
  if (!item) {
    console.log('no filter item')
    return
  }
  console.log('item', item.title, item.subjectId, item.hasResource)
  const slug = item.detailPath.replace(/^\/detail\//, '')
  const url = `https://m2box.org/detail/${slug}`
  const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)
  console.log('payload length', data.length)

  // find indices mentioning seasons, se, maxEp
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (typeof v === 'string' && (/^S\d+/i.test(v) || /^E\d+/i.test(v) || v === 'seasons' || v === 'maxEp' || v === 'allEp')) {
      console.log('str', i, v)
    }
    if (typeof v === 'number' && v > 0 && v < 200 && Number.isInteger(v)) {
      // possible se/ep
    }
  }

  // dump objects that contain "seasons" key as string ref
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v)
      if (keys.includes('seasons') || keys.includes('subject') || keys.includes('resource')) {
        console.log('obj', i, keys.slice(0, 8))
      }
    }
  }

  // search for small integers 1-30 near season-related strings
  const seasonIdx = data.findIndex((x) => x === 'seasons')
  console.log('seasons idx', seasonIdx)
  if (seasonIdx >= 0) {
    for (let i = Math.max(0, seasonIdx - 20); i < Math.min(data.length, seasonIdx + 40); i++) {
      console.log(i, typeof data[i], JSON.stringify(data[i])?.slice(0, 120))
    }
  }

  // try other API endpoints
  const sid = String(item.subjectId)
  const endpoints = [
    `/wefeed-h5api-bff/subject/detail?subject_id=${sid}`,
    `/wefeed-h5api-bff/subject/resource?subject_id=${sid}`,
    `/wefeed-h5api-bff/subject/season?subject_id=${sid}`,
    `/wefeed-h5api-bff/subject/episode?subject_id=${sid}&se=1&ep=1`,
    `/wefeed-h5api-bff/subject/episodes?subject_id=${sid}&se=1`,
  ]
  for (const path of endpoints) {
    const api = `https://h5-api.aoneroom.com${path}`
    const r = await fetch(api, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: url,
        'User-Agent': 'Mozilla/5.0',
      },
    })
    const text = await r.text()
    console.log('\n', path, r.status, text.slice(0, 400))
  }
})()
