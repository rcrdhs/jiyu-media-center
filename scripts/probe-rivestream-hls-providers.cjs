const SHOWS = [
  { name: 'Game of Thrones', id: 1399 },
  { name: 'Obscure anime', id: 99999 },
  { name: 'Old niche', id: 66203 },
]

const PROVIDERS = ['apex', 'pulse', 'solstice', 'quasar', 'horizon', 'primevids', 'flowcast', 'citadel', 'hindicast', 'guru']

async function providerCall(provider, id) {
  const url = `https://scrapper.rivestream.app/api/provider?provider=${provider}&id=${id}&season=1&episode=1`
  const res = await fetch(url, {
    headers: {
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
      Accept: 'application/json',
    },
  })
  const json = await res.json().catch(() => null)
  const sources = json?.data?.sources || json?.sources || []
  const hls = sources.find((s) => s?.format === 'hls' || /\.m3u8/i.test(s?.url || ''))
  return { provider, status: res.status, hls: hls?.url?.slice(0, 180), error: json?.data?.error || json?.error }
}

async function testManifest(url, label) {
  const attempts = [
    { label: 'plain', headers: {} },
    {
      label: 'rivestream',
      headers: { Origin: 'https://rivestream.ru', Referer: 'https://rivestream.ru/' },
    },
    {
      label: 'nextgen',
      headers: {
        Origin: 'https://nextgencloudfabric.com',
        Referer: 'https://nextgencloudfabric.com/',
      },
    },
  ]
  for (const a of attempts) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...a.headers } })
    const text = await res.text()
    console.log(`  ${label}/${a.label}:`, res.status, text.includes('#EXTM3U') ? 'M3U8 OK' : text.slice(0, 60))
  }
}

async function main() {
  for (const show of SHOWS) {
    console.log(`\n=== ${show.name} (${show.id}) ===`)
    for (const p of PROVIDERS) {
      const r = await providerCall(p, show.id)
      console.log(p, r.status, r.hls ? 'HLS' : r.error || 'no-hls')
    }
    const apex = await providerCall('apex', show.id)
    if (apex.hls) await testManifest(apex.hls, show.name)
  }
}

main().catch(console.error)
