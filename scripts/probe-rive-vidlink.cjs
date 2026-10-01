const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function main() {
  const js = await (
    await fetch('https://rivestream.ru/_next/static/chunks/1446-1a6a239c6109bc36.js', {
      headers: { 'User-Agent': UA },
    })
  ).text()

  // Find all F.get usages
  let from = 0
  let n = 0
  while (n < 20) {
    const i = js.indexOf('F.get(', from)
    if (i < 0) break
    n += 1
    from = i + 6
    console.log(n, js.slice(i, i + 40))
  }

  // Find vidlink / server iframe map
  const idx = js.indexOf('tI="https://vidlink.pro"')
  console.log('\n=== host map ===\n', js.slice(idx - 400, idx + 800))

  // Find onServerError rotation
  const idx2 = js.indexOf('onServerError')
  console.log('\n=== onServerError area ===\n', js.slice(idx2 - 50, idx2 + 600))

  // Find where e_ (source) is initialized / changed on error
  const idx3 = js.indexOf('eV(e=>[]),eO("")')
  console.log('\n=== init effect ===\n', js.slice(idx3, idx3 + 400))

  // Try vidlink directly
  const vid = 'https://vidlink.pro/tv/502/1/1'
  const res = await fetch(vid, {
    headers: { 'User-Agent': UA, Referer: 'https://rivestream.ru/' },
    redirect: 'follow',
  })
  const text = await res.text()
  console.log('\nvidlink', res.status, res.url, text.slice(0, 400).replace(/\s+/g, ' '))
}

main().catch(console.error)
