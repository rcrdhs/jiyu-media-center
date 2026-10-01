async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html',
      Referer: 'https://cinetaro.to/',
    },
  })
  return r.text()
}

async function main() {
  const html = await get('https://cinetaro.to/movie/tv-series?page=1')
  const parts = html.split(/class="[^"]*flw-item[^"]*"/i).slice(1)
  console.log('flw parts', parts.length)
  console.log(parts[0].slice(0, 900).replace(/\s+/g, ' '))
  console.log('---')
  console.log(parts[1]?.slice(0, 900).replace(/\s+/g, ' '))

  // Try parse
  const links = []
  for (const part of parts) {
    const href = part.match(/href="(\/details\/(\d+)\?tv)"/i)
    const title =
      part.match(/class="[^"]*film-name[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      part.match(/title="([^"]+)"/i)?.[1] ||
      ''
    const poster =
      part.match(/data-src="(https?:\/\/[^"]+)"/i)?.[1] ||
      part.match(/src="(https?:\/\/image\.tmdb\.org[^"]+)"/i)?.[1] ||
      ''
    const year = part.match(/(\d{4})/)?.[1]
    if (href) {
      links.push({
        id: href[2],
        title: title.replace(/<[^>]+>/g, '').trim(),
        poster,
        year,
      })
    }
  }
  console.log('parsed', links.length, links.slice(0, 5))
}

main().catch(console.error)
