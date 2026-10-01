const SHOWS = [
  { name: 'Game of Thrones', id: 1399 },
  { name: 'Breaking Bad', id: 1396 },
  { name: 'Stranger Things', id: 66732 },
  { name: 'The Office', id: 2316 },
  { name: 'Reacher', id: 108978 },
  { name: 'Arcane', id: 94605 },
  { name: 'One Piece', id: 37854 },
  { name: 'House of the Dragon', id: 94997 },
]

const PROXY = 'https://proxy.valhallastream.dpdns.org/m3u8-proxy?url='

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text: text.slice(0, 500) }
}

function summarizeSource(data) {
  if (!data) return null
  if (typeof data === 'string') {
    return { type: data.includes('.m3u8') ? 'm3u8' : 'string', url: data.slice(0, 180) }
  }
  const url = data.url || data.link || data.file || data.source || data.stream
  const format = data.format || data.type
  return {
    format,
    url: typeof url === 'string' ? url.slice(0, 180) : undefined,
    keys: typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    quality: data.quality,
    source: data.source || data.label || data.server,
  }
}

async function main() {
  console.log('=== Provider list ===')
  const providers = await get('https://scrapper.rivestream.app/api/providers')
  console.log('status', providers.status)
  if (providers.json) {
    const list = Array.isArray(providers.json) ? providers.json : providers.json.providers || providers.json.data
    console.log('count', list?.length)
    console.log('sample', JSON.stringify(list?.slice?.(0, 8) || providers.json).slice(0, 800))
  } else {
    console.log(providers.text)
  }

  console.log('\n=== Embed provider list ===')
  const embeds = await get('https://scrapper.rivestream.app/api/embeds')
  console.log('status', embeds.status)
  if (embeds.json) {
    const list = Array.isArray(embeds.json) ? embeds.json : embeds.json.providers || embeds.json.data
    console.log('count', list?.length)
    console.log('sample', JSON.stringify(list?.slice?.(0, 8) || embeds.json).slice(0, 800))
  } else {
    console.log(embeds.text)
  }

  const providerNames = []
  if (providers.json) {
    const list = Array.isArray(providers.json) ? providers.json : providers.json.providers || providers.json.data
    if (Array.isArray(list)) {
      for (const p of list) {
        const name = typeof p === 'string' ? p : p.id || p.provider || p.name
        if (name) providerNames.push(name)
      }
    }
  }

  console.log('\nprovider names', providerNames.slice(0, 20))

  console.log('\n=== Per-show HLS resolution ===')
  const results = []
  for (const show of SHOWS) {
    const entry = { show: show.name, id: show.id, providers: [], firstM3u8: null, errors: [] }
    for (const provider of providerNames.slice(0, 12)) {
      const url = `https://scrapper.rivestream.app/api/provider?provider=${encodeURIComponent(provider)}&id=${show.id}&season=1&episode=1`
      const r = await get(url)
      if (r.status >= 400) {
        entry.errors.push({ provider, status: r.status })
        continue
      }
      const body = r.json ?? r.text
      const sources = Array.isArray(body) ? body : body?.sources || body?.data || body?.streams || [body]
      const flat = (Array.isArray(sources) ? sources : [sources]).filter(Boolean)
      for (const s of flat.slice(0, 3)) {
        const sum = summarizeSource(s)
        if (sum?.url?.includes('.m3u8') || sum?.format === 'm3u8' || sum?.format === 'hls') {
          entry.firstM3u8 = { provider, ...sum }
          break
        }
      }
      if (entry.firstM3u8) {
        entry.providers.push(provider)
        break
      }
      if (flat.length) {
        entry.providers.push({ provider, sample: summarizeSource(flat[0]) })
      }
    }
    results.push(entry)
    console.log(JSON.stringify(entry))
  }

  const hits = results.filter((r) => r.firstM3u8)
  console.log(`\n=== Summary: ${hits.length}/${SHOWS.length} got m3u8 from first 12 providers ===`)

  // Try external provider URL from env - probe common patterns
  console.log('\n=== External provider guesses ===')
  const externalBases = [
    'https://api.insertunit.ws',
    'https://filmku.stream',
    'https://vsrc.su',
  ]
  for (const base of externalBases) {
    const url = `${base}/${SHOWS[0].id}?s=1&e=1`
    const r = await get(url)
    console.log(base, r.status, r.text.slice(0, 200))
  }
}

main().catch(console.error)
