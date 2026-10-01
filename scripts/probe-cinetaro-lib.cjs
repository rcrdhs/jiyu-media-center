/**
 * Standalone smoke test for Cinetaro list → servers → cinextream embed.
 * Mirrors src/lib/cinetaro.ts without Electron.
 */
async function get(url, referer = 'https://cinetaro.to/') {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      Referer: referer,
    },
  })
  return { status: r.status, t: await r.text() }
}

function parseList(html) {
  const links = []
  const parts = html.split(/class="[^"]*flw-item[^"]*"/i).slice(1)
  for (const part of parts) {
    const href = part.match(/href="(\/details\/(\d+)\?tv)"/i)
    if (!href) continue
    const title =
      part.match(/data-title="([^"]+)"/i)?.[1] ||
      part.match(/class="[^"]*film-name[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]?.replace(/<[^>]+>/g, '') ||
      ''
    const poster =
      part.match(/data-src="(https?:\/\/[^"]+)"/i)?.[1] ||
      part.match(/src="(https?:\/\/image\.tmdb\.org[^"]+)"/i)?.[1]
    links.push({ tmdbId: href[2], title: title.trim(), poster, url: `https://cinetaro.to${href[1]}` })
  }
  return links
}

async function main() {
  const list = await get('https://cinetaro.to/movie/tv-series?page=1')
  const links = parseList(list.t)
  console.log('LIST', list.status, 'titles', links.length)
  console.log(
    'sample',
    links.slice(0, 3).map((l) => ({ id: l.tmdbId, title: l.title })),
  )
  if (!links[0]) throw new Error('no list titles')

  const pick = links.find((l) => l.tmdbId === '97546') || links[0]
  const season = 1
  const episode = 1
  const epId = `${pick.tmdbId}-${season}-${episode}`
  console.log('PICK', pick.title, epId)

  const servers = await get(
    `https://cinetaro.to/src/ajax/anime/server.php?episodeId=${encodeURIComponent(epId)}`,
  )
  console.log('SERVERS', servers.status, servers.t.slice(0, 280))

  const player = await get(
    `https://cinetaro.to/src/player/sub.php?id=${encodeURIComponent(epId)}&server=maple&embed=true&ep=${episode}&autoPlay=1`,
    `https://cinetaro.to/watch/${pick.tmdbId}?tv&s=${season}&ep=${episode}`,
  )
  const iframe = player.t.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&')
  console.log('PLAYER', player.status, iframe || player.t.slice(0, 120).replace(/\s+/g, ' '))

  const embed =
    iframe ||
    `https://cinextream.cc/api/embed/tv/${pick.tmdbId}/${season}/${episode}?noads=0&autoPlay=1&autoplay=true&asi=0`
  const emb = await get(embed, 'https://cinetaro.to/')
  console.log('EMBED', emb.status, emb.t.length, /player\.js/i.test(emb.t) ? 'has player.js' : 'no player.js')
  console.log('OK list→servers→player→cinextream')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
