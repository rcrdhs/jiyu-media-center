async function get(url, headers = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      Referer: 'https://cinetaro.to/watch/97546?tv&s=1&ep=1',
      'X-Requested-With': 'XMLHttpRequest',
      ...headers,
    },
  })
  const t = await r.text()
  return { status: r.status, t, ct: r.headers.get('content-type') || '' }
}

function snip(hay, needle, n = 2, radius = 280) {
  let from = 0
  for (let i = 0; i < n; i++) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) return
    console.log(`\n[${needle} #${i + 1}]`, hay.slice(Math.max(0, idx - radius), idx + radius).replace(/\s+/g, ' '))
    from = idx + needle.length
  }
}

async function main() {
  const html = await (await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')).t
  // Extract the big inline script that builds player URLs
  const scripts = [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  const playerScript = scripts.find((s) => s.includes('src/player/') && s.includes('serverType'))
  console.log('playerScript len', playerScript ? playerScript.length : 0)
  if (playerScript) {
    snip(playerScript, 'fetch(', 5, 200)
    snip(playerScript, '$.ajax', 5, 200)
    snip(playerScript, '$.get', 5, 200)
    snip(playerScript, '/ajax/', 8, 200)
    snip(playerScript, 'servers', 5, 200)
    snip(playerScript, 'episodeId', 5, 200)
    snip(playerScript, 'data-id', 3, 150)
    // dump function names around load
    const fns = [...playerScript.matchAll(/function\s+(\w+)/g)].map((m) => m[1])
    console.log('fns', fns.slice(0, 40))
  }

  const epId = '97546-1-1'
  const candidates = [
    `https://cinetaro.to/ajax/episode/servers?episodeId=${epId}`,
    `https://cinetaro.to/ajax/servers?id=${epId}`,
    `https://cinetaro.to/ajax/episode/list/${epId}`,
    `https://cinetaro.to/ajax/v2/episode/servers?episodeId=${epId}`,
    `https://cinetaro.to/ajax/v2/episode/sources?id=${epId}`,
    `https://cinetaro.to/ajax/episode/sources?id=${epId}`,
    `https://cinetaro.to/ajax/embed/servers?id=${epId}`,
    `https://cinetaro.to/ajax/movie/episode/servers?episodeId=${epId}`,
    `https://cinetaro.to/src/ajax/episode/servers?id=${epId}`,
    `https://cinetaro.to/ajax/episode/servers/${epId}`,
    `https://cinetaro.to/ajax/get_sources?id=${epId}`,
    `https://cinetaro.to/ajax/getServers?id=${epId}`,
  ]
  for (const url of candidates) {
    try {
      const r = await get(url)
      console.log('\nTRY', url, r.status, r.ct, r.t.slice(0, 180).replace(/\s+/g, ' '))
    } catch (e) {
      console.log('FAIL', url, e.message)
    }
  }

  // Try player with episode-style id
  for (const type of ['sub', 'dub', 'raw', 'hd', 'movie', 'tv', 'tmdb', 'megacloud', 'cloud']) {
    const url = `https://cinetaro.to/src/player/${type}.php?id=${encodeURIComponent(epId)}&server=1&embed=true&ep=1`
    const r = await get(url)
    if (r.status !== 404) {
      const iframes = [...r.t.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1])
      console.log('PLAYER', type, r.status, r.t.length, iframes.slice(0, 3), r.t.slice(0, 160).replace(/\s+/g, ' '))
    }
  }
}

main().catch(console.error)
