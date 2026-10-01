const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function main() {
  const js = await (
    await fetch('https://rivestream.ru/_next/static/chunks/1446-1a6a239c6109bc36.js', {
      headers: { 'User-Agent': UA },
    })
  ).text()

  for (const term of [
    'e_="PRIME"',
    'setSource',
    'source=',
    'F.get(',
    'searchParams',
    'ADF',
    'iframe',
    'embedUrl',
    'playerUrl',
    'getEmbed',
    'vip.tv',
  ]) {
    let from = 0
    let n = 0
    while (n < 2) {
      const i = js.indexOf(term, from)
      if (i < 0) break
      n += 1
      from = i + term.length
      console.log(`\n[${term} #${n}]`, js.slice(Math.max(0, i - 80), i + 200).replace(/\s+/g, ' '))
    }
  }

  // Try opening embed with source query
  for (const q of [
    'https://rivestream.ru/embed?type=tv&id=502&season=1&episode=1&source=ADF',
    'https://rivestream.ru/embed?type=tv&id=502&season=1&episode=1&server=ADF',
    'https://rivestream.ru/embed?type=tv&id=502&season=1&episode=1&provider=ADF',
    'https://rivestream.ru/embed?type=tv&id=502&season=1&episode=1&mode=embed&source=ADF',
  ]) {
    const res = await fetch(q, { headers: { 'User-Agent': UA, Referer: 'https://rivestream.ru/' } })
    const text = await res.text()
    console.log('\nURL', q, 'status', res.status, 'len', text.length)
  }
}

main().catch(console.error)
