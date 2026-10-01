async function main() {
  const t = await fetch('https://rivestream.ru/_next/static/chunks/pages/_app-0571386f4923efe0.js').then((r) => r.text())
  for (const term of [
    'scrapper.rivestream',
    'backend.rivestream',
    'nonEmbed',
    'directSources',
    'getSources',
    'stream/tv',
    '/tv/',
    'requestID=',
    'NEXT_PUBLIC_EXTERNAL',
    'EXTERNAL_PROVIDER',
  ]) {
    let idx = 0
    let n = 0
    while ((idx = t.indexOf(term, idx)) >= 0 && n < 4) {
      console.log('\n', term, n, t.slice(Math.max(0, idx - 60), idx + 280).replace(/\s+/g, ' '))
      idx += term.length
      n++
    }
  }
}

main().catch(console.error)
