/**
 * Full YMovies catalog crawl + sync report (Node, no Electron).
 * Run: node scripts/sync-ymovies-catalog.cjs
 */
const fs = require('fs')
const path = require('path')

const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const MAX_PAGES = 100
const GAP_MS = 250

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function parsePage(html) {
  const links = []
  const seen = new Set()
  const re =
    /href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[\s\S]*?data-original="([^"]+)"[\s\S]*?SS\s*(\d+)[\s\S]*?EPS\s*(\d+)/gi
  let m
  while ((m = re.exec(html))) {
    const url = ORIGIN + m[1]
    if (seen.has(url)) continue
    seen.add(url)
    const id = m[1].match(/-(s[a-z0-9]+)$/i)?.[1] || ''
    links.push({
      title: decodeHtml(m[2]),
      url,
      poster: m[3],
      seasons: m[4],
      episodes: m[5],
      ymoviesId: id,
    })
  }
  if (links.length) return links
  const fb =
    /href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[\s\S]*?data-original="([^"]+)"/gi
  while ((m = fb.exec(html))) {
    const url = ORIGIN + m[1]
    if (seen.has(url)) continue
    seen.add(url)
    links.push({
      title: decodeHtml(m[2]),
      url,
      poster: m[3],
      seasons: '',
      episodes: '',
      ymoviesId: m[1].match(/-(s[a-z0-9]+)$/i)?.[1] || '',
    })
  }
  return links
}

async function fetchPage(n) {
  const url = n <= 1 ? `${ORIGIN}/movie/filter/series/` : `${ORIGIN}/movie/filter/series/${n}/`
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  return { status: r.status, html: await r.text(), url }
}

async function probeEpisodes(id) {
  const seasons = await fetch(`${ORIGIN}/ajax/movie/seasons/${id}`, {
    headers: { 'User-Agent': UA, Referer: ORIGIN },
  }).then((r) => r.text())
  const ep = await fetch(`${ORIGIN}/ajax/movie/season/episodes/${id}_1`, {
    headers: { 'User-Agent': UA, Referer: ORIGIN },
  }).then((r) => r.text())
  let epCount = 0
  try {
    epCount = JSON.parse(ep).totalItems || 0
  } catch {
    epCount = (ep.match(/data-id="\d+_\d+"/g) || []).length
  }
  return { seasonsOk: /Season/i.test(seasons), epCount }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

;(async () => {
  const started = Date.now()
  const all = []
  const seen = new Set()
  let pagesOk = 0
  let lastPage = 0

  for (let p = 1; p <= MAX_PAGES; p++) {
    const { status, html } = await fetchPage(p)
    if (status !== 200) {
      console.log(`page ${p}: HTTP ${status} — stop`)
      break
    }
    const batch = parsePage(html)
    if (batch.length === 0) {
      console.log(`page ${p}: 0 items — stop`)
      break
    }
    pagesOk++
    lastPage = p
    let added = 0
    for (const item of batch) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      all.push(item)
      added++
    }
    if (p % 25 === 0 || p <= 3) console.log(`page ${p}: +${added} (total ${all.length})`)
    await sleep(GAP_MS)
  }

  const sample = all.slice(0, 8)
  const probe = all[0] ? await probeEpisodes(all[0].ymoviesId) : null

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const reportDir = path.join(__dirname, '..', 'reports')
  fs.mkdirSync(reportDir, { recursive: true })

  const stats = {
    syncedAt: new Date().toISOString(),
    origin: ORIGIN,
    pagesFetched: pagesOk,
    lastPage,
    totalTitles: all.length,
    elapsedSeconds: Number(elapsed),
    episodeProbe: probe,
    sampleTitles: sample.map((s) => s.title),
  }

  fs.writeFileSync(path.join(reportDir, 'ymovies-catalog.json'), JSON.stringify(all, null, 0))
  fs.writeFileSync(path.join(reportDir, 'ymovies-catalog-stats.json'), JSON.stringify(stats, null, 2))

  const md = `# YMovies Sync Report

Generated: ${stats.syncedAt}

## Summary

| Metric | Value |
|---|---|
| **Source** | ${ORIGIN}/movie/filter/series/ |
| **Pages fetched** | ${pagesOk} (stopped at page ${lastPage}) |
| **Total titles synced** | **${all.length.toLocaleString()}** |
| **Crawl time** | ${elapsed}s |
| **Jiyu scraper version** | 39 |

## Integration status

- **Catalog source:** \`builtin-ymovies\` — YMovies · TV Series (Library → Websites)
- **Shelf:** TV Series → Full Shows (alongside M2Box / NetMirror)
- **Episodes:** AJAX chain (\`/ajax/movie/seasons/\`, \`/ajax/movie/season/episodes/\`, …)
- **Playback:** Web Browser → \`watching.html?ep=S_E\` (Server A1/A2 in-page)

## Episode API probe (${sample[0]?.title || 'first title'})

- Seasons endpoint: ${probe?.seasonsOk ? 'OK' : 'failed'}
- Season 1 episodes: ${probe?.epCount ?? 'n/a'}

## Sample titles (page 1)

${sample.map((s) => `- ${s.title} (\`${s.ymoviesId}\`)`).join('\n')}

## NetMirror overlap

NetMirror/freemovies.lol returned **522** during probe — direct poster overlap not measured.
YMovies catalog is ~${all.length.toLocaleString()} show-level entries vs NetMirror ~4,650 when online.

## Next launch

Jiyu will auto-sync YMovies on startup (scraper v39 bump). Open **Library → Sync** if the shelf is empty.

---
*Report written by \`scripts/sync-ymovies-catalog.cjs\`*
`

  const reportPath = path.join(reportDir, 'YMovies-Sync-Report.md')
  fs.writeFileSync(reportPath, md)
  fs.writeFileSync(path.join(__dirname, '..', '.cursor', 'YMovies-Sync-Report.md'), md)

  console.log('\nDone:', stats)
  console.log('Report:', reportPath)
})()
