;(async () => {
  const url = 'https://ww1.surf/netmirror/'
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
    redirect: 'follow',
  })
  console.log('status', res.status, 'final', res.url)
  const html = await res.text()
  console.log('len', html.length)
  console.log('title', html.match(/<title[^>]*>([^<]*)/i)?.[1])
  // links that look like tv/series
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1])
  const interesting = [...new Set(hrefs)].filter((h) =>
    /tv|series|show|browse|genre|netflix|mirror/i.test(h),
  )
  console.log('interesting hrefs', interesting.slice(0, 40))
  // scripts / api hints
  const apis = [...html.matchAll(/https?:\/\/[^"'\\\s]+(?:api|graphql|wefeed)[^"'\\\s]*/gi)].map(
    (m) => m[0],
  )
  console.log('api-ish', [...new Set(apis)].slice(0, 20))
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
  console.log('scripts', scripts.slice(0, 20))
  console.log('snippet', html.slice(0, 1500))
})()
