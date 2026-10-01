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
    body: JSON.stringify({ page: 1, perPage: 5, channelId: 2 }),
  }).then((r) => r.json())

  for (const item of filter?.data?.items || []) {
    console.log('---', item.title)
    console.log('description:', (item.description || '').slice(0, 200))
    console.log('keys', Object.keys(item).filter((k) => /desc|summary|plot|overview|genre|meta/i.test(k)))
  }

  const show = filter.data.items[0]
  const slug = show.detailPath.replace(/^\/detail\//, '')
  const html = await fetch(`https://m2box.org/detail/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)

  function resolveOnce(ref) {
    if (typeof ref === 'number' && ref >= 0 && ref < data.length) {
      let v = data[ref]
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /Reactive|Ref/i.test(v[0])) {
        return resolveOnce(v[1])
      }
      return v
    }
    return ref
  }

  for (const entry of data) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'subjectId' in entry && 'description' in entry) {
      console.log('\ndetail description:', String(resolveOnce(entry.description)).slice(0, 300))
      console.log('genre:', resolveOnce(entry.genre))
    }
  }
})()
