async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
  return r.text()
}

function titles(html) {
  return html
    .split(/class="[^"]*flw-item[^"]*"/i)
    .slice(1)
    .map((p) => p.match(/data-title="([^"]+)"/i)?.[1] || '')
    .filter(Boolean)
}

async function main() {
  for (const page of [1, 2, 50]) {
    const html = await get(`https://cinetaro.to/movie/tv-series?page=${page}`)
    const t = titles(html)
    console.log(`page ${page}: ${t.length} titles`)
    console.log('  ', t.slice(0, 8).join(' · '))
  }
}

main().catch(console.error)
