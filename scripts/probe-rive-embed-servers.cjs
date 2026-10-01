const REF = 'https://rivestream.ru/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://rivestream.ru',
      Referer: REF,
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 800) }
}

async function main() {
  for (const path of [
    'https://scrapper.rivestream.app/api/embeds',
    'https://scrapper.rivestream.app/api/providers',
    'https://scrapper.rivestream.app/api/embed?id=502&season=1&episode=1',
    'https://scrapper.rivestream.app/api/embeds?id=502&season=1&episode=1&type=tv',
    'https://scrapper.rivestream.app/api/embed/tv?id=502&season=1&episode=1',
    'https://bff.rivestream.ru/api/embeds',
    'https://rivestream.ru/api/embeds',
  ]) {
    try {
      const r = await get(path)
      console.log('\n===', path, '===')
      console.log('status', r.status)
      console.log(JSON.stringify(r.json || r.text).slice(0, 1000))
    } catch (e) {
      console.log('\n===', path, 'ERR', e.message)
    }
  }

  const html = await (
    await fetch('https://rivestream.ru/embed?type=tv&id=502&season=1&episode=1', {
      headers: { 'User-Agent': UA, Referer: REF },
    })
  ).text()
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /\.js/i.test(s))
  console.log('\nscripts', scripts.slice(0, 20))
  const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (next) console.log('NEXT', next[1].slice(0, 2000))

  // Pull a few JS chunks and search for Fast-Server / server query keys
  for (const src of scripts.slice(0, 8)) {
    const url = src.startsWith('http') ? src : `https://rivestream.ru${src}`
    try {
      const js = await (await fetch(url, { headers: { 'User-Agent': UA } })).text()
      for (const term of [
        'Fast-Server',
        'fast-server',
        'Single-Serve',
        'server=',
        'servers',
        'embedMode',
        'nonEmbed',
        'provider=',
      ]) {
        if (js.includes(term)) {
          const idx = js.indexOf(term)
          console.log('\nHIT', term, 'in', url.slice(-60), js.slice(Math.max(0, idx - 80), idx + 120).replace(/\n/g, ' '))
        }
      }
    } catch (e) {
      console.log('js fail', url, e.message)
    }
  }
}

main().catch(console.error)
