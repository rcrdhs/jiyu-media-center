;(async () => {
  const url =
    'https://nyaa.si/?f=0&c=1_2&q=The+Eternal+Supreme&s=seeders&o=desc'
  const html = await (await fetch(url)).text()
  const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((m) => m[0])
    .filter((r) => /magnet:\?/i.test(r))
  const keys = new Set()
  for (const row of rows) {
    const title = /title="([^"]*Eternal[^"]*)"/i.exec(row)?.[1] || ''
    const ep = /\bS(\d{1,2})E(\d{1,3})\b/i.exec(title)
    if (ep) keys.add(`S${ep[1].padStart(2, '0')}E${ep[2].padStart(2, '0')}`)
  }
  console.log('rows', rows.length)
  console.log('episodes', [...keys].sort().join(', '))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
