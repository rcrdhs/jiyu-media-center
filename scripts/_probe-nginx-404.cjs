async function sniff(url, referer) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  }
  if (referer) headers.Referer = referer
  const r = await fetch(url, { headers, redirect: 'follow' })
  const b = await r.text()
  const nginx = /<hr>|nginx/i.test(b) && /404/i.test(b)
  console.log(r.status, nginx ? 'NGINX404' : 'other', url.slice(0, 90))
  if (nginx || r.status === 404) console.log(' ', b.slice(0, 120).replace(/\s+/g, ' '))
}

async function main() {
  const pages = [
    'https://soccerfull.net/play/15734',
    'https://soccerfull.net/play/15471',
    'https://soccerfull.net/play/14985',
    'https://app.videas.fr/embed/media/98bb3ce7-17e1-4012-8068-77452f6d8d30/?title=fa',
    'https://bysefujedu.com/d/v4kc5zppy3vy',
  ]
  for (const u of pages) {
    await sniff(u, 'https://livextv.hybrows.workers.dev/replays')
    await sniff(u, null)
  }

  // Parse soccerfull page for iframe / m3u8
  for (const id of [15734, 15471, 15443, 14985]) {
    const html = await (
      await fetch(`https://soccerfull.net/play/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://soccerfull.net/' },
      })
    ).text()
    const iframe = [...html.matchAll(/src=["']([^"']+)["']/gi)].map((m) => m[1])
    const m3u = html.match(/https?:[^"'\\\s]+\.m3u8[^"'\\\s]*/gi) || []
    console.log('\nplay', id, 'iframes', iframe, 'm3u', m3u.slice(0, 3), 'len', html.length)
  }
}

main().catch(console.error)
