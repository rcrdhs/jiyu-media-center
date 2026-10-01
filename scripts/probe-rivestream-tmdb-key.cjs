async function main() {
  const js = await fetch('https://rivestream.ru/_next/static/chunks/pages/_app-0571386f4923efe0.js').then((r) =>
    r.text(),
  )
  const apiKeyMatch = js.match(/api_key[=:][\"']([a-f0-9]{32})[\"']/i) || js.match(/([a-f0-9]{32})/)
  console.log('possible key', apiKeyMatch?.[1] || apiKeyMatch?.[0])

  // Find TMDB fetch patterns
  for (const m of js.matchAll(/discover\/tv\?[^\"']{0,200}/g)) {
    console.log('discover', m[0])
  }
  for (const m of js.matchAll(/api\.themoviedb\.org\/3[^\"']{0,120}/g)) {
    console.log('tmdb path', m[0])
  }

  // Extract key from bearer or api_key param in bundle
  for (const m of js.matchAll(/api_key[^\"']{0,60}/g)) {
    console.log('key ctx', m[0])
  }

  const keyCandidates = [...js.matchAll(/[a-f0-9]{32}/g)].map((m) => m[0])
  const uniq = [...new Set(keyCandidates)]
  console.log('32-char hex strings', uniq.length, uniq.slice(0, 5))

  for (const key of uniq.slice(0, 3)) {
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${key}&language=en-US&sort_by=popularity.desc&page=1`
    const res = await fetch(url)
    const json = await res.json().catch(() => null)
    console.log('try key', key.slice(0, 8), res.status, json?.total_results, json?.status_message)
  }
}

main().catch(console.error)
