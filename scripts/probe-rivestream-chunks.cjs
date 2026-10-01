async function scan(file) {
  const h = await fetch(`https://rivestream.ru/_next/static/chunks/${file}`).then((r) => r.text())
  const urls = [...new Set([...h.matchAll(/https:\/\/[^"'\\]+/g)].map((m) => m[0]))]
  console.log('\n', file, 'urls', urls)
  for (const term of [
    'backend.rivestream',
    'scrapper.rivestream',
    'm3u8-proxy',
    '/sources',
    'signIn',
    'login',
    'streamed.pk',
    '1shows',
    'valhallastream',
    'nonEmbedSources',
  ]) {
    const i = h.indexOf(term)
    if (i >= 0) console.log(term, h.slice(Math.max(0, i - 40), i + 140))
  }
}

async function main() {
  for (const file of [
    '7300-4265723c6b372545.js',
    '1446-e920d125df04a54a.js',
    '2751-11dbb3731c0eb357.js',
  ]) {
    await scan(file)
  }
}

main().catch(console.error)
