;(async () => {
  for (const url of [
    'https://freemovies.lol/?logo=https://ww1.lat/netmirror/logo.png&blog_name=Netmirror',
    'https://freemovies.lol/',
    'https://freemovies.lol/tv-shows',
    'https://freemovies.lol/tv',
    'https://freemovies.lol/series',
    'https://netmirror-app.pages.dev/',
  ]) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/json',
          Referer: 'https://ww1.surf/netmirror/',
        },
        redirect: 'follow',
      })
      const text = await res.text()
      console.log('\n===', url)
      console.log('status', res.status, 'final', res.url, 'len', text.length)
      console.log('title', text.match(/<title[^>]*>([^<]*)/i)?.[1]?.slice(0, 80))
      const hrefs = [...new Set([...text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]))]
        .filter((h) => /tv|series|show|browse|api|genre/i.test(h))
        .slice(0, 25)
      console.log('hrefs', hrefs)
      const apis = [...new Set([...text.matchAll(/https?:\/\/[^"'\\\s<>]+/g)].map((m) => m[0]))]
        .filter((h) => /api|graphql|cdn|vid|stream/i.test(h))
        .slice(0, 20)
      console.log('apis', apis)
      if (/__NUXT_DATA__|__NEXT_DATA__|window\.__/i.test(text)) console.log('has app data payload')
      const scripts = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 15)
      console.log('scripts', scripts)
    } catch (e) {
      console.log('\n===', url, 'ERR', e.message)
    }
  }
})()
