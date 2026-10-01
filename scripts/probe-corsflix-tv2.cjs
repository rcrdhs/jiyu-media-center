async function main() {
  const html = await fetch('https://watch.corsflix.net/tv', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    },
  }).then((r) => r.text())

  const tvPaths = new Set()
  for (const m of html.matchAll(/href=\"(\/tv\/[^\"?#]+)\"/g)) tvPaths.add(m[1])
  for (const m of html.matchAll(/\"(\/tv\/[^\"?#]+)\"/g)) tvPaths.add(m[1])

  console.log('unique /tv/ paths in HTML', tvPaths.size)

  const nextData = html.match(/<script id=\"__NEXT_DATA__\"[^>]*>([\s\S]*?)<\/script>/)
  if (nextData) {
    const data = JSON.parse(nextData[1])
    console.log('__NEXT_DATA__ keys', Object.keys(data))
    const pageProps = data.props?.pageProps
    console.log('pageProps keys', pageProps ? Object.keys(pageProps) : null)
    const json = JSON.stringify(pageProps)
    const idMatches = json.match(/\"id\":\d+/g)
    console.log('id fields in pageProps', idMatches ? idMatches.length : 0)
    // look for total_pages or total_results
    const total = json.match(/total_(pages|results)\"?\s*:\s*\d+/gi)
    console.log('totals', total?.slice(0, 20))
  } else {
    console.log('no __NEXT_DATA__')
  }

  // count genre shelf sections
  const h2 = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gi)].map((m) => m[1].trim())
  console.log('h2 sections', h2.length, h2.slice(0, 15))
}

main().catch(console.error)
