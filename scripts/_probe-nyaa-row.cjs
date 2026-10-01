;(async () => {
  const html = await (
    await fetch('https://nyaa.si/?f=0&c=1_2&q=eternal+supreme&s=seeders&o=desc')
  ).text()
  const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((m) => m[0])
    .filter((r) => /magnet:/i.test(r))
  console.log('rows', rows.length)
  console.log(rows[0].slice(0, 1400).replace(/\s+/g, ' '))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
