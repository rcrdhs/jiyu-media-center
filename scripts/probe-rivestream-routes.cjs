async function main() {
  const js = await fetch('https://rivestream.ru/_next/static/chunks/pages/_app-0571386f4923efe0.js').then((r) =>
    r.text(),
  )
  for (const term of ['/info/', '/watch/', '"/tv/', '/login', '/embed?']) {
    const matches = [...js.matchAll(new RegExp(term.replace('/', '\\/') + '[^"\']{0,80}', 'g'))]
    if (matches.length) {
      console.log(term, [...new Set(matches.map((m) => m[0]))].slice(0, 10))
    }
  }
}

main().catch(console.error)
