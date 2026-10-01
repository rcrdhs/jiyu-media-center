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
  const part = html.split(/class="[^"]*flw-item[^"]*"/i)[1]
  // film-detail section
  const fd = part.match(/film-detail[\s\S]{0,1200}/i)?.[0]
  console.log(fd?.replace(/\s+/g, ' '))
}

main().catch(console.error)
