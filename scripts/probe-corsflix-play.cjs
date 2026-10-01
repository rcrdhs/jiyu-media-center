async function main() {
  const urls = [
    'https://watch.corsflix.net/tv/1399-game-of-thrones/watch',
    'https://watch.corsflix.net/tv/1399-game-of-thrones/season/1/episode/1',
    'https://watch.corsflix.net/watch/tv/1399-game-of-thrones/1/1',
    'https://watch.corsflix.net/tv/1399-game-of-thrones/1/1',
  ]
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual',
    })
    console.log(res.status, res.headers.get('location') || '', url)
    if (res.status === 200) {
      const h = await res.text()
      const embeds = [...h.matchAll(/embed|iframe|m3u8|\.mp4|vidlink|vidsrc|superembed|player/gi)].length
      console.log('  len', h.length, 'media hints', embeds)
    }
  }
}

main().catch(console.error)
