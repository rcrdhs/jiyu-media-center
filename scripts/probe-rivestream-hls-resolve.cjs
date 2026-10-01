const SHOWS = [
  { name: 'Game of Thrones', id: 1399 },
  { name: 'Breaking Bad', id: 1396 },
  { name: 'Stranger Things', id: 66732 },
  { name: 'The Office', id: 2316 },
  { name: 'Reacher', id: 108978 },
  { name: 'Arcane', id: 94605 },
  { name: 'One Piece', id: 37854 },
  { name: 'House of the Dragon', id: 94997 },
  { name: 'Shogun 2024', id: 126308 },
  { name: 'Obscure anime', id: 99999 },
]

const PROVIDERS = ['apex', 'pulse', 'solstice', 'quasar', 'horizon', 'primevids', 'flowcast', 'citadel', 'hindicast', 'guru']

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 200) }
  }
}

function extractSources(json) {
  const candidates = [
    json?.data?.sources,
    json?.sources,
    json?.data,
    Array.isArray(json?.data?.data) ? json.data.data : null,
  ].filter(Boolean)
  for (const c of candidates) {
    if (Array.isArray(c)) return c
    if (c?.sources && Array.isArray(c.sources)) return c.sources
    if (typeof c?.url === 'string') return [c]
  }
  return []
}

async function resolveShow(show) {
  for (const provider of PROVIDERS) {
    const url = `https://scrapper.rivestream.app/api/provider?provider=${provider}&id=${show.id}&season=1&episode=1`
    const r = await get(url)
    if (r.status >= 400 || !r.json) continue
    const sources = extractSources(r.json)
    const hls = sources.find((s) => s?.format === 'hls' || /\.m3u8/i.test(s?.url || ''))
    if (hls?.url) {
      return { provider, quality: hls.quality, format: hls.format, url: hls.url.slice(0, 220) }
    }
  }
  return null
}

async function testPlayable(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  const text = await r.text()
  return {
    status: r.status,
    isM3u8: text.includes('#EXTM3U') || text.includes('#EXT-X-'),
    sample: text.slice(0, 120),
  }
}

async function main() {
  const results = []
  for (const show of SHOWS) {
    const hit = await resolveShow(show)
    let playable = null
    if (hit?.url) playable = await testPlayable(hit.url)
    results.push({ show: show.name, id: show.id, hit, playable })
    console.log(JSON.stringify({ show: show.name, hit, playable }))
  }
  const ok = results.filter((r) => r.hit)
  const playable = results.filter((r) => r.playable?.isM3u8)
  console.log(`\nResolved HLS: ${ok.length}/${SHOWS.length}`)
  console.log(`Playable manifest: ${playable.length}/${SHOWS.length}`)
}

main().catch(console.error)
