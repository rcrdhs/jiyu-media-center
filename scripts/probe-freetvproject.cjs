;(async () => {
  const res = await fetch('https://freetvproject.space/home', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    redirect: 'follow',
  })
  const html = await res.text()
  console.log('status', res.status, 'bytes', html.length)

  const showLinks = [...html.matchAll(/href="(\/[^"]+)"[^>]*>([^<]{2,80})</gi)]
    .filter((m) => /\/(tv|show|series|movie)/i.test(m[1]))
    .slice(0, 8)
  console.log('sample show links:', showLinks.map((m) => ({ path: m[1], title: m[2].trim() })))

  const embedRefs = [...new Set([...html.matchAll(/(vidsrc|embed|2embed|superembed|videasy|player)/gi)].map((m) => m[0].toLowerCase()))]
  console.log('embed keywords:', embedRefs)

  // pick first internal show path
  const first = showLinks.find((m) => m[1].startsWith('/'))?.[1]
  if (!first) return
  const detailUrl = new URL(first, 'https://freetvproject.space').href
  console.log('\nfetching detail', detailUrl)
  const detail = await fetch(detailUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
  }).then((r) => r.text())
  console.log('detail bytes', detail.length)
  const iframes = [...detail.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]).slice(0, 5)
  console.log('iframes', iframes)
  const episodeLinks = [...detail.matchAll(/href="([^"]*(?:season|episode|s\d|e\d)[^"]*)"/gi)]
    .slice(0, 5)
    .map((m) => m[1])
  console.log('episode-ish links', episodeLinks)
})()
