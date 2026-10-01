const fs = require('fs')

async function main() {
  const api = await (
    await fetch('https://api.ppv.st/api/streams', {
      headers: { Accept: 'application/json', Referer: 'https://ppv.st/' },
    })
  ).json()
  const now = Math.floor(Date.now() / 1000)
  let pick = null
  for (const cat of api.streams || []) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      if (/Astros|Phillies|Guardians|Orioles/i.test(s.name)) {
        pick = s
        break
      }
    }
    if (pick) break
  }
  if (!pick) {
    console.log('no pick')
    return
  }
  console.log('pick', pick.name)

  // Use electron-less: just note page fetch
  const page = `https://ppv.st/live/${pick.uri_name}`
  const pageRes = await fetch(page, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      Referer: 'https://ppv.st/',
    },
  })
  const pageHtml = await pageRes.text()
  console.log('page', pageRes.status, pageHtml.length, (pageHtml.match(/<title>([^<]*)/i) || [])[1])

  // Fetch a recent m3u8 from probe log if present - otherwise resolve via opening isn't possible here.
  // Instead POST-like /fetch isn't usable without wasm. Decode playlist from known working pattern:
  // After electron probe we know host. Let's get fresh by scraping Network Persistent... skip.

  // Compare: open embed and search for playlist URLs encoded in page config
  const emb = await fetch(pick.iframe, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      Referer: 'https://ppv.st/',
    },
  })
  const html = await emb.text()
  fs.writeFileSync('D:/app/scripts/ppv-embed-sample.html', html.slice(0, 200000))
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0])
  const interesting = [...new Set(urls)].filter((u) =>
    /indian|nresystems|m3u8|cdn|stream|secure|api\./i.test(u),
  )
  console.log('interesting urls', interesting.slice(0, 30))

  // Look for base64-ish tokens
  const b64 = [...html.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)].map((m) => m[0]).slice(0, 5)
  console.log('b64 samples', b64.map((s) => s.slice(0, 60)))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
