/**
 * Smoke-test Nyaa seeder column scrape (mirrors scrapeNyaaSearchResults).
 */
;(async () => {
  const url = 'https://nyaa.si/?f=0&c=1_2&q=The+Eternal+Supreme&s=seeders&o=desc'
  const html = await (await fetch(url)).text()
  const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((m) => m[0])
    .filter((r) => /magnet:\?/i.test(r) && /\/view\//i.test(r))
  const parsed = []
  for (const row of rows) {
    const title =
      /<a[^>]+href="[^"]*\/view\/[^"]*"[^>]*title="([^"]+)"/i.exec(row)?.[1] ||
      /<a[^>]+href="[^"]*\/view\/[^"]*"[^>]*>([^<]+)</i.exec(row)?.[1] ||
      ''
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    )
    const seeders = Number(String(tds[tds.length - 3] || '').replace(/,/g, '')) || 0
    const hevc = /\b(x265|h\.?265|hevc)\b/i.test(title)
    parsed.push({ seeders, hevc, title: title.slice(0, 70) })
  }
  parsed.sort((a, b) => b.seeders - a.seeders)
  console.log('count', parsed.length)
  console.log('top5', parsed.slice(0, 5))
  console.log(
    'seeded',
    parsed.filter((p) => p.seeders > 0).length,
    'hevc',
    parsed.filter((p) => p.hevc).length,
    'avc',
    parsed.filter((p) => !p.hevc).length,
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
