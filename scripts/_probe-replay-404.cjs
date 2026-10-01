async function t(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' })
  const b = await r.text()
  console.log(
    r.status,
    'ref=' + (headers.Referer || 'none'),
    url.slice(0, 70),
    b.slice(0, 100).replace(/\s+/g, ' '),
  )
  return b
}

async function main() {
  await t('https://livextv.hybrows.workers.dev/replays/watch/rep-manchester-united-vs-brighton-hove-albion-0', {
    'User-Agent': 'Mozilla/5.0',
  })
  await t('https://livextv.hybrows.workers.dev/replays', { 'User-Agent': 'Mozilla/5.0' })

  const html = await t('https://soccerfull.net/play/15734', {
    'User-Agent': 'Mozilla/5.0',
    Referer: 'https://livextv.hybrows.workers.dev/replays',
  })
  const iframe = (html.match(/src="(https?:[^"]+)"/i) || [])[1]
  console.log('nested', iframe)
  if (iframe) {
    await t(iframe, { 'User-Agent': 'Mozilla/5.0' })
    await t(iframe, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://soccerfull.net/' })
    await t(iframe, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://soccerfull.net/play/15734' })
    await t(iframe, {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://livextv.hybrows.workers.dev/',
    })
  }
}

main().catch(console.error)
