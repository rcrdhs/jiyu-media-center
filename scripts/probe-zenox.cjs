const fs = require('fs')

async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html',
  }
  const html = await (await fetch('https://zenox.lol/tv', { headers })).text()
  fs.writeFileSync('scripts/zenox-tv.html', html)

  const scripts = [...html.matchAll(/src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => /_next|chunk|app/i.test(s))
  const buildId =
    (html.match(/"buildId":"([^"]+)/) || html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\//) || [])[1]
  const hrefs = [...html.matchAll(/href="(\/(?:tv|show|series|watch|title|movie)\/[^"]+)"/g)].map(
    (m) => m[1],
  )
  const allHrefs = [...html.matchAll(/href="(\/[^"]+)"/g)].map((m) => m[1])
  const uniquePaths = [...new Set(allHrefs)].filter((h) => !h.startsWith('/_next')).slice(0, 80)
  const dataUrls = [...html.matchAll(/https?:\/\/[^"'\s]+/g)]
    .map((m) => m[0])
    .filter((u) => /api|tmdb|image|cdn|vid|stream/i.test(u))
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  const rsc = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/g)].slice(0, 5)

  // Look for embedded JSON with titles/ids
  const idHits = [...html.matchAll(/"id"\s*:\s*(\d{3,8})/g)].map((m) => m[1]).slice(0, 40)
  const tmdbHits = [...html.matchAll(/tmdb[^0-9]*(\d{3,8})/gi)].map((m) => m[1]).slice(0, 40)
  const slugHits = [...html.matchAll(/\/(?:tv|show|series|title)\/([a-z0-9-]+)/gi)]
    .map((m) => m[0])
    .slice(0, 40)

  console.log(
    JSON.stringify(
      {
        len: html.length,
        buildId,
        scripts: [...new Set(scripts)].slice(0, 40),
        hrefs: [...new Set(hrefs)].slice(0, 30),
        uniquePaths,
        hasNextData: Boolean(nd),
        nextDataLen: nd ? nd[1].length : 0,
        rscPushes: rsc.length,
        dataUrls: [...new Set(dataUrls)].slice(0, 40),
        idHits: [...new Set(idHits)].slice(0, 30),
        tmdbHits: [...new Set(tmdbHits)].slice(0, 30),
        slugHits: [...new Set(slugHits)].slice(0, 30),
      },
      null,
      2,
    ),
  )
  if (nd) fs.writeFileSync('scripts/zenox-next-data.json', nd[1])

  // Try common API endpoints
  const tries = [
    '/api/tv',
    '/api/shows',
    '/api/catalog/tv',
    '/api/tmdb/tv/popular',
    '/tv.json',
    '/api/browse?type=tv',
    '/api/media?type=tv&page=1',
    '/_next/data/' + (buildId || 'x') + '/tv.json',
  ]
  for (const path of tries) {
    try {
      const r = await fetch('https://zenox.lol' + path, {
        headers: { ...headers, Accept: 'application/json,text/html' },
        redirect: 'follow',
      })
      const ct = r.headers.get('content-type') || ''
      const t = await r.text()
      console.log(
        JSON.stringify({
          path,
          status: r.status,
          ct,
          len: t.length,
          sample: t.slice(0, 160).replace(/\s+/g, ' '),
        }),
      )
    } catch (e) {
      console.log(JSON.stringify({ path, error: e.message }))
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
