async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://cinetaro.to/watch/97546?tv&s=1&ep=1',
      'X-Requested-With': 'XMLHttpRequest',
    },
  })
  const t = await r.text()
  return { status: r.status, t, ct: r.headers.get('content-type') || '' }
}

async function main() {
  const epId = '97546-1-1'
  const serversUrl = `https://cinetaro.to/src/ajax/anime/server.php?episodeId=${encodeURIComponent(epId)}`
  const servers = await get(serversUrl)
  console.log('SERVERS', servers.status, servers.ct, servers.t.slice(0, 1500))

  let parsed
  try {
    parsed = JSON.parse(servers.t)
  } catch {
    console.log('not json')
    return
  }
  console.log('keys', Object.keys(parsed))
  console.dir(parsed, { depth: 4 })

  const list = []
  for (const [type, arr] of Object.entries(parsed)) {
    if (!Array.isArray(arr)) continue
    for (const s of arr) list.push({ serverType: type, ...s })
  }
  // also common shapes { sub: [], dub: [] } or { servers: [] }
  if (parsed.sub || parsed.dub || parsed.servers) {
    for (const type of ['sub', 'dub', 'raw']) {
      for (const s of parsed[type] || []) list.push({ serverType: type, ...s })
    }
    for (const s of parsed.servers || []) list.push({ serverType: s.type || s.serverType || 'sub', ...s })
  }
  console.log('flat servers', list.slice(0, 20))

  for (const s of list.slice(0, 8)) {
    const type = s.serverType || s.type || 'sub'
    const sid = s.serverId || s.id || s.server
    const url = `https://cinetaro.to/src/player/${type}.php?id=${encodeURIComponent(epId)}&server=${sid}&embed=true&ep=1&autoPlay=1`
    const page = await get(url)
    const iframes = [...page.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
    const redirects = [...page.t.matchAll(/(?:src|location\.href|window\.location)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(
      (m) => m[1],
    )
    const embeds = [...page.t.matchAll(/https?:\/\/[^"'\\\s]+(?:vidsrc|videasy|megacloud|rabbit|cloud|embed)[^"'\\\s]*/gi)].map(
      (m) => m[0],
    )
    console.log('\nPLAY', { type, sid, name: s.serverName || s.name, status: page.status, len: page.t.length })
    console.log({ iframes: iframes.slice(0, 5), redirects: redirects.slice(0, 5), embeds: [...new Set(embeds)].slice(0, 8) })
    console.log('head', page.t.slice(0, 250).replace(/\s+/g, ' '))
  }
}

main().catch(console.error)
