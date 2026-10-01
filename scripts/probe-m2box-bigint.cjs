;(async () => {
  const res = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: 'https://m2box.org/web/tv-series',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ page: 2, perPage: 36, channelId: 2 }),
  })
  const text = await res.text()
  const m = text.match(/Clean Up Company[\s\S]{0,200}/)
  console.log('raw snippet around title:\n', m?.[0])

  // Find subjectId near Clean Up Company in raw text
  const idx = text.indexOf('Clean Up Company')
  console.log('\ncontext:\n', text.slice(Math.max(0, idx - 300), idx + 200))

  const parsed = JSON.parse(text)
  const item = (parsed?.data?.items || []).find((x) => /clean up company/i.test(x.title))
  console.log('\nparsed subjectId', item?.subjectId, typeof item?.subjectId)
  console.log('String()', String(item?.subjectId))
  console.log('MAX_SAFE', Number.MAX_SAFE_INTEGER)
  console.log('precision lost?', String(item?.subjectId) !== '5134210409830023072')

  // Compare with SSR
  const slug = 'clean-up-company-OrvX6rLJg76'
  const html = await fetch(`https://m2box.org/detail/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const sidQuoted = html.match(/"subjectId"\s*:\s*"(\d+)"/)
  const sidBare = html.match(/"subjectId"\s*:\s*(\d+)/)
  console.log('\nSSR quoted', sidQuoted?.[1])
  console.log('SSR bare', sidBare?.[1])
})()
