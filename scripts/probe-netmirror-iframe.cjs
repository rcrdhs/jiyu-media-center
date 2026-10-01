;(async () => {
  const html = await fetch('https://ww1.surf/netmirror/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const iframes = [...html.matchAll(/iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1])
  console.log('iframes', iframes)
  const allHttp = [...new Set([...html.matchAll(/https?:\/\/[^"'\s<>]+/g)].map((m) => m[0]))]
  console.log('all http', allHttp)
  console.log('tail\n', html.slice(-2500))
})()
