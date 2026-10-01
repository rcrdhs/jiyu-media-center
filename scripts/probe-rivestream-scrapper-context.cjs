async function main() {
  const t = await fetch('https://rivestream.ru/_next/static/chunks/pages/_app-0571386f4923efe0.js').then((r) => r.text())
  const idx = t.indexOf('scrapper.rivestream.app')
  let start = Math.max(0, idx - 500)
  let end = Math.min(t.length, idx + 8000)
  console.log(t.slice(start, end))
}

main().catch(console.error)
