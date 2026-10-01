;(async () => {
  const html = await fetch('https://m2box.org/detail/clean-up-company-OrvX6rLJg76', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const raw = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  const data = JSON.parse(raw)

  // Find all subjectId keys in objects
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v && typeof v === 'object' && !Array.isArray(v) && 'subjectId' in v && 'title' in v) {
      const sidRef = v.subjectId
      const sidVal = typeof sidRef === 'number' ? data[sidRef] : sidRef
      const titleRef = v.title
      const titleVal = typeof titleRef === 'number' ? data[titleRef] : titleRef
      console.log('subject obj', i, { sidRef, sidVal, titleVal })
    }
  }

  // Current broken regex
  console.log('broken bare', html.match(/"subjectId"\s*:\s*(\d+)/)?.[1])
  console.log('broken quoted', html.match(/"subjectId"\s*:\s*"(\d+)"/)?.[1])

  // Find long digit strings that look like subject ids
  const longs = [...raw.matchAll(/"(1\d{15,20})"/g)].map((m) => m[1])
  console.log('long digit strings', [...new Set(longs)].slice(0, 10))
})()
