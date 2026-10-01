;(async () => {
  const urls = ['https://subsplease.org/shows/', 'https://subsplease.org/']
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        redirect: 'follow',
      })
      const t = await r.text()
      console.log({
        url: u,
        status: r.status,
        final: r.url,
        len: t.length,
        cf: /just a moment|cf-browser-verification|challenge-platform/i.test(t),
        title: (t.match(/<title>([^<]*)/i) || [])[1],
      })
    } catch (e) {
      console.log({
        url: u,
        err: e.message,
        code: e.cause?.code,
        cause: String(e.cause || ''),
      })
    }
  }

  // DNS
  const dns = require('dns').promises
  try {
    console.log('dns', await dns.lookup('subsplease.org', { all: true }))
  } catch (e) {
    console.log('dns err', e.code, e.message)
  }
})()
