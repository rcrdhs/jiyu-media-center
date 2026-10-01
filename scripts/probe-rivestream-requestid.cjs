async function main() {
  const files = [
    'pages/_app-0571386f4923efe0.js',
    '823c5380-1dfb1d3849cbbdbc.js',
    '1446-e920d125df04a54a.js',
  ]
  for (const file of files) {
    const t = await fetch(`https://rivestream.ru/_next/static/chunks/${file}`).then((r) => r.text())
    console.log(`\n=== ${file} ===`)
    for (const term of ['requestID', 'tvData', 'tvEpisodes', 'nonEmbed', 'directSources', 'getDirect', 'scrapper', 'bff.']) {
      let idx = 0
      let n = 0
      while ((idx = t.indexOf(term, idx)) >= 0 && n < 3) {
        console.log(term, n, t.slice(Math.max(0, idx - 80), idx + 220).replace(/\s+/g, ' '))
        idx += term.length
        n++
      }
    }
  }
}

main().catch(console.error)
