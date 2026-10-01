const TMDB_KEY = 'd64117f26031a428449f102ced3aba73'
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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') }
}

async function scanJs() {
  const files = [
    'pages/embed-a2f4195a653b219d.js',
    '1446-e920d125df04a54a.js',
    '7300-4265723c6b372545.js',
    '823c5380-1dfb1d3849cbbdbc.js',
    '257e8032-e4b56c932d7278cd.js',
  ]
  const terms = [
    'nonEmbedSources',
    'scrapper.rivestream',
    'backend.rivestream',
    'm3u8-proxy',
    'filmku',
    'insertunit',
    'getNonEmbed',
    'resolveSource',
    'fetchSources',
    '/sources',
    'type=tv',
    'imdb',
    'tmdb',
  ]
  for (const file of files) {
    const { text } = await fetchText(`https://rivestream.ru/_next/static/chunks/${file}`)
    console.log(`\n=== ${file} (${text.length} bytes) ===`)
    for (const term of terms) {
      const idx = text.indexOf(term)
      if (idx >= 0) {
        console.log(term, '->', text.slice(Math.max(0, idx - 100), idx + 300).replace(/\s+/g, ' '))
      }
    }
    const apiUrls = [...new Set([...text.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`\s]{0,120}/gi)].map((m) => m[0]))]
    const interesting = apiUrls.filter((u) =>
      /rivestream|filmku|insertunit|1shows|valhalla|scrapper|backend|bff|vidsrc|multiembed/i.test(u),
    )
    if (interesting.length) console.log('urls', interesting.slice(0, 30))
  }
}

async function probeScrapper() {
  console.log('\n=== Scrapper / backend probes ===')
  const paths = [
    (id) => `https://scrapper.rivestream.app/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/stream/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/api/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/v1/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/sources/tv/${id}/1/1`,
    (id) => `https://scrapper.rivestream.app/non-embed/tv/${id}/1/1`,
    (id) => `https://backend.rivestream.app/tv/${id}/1/1`,
    (id) => `https://backend.rivestream.app/stream/tv/${id}/1/1`,
    (id) => `https://backend.rivestream.app/sources/tv/${id}/1/1`,
    (id) => `https://api.insertunit.ws/tv/${id}/1/1`,
    (id) => `https://filmku.stream/api/tv/${id}/1/1`,
    (id) => `https://filmku.stream/tv/${id}/1/1`,
    (id) => `https://filmku.stream/embed/tv/${id}/1/1`,
    (id) => `https://subs.1shows.app/tv/${id}/1/1`,
    (id) => `https://subs.1shows.app/subtitles/tv/${id}/1/1`,
    (id) => `https://rivestream.ru/api/scrapper/tv/${id}/1/1`,
    (id) => `https://rivestream.ru/api/sources/tv/${id}/1/1`,
    (id) => `https://rivestream.ru/api/non-embed/tv/${id}/1/1`,
  ]
  for (const show of SHOWS.slice(0, 3)) {
    for (const fn of paths) {
      const url = fn(show.id)
      const { status, text, ct } = await fetchText(url)
      if (status !== 404 && status !== 403 && !text.includes('<!DOCTYPE')) {
        console.log(show.name, status, ct, url, text.slice(0, 250))
      } else if (status === 200 && text.includes('m3u8')) {
        console.log(show.name, 'M3U8 HIT', url, text.slice(0, 250))
      }
    }
  }
}

async function probeFilmku() {
  console.log('\n=== filmku / insertunit pattern scan ===')
  const js = await fetchText('https://rivestream.ru/_next/static/chunks/1446-e920d125df04a54a.js')
  const fnNames = [...js.text.matchAll(/async function [a-zA-Z0-9_$]{2,40}\([^)]*\)\{[^}]{0,80}fetch\(/g)].map((m) => m[0])
  console.log('async fetch fns sample', fnNames.slice(0, 5))
  const fetchUrls = [...new Set([...js.text.matchAll(/fetch\([\"']([^\"']+)[\"']/g)].map((m) => m[1]))]
  console.log('fetch literals', fetchUrls.slice(0, 40))
  const templateFetch = [...js.text.matchAll(/fetch\(`([^`]+)`/g)].map((m) => m[1])
  console.log('fetch templates', [...new Set(templateFetch)].slice(0, 40))
}

async function probeEmbedHtml() {
  console.log('\n=== Embed page __NEXT_DATA__ ===')
  for (const show of SHOWS.slice(0, 2)) {
    const url = `https://rivestream.ru/embed?type=tv&id=${show.id}&season=1&episode=1`
    const { text } = await fetchText(url)
    const nd = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (nd) {
      try {
        const data = JSON.parse(nd[1])
        console.log(show.name, 'props', JSON.stringify(data.props?.pageProps || data.props, null, 2).slice(0, 800))
      } catch (e) {
        console.log(show.name, 'parse fail')
      }
    }
    const inlineM3u8 = [...text.matchAll(/https?:[^\"'\s]+\.m3u8[^\"'\s]*/g)].map((m) => m[0])
    console.log(show.name, 'inline m3u8', inlineM3u8)
  }
}

async function main() {
  await scanJs()
  await probeFilmku()
  await probeEmbedHtml()
  await probeScrapper()
}

main().catch(console.error)
