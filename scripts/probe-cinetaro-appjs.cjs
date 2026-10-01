async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://cinetaro.to/',
    },
  })
  return r.text()
}

function snippets(hay, needles, radius = 250) {
  for (const needle of needles) {
    let from = 0
    let n = 0
    while (n < 4) {
      const i = hay.indexOf(needle, from)
      if (i < 0) break
      console.log(`\n--- ${needle} #${n + 1} ---\n`, hay.slice(Math.max(0, i - radius), i + radius).replace(/\s+/g, ' '))
      from = i + needle.length
      n += 1
    }
  }
}

async function main() {
  const js = await get('https://cinetaro.to/src/assets/js/app.js?v=1.0')
  console.log('app.js', js.length)
  snippets(js, [
    'src/player/',
    'serverType',
    'loadServer',
    'servers-content',
    '/ajax/',
    'megacloud',
    'videasy',
    'vidsrc',
    'currentEpisodeId',
    'episodeId',
    'getEpisode',
  ])

  // Also scrape watch HTML for server buttons / data attributes
  const html = await get('https://cinetaro.to/watch/97546?tv&s=1&ep=1')
  const serverButtons = [...html.matchAll(/data-server[^>]{0,200}/gi)].slice(0, 20)
  console.log('\nSERVER BUTTON ATTRS', serverButtons)
  const epItems = [...html.matchAll(/class="[^"]*ep-item[^"]*"[^>]{0,300}/gi)].slice(0, 10)
  console.log('\nEP ITEMS', epItems.map((m) => m[0]))
  const ajaxUrls = [...html.matchAll(/["'`](\/ajax\/[^"'`]+)["'`]/g)].map((m) => m[1])
  console.log('\nAJAX IN HTML', [...new Set(ajaxUrls)].slice(0, 30))
  const ajaxInJs = [...js.matchAll(/["'`](\/ajax\/[^"'`]+)["'`]/g)].map((m) => m[1])
  console.log('\nAJAX IN APP.JS', [...new Set(ajaxInJs)].slice(0, 40))
}

main().catch(console.error)
