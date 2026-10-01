async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
      Referer: 'https://cinetaro.to/watch/97546?tv&s=1&ep=1',
    },
    redirect: 'follow',
  })
  return { status: r.status, t: await r.text() }
}

function extractAround(hay, needle, radius = 400) {
  const i = hay.indexOf(needle)
  if (i < 0) return null
  return hay.slice(Math.max(0, i - radius), i + needle.length + radius)
}

async function main() {
  const watch = await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')
  const t = watch.t
  console.log('len', t.length)

  for (const needle of [
    'src/player/',
    'serverType',
    'encodedId',
    'serverId',
    'servers',
    'embed=true',
    'videasy',
    'vidsrc',
    'ANIME_ID',
    'episodeNumber',
  ]) {
    const snip = extractAround(t, needle, 350)
    if (snip) console.log('\n===', needle, '===\n', snip.replace(/\s+/g, ' ').slice(0, 700))
  }

  const scripts = [...t.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
  console.log('\nSCRIPTS', scripts.slice(0, 50))
  for (const src of scripts) {
    if (!/player|watch|main|app|custom|script|common/i.test(src)) continue
    const url = src.startsWith('http') ? src : `https://cinetaro.to${src.startsWith('/') ? '' : '/'}${src}`
    try {
      const js = await get(url)
      if (/src\/player|serverType|encodedId|videasy|vidsrc|embed=true/i.test(js.t)) {
        console.log('\nHIT JS', url, js.t.length)
        for (const needle of ['src/player/', 'serverType', 'videasy', 'vidsrc', 'encodedId']) {
          const snip = extractAround(js.t, needle, 300)
          if (snip) console.log(needle, '->', snip.replace(/\s+/g, ' ').slice(0, 500))
        }
      }
    } catch (e) {
      console.log('js fail', url, e.message)
    }
  }

  const tries = [
    'https://cinetaro.to/src/player/tv.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/movie.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/tmdb.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/series.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/embed.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/vidsrc.php?id=97546&server=1&embed=true&ep=1',
    'https://cinetaro.to/src/player/videasy.php?id=97546&server=1&embed=true&ep=1',
  ]
  for (const url of tries) {
    try {
      const p = await get(url)
      const iframes = [...p.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
      const loc = p.t.match(/location(?:\.href)?\s*=\s*["']([^"']+)["']/i)?.[1]
      console.log('\nPLAYER TRY', {
        url,
        status: p.status,
        len: p.t.length,
        iframes: iframes.slice(0, 5),
        loc,
        head: p.t.slice(0, 220).replace(/\s+/g, ' '),
      })
    } catch (e) {
      console.log('try fail', url, e.message)
    }
  }
}

main().catch(console.error)
