async function main() {
  const js = await fetch('https://rivestream.ru/_next/static/chunks/pages/_app-0571386f4923efe0.js').then((r) =>
    r.text(),
  )
  const patterns = [
    /https:\/\/[^\"']+/g,
    /discover\/tv[^\"']{0,120}/g,
    /bff\.rivestream[^\"']{0,120}/g,
    /api\.themoviedb[^\"']{0,80}/g,
    /total_results[^\"']{0,40}/g,
    /embed\?type=[^\"']{0,80}/g,
    /\/watch\/[^\"']{0,80}/g,
    /signIn[^\"']{0,80}/g,
  ]
  for (const re of patterns) {
    const hits = [...new Set([...js.matchAll(re)].map((m) => m[0]))].slice(0, 20)
    if (hits.length) {
      console.log('\n', re, '=>')
      hits.forEach((h) => console.log(' ', h))
    }
  }
}

main().catch(console.error)
