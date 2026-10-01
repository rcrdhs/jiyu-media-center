const fs = require('fs')
const path = require('path')

function decodeHtmlEntities(raw) {
  return raw
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function normalizeTitleKey(title) {
  return title
    .toLowerCase()
    .replace(/\s*[\[(][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\b(720p|1080p|2160p|4k|hd|sd|fhd|uhd|hevc|h\.?265|h\.?264|not\s*24\/?7)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function parseNetMirrorListHtml(html) {
  const links = []
  const seen = new Set()
  const re =
    /id="post-(\d+)"[\s\S]*?<a href="(https:\/\/freemovies\.lol\/[^"]+\/)"[^>]*>\s*<img[^>]+data-src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<span>(\d{4})<\/span>\s*<span class="type">([^<]*)<\/span>\s*<span>([^<]*)<\/span>/gi
  let match
  while ((match = re.exec(html))) {
    const url = match[2]
    if (seen.has(url)) continue
    seen.add(url)
    const title = decodeHtmlEntities(match[4] || '').slice(0, 180)
    if (!title) continue
    links.push({ title, url, postId: match[1] })
  }
  return links
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html',
      Referer: 'https://freemovies.lol/',
    },
  })
  return { status: res.status, text: await res.text() }
}

async function fetchNetMirrorCatalog(maxPages = 146) {
  const byUrl = new Map()
  for (let page = 1; page <= maxPages; page++) {
    const url =
      page <= 1
        ? 'https://freemovies.lol/category/tv-series/'
        : `https://freemovies.lol/category/tv-series/page/${page}/`
    const { status, text } = await fetchText(url)
    if (status >= 400) break
    const links = parseNetMirrorListHtml(text)
    if (!links.length) break
    for (const l of links) byUrl.set(l.url, l)
    await new Promise((r) => setTimeout(r, 150))
  }
  return [...byUrl.values()]
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a'
}

async function main() {
  const ymovies = JSON.parse(fs.readFileSync(path.join(__dirname, '../reports/ymovies-catalog.json'), 'utf8'))
  const yList = Array.isArray(ymovies) ? ymovies : ymovies.items || []
  const yKeys = new Map()
  for (const item of yList) {
    const key = normalizeTitleKey(item.title || '')
    if (key) yKeys.set(key, item)
  }

  const nmList = await fetchNetMirrorCatalog(146)
  const nmKeys = new Map()
  for (const item of nmList) {
    const key = normalizeTitleKey(item.title || '')
    if (key) nmKeys.set(key, item)
  }

  let yInNm = 0
  let nmInY = 0
  const samples = []
  for (const key of yKeys.keys()) {
    if (nmKeys.has(key)) {
      yInNm++
      if (samples.length < 10) samples.push(key)
    }
  }
  for (const key of nmKeys.keys()) if (yKeys.has(key)) nmInY++

  const union = yKeys.size + nmKeys.size - yInNm
  const TMDB_TV = 230424

  console.log(JSON.stringify({
    ymovies: yList.length,
    ymoviesUnique: yKeys.size,
    netmirror: nmList.length,
    netmirrorUnique: nmKeys.size,
    ymoviesAlsoNetmirror: yInNm,
    ymoviesAlsoNetmirrorPct: pct(yInNm, yKeys.size),
    netmirrorAlsoYmovies: nmInY,
    netmirrorAlsoYmoviesPct: pct(nmInY, nmKeys.size),
    unionUniqueTitles: union,
    riveTmdbTv: TMDB_TV,
    unionAsPctOfRive: pct(union, TMDB_TV),
    riveExtraMetadataRows: TMDB_TV - union,
    samples,
  }, null, 2))
}

main().catch(console.error)
