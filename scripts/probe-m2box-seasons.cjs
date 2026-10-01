function resolveOnce(data, ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < data.length) {
    let v = data[ref]
    // Unwrap Nuxt Reactive/Ref wrappers once
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      /^(?:Shallow)?Reactive|Ref$/i.test(v[0])
    ) {
      return resolveOnce(data, v[1])
    }
    return v
  }
  return ref
}

async function fetchShow(titleRe) {
  for (let page = 1; page <= 5; page++) {
    const filter = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://m2box.org',
        Referer: 'https://m2box.org/web/tv-series',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({ page, perPage: 36, channelId: 2 }),
    }).then((r) => r.json())
    const hit = (filter?.data?.items || []).find((x) => titleRe.test(x.title))
    if (hit) return hit
  }
  return null
}

;(async () => {
  for (const [label, re] of [
    ['Mourinho', /mourinho/i],
    ['Money Heist', /money heist/i],
    ['Naruto', /^Naruto$/i],
  ]) {
    const show = await fetchShow(re)
    if (!show) {
      console.log(label, 'NOT FOUND')
      continue
    }
    const slug = show.detailPath.replace(/^\/detail\//, '')
    const html = await fetch(`https://m2box.org/detail/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then((r) => r.text())
    const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    const data = JSON.parse(raw)

    let resource = null
    for (const entry of data) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'seasons' in entry) {
        resource = entry
        break
      }
    }
    const seasonsArr = data[resource.seasons]
    console.log('\n===', show.title, 'source=', resolveOnce(data, resource.source))
    for (let i = 0; i < seasonsArr.length; i++) {
      const season = data[seasonsArr[i]]
      const se = resolveOnce(data, season.se)
      const maxEp = resolveOnce(data, season.maxEp)
      console.log(`  [${i}] se=${JSON.stringify(se)} maxEp=${JSON.stringify(maxEp)}`)
    }
  }
})()
