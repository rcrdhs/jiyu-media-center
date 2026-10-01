async function check(url, referer) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  }
  if (referer) headers.Referer = referer
  const r = await fetch(url, { headers, redirect: 'manual' })
  const b = await r.text()
  const is404 = r.status === 404 || /404 Not Found/i.test(b)
  console.log(
    (is404 ? 'FAIL' : 'ok'),
    r.status,
    url.slice(0, 80),
    is404 ? b.slice(0, 60).replace(/\s+/g, ' ') : '',
  )
}

async function main() {
  const j = await (
    await fetch('https://livextv-backend.onrender.com/api/replays')
  ).json()
  const now = Date.now()
  const rows = (j.data || [])
    .filter((x) => /football|motor/i.test(x.category || ''))
    .filter((x) => {
      const age = now - (x.date || 0)
      return age >= -6 * 3600e3 && age <= 3 * 864e5
    })
    .slice(0, 8)

  for (const row of rows) {
    console.log('\n==', row.title, row.id)
    for (const s of row.servers || []) {
      await check(s.url, 'https://livextv.hybrows.workers.dev/replays')
      if (/soccerfull/i.test(s.url)) {
        const html = await (
          await fetch(s.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0',
              Referer: 'https://livextv.hybrows.workers.dev/replays',
            },
          })
        ).text()
        const iframe = (html.match(/src="(https?:[^"]+)"/i) || [])[1]
        if (iframe) await check(iframe, s.url)
      }
    }
  }
}

main().catch(console.error)
