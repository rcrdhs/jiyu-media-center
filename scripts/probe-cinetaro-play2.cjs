async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      Referer: 'https://cinetaro.to/watch/97546?tv&s=1&ep=1',
    },
  })
  return { status: r.status, t: await r.text() }
}

async function main() {
  const html = (await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')).t
  const scripts = [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  const playerScript = scripts.find((s) => s.includes('createServerButton') && s.includes('src/player/'))
  const i = playerScript.indexOf('function createServerButton')
  console.log(playerScript.slice(i, i + 1800))

  const epId = encodeURIComponent('97546-1-1')
  const tries = [
    `https://cinetaro.to/src/player/sub.php?id=${epId}&server=maple&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/dub.php?id=${epId}&server=maple&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/hardsub.php?id=${epId}&server=maple&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/softsub.php?id=${epId}&server=maple&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/sub.php?id=${epId}&server=Primus&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/maple.php?id=${epId}&server=1&embed=true&ep=1&autoPlay=1`,
    `https://cinetaro.to/src/player/sub.php?id=97546&server=maple&embed=true&ep=1&autoPlay=1`,
  ]
  for (const url of tries) {
    const p = await get(url)
    const iframes = [...p.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
    const srcAssign = [...p.t.matchAll(/(?:iframe\.src|location\.href|\.src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1])
    const embeds = [...p.t.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'\\\s]{0,120}/gi)]
      .map((m) => m[0])
      .filter((u) => /vidsrc|videasy|embed|player|maple|megacloud|rabbitstream|cloudns/i.test(u))
    console.log('\n', url)
    console.log({
      status: p.status,
      len: p.t.length,
      iframes,
      srcAssign: srcAssign.slice(0, 5),
      embeds: [...new Set(embeds)].slice(0, 10),
      head: p.t.slice(0, 300).replace(/\s+/g, ' '),
    })
  }
}

main().catch(console.error)
