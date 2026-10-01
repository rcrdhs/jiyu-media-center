/**
 * Build a review CSV of popular TV shows (premiered 2010–present).
 * Uses TVMaze (free, no key): rank by `weight`, then rating.
 * Not TMDB popularity — regenerate with a TMDB key if you need that ranking.
 */
const fs = require('fs')
const path = require('path')

async function fetchPage(page) {
  const res = await fetch(`https://api.tvmaze.com/shows?page=${page}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`TVMaze page ${page} HTTP ${res.status}`)
  return res.json()
}

function yearOf(premiered) {
  if (!premiered || typeof premiered !== 'string') return null
  const y = Number(premiered.slice(0, 4))
  return Number.isFinite(y) ? y : null
}

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function main() {
  const all = []
  for (let page = 0; page < 400; page++) {
    const rows = await fetchPage(page)
    if (!rows || !Array.isArray(rows) || rows.length === 0) break
    for (const s of rows) {
      const y = yearOf(s.premiered)
      if (y == null || y < 2010) continue
      all.push(s)
    }
    if (page % 25 === 0) console.error(`page ${page} kept ${all.length}`)
    await new Promise((r) => setTimeout(r, 80))
  }

  all.sort((a, b) => {
    const dw = (b.weight || 0) - (a.weight || 0)
    if (dw) return dw
    const dr =
      ((b.rating && b.rating.average) || 0) - ((a.rating && a.rating.average) || 0)
    if (dr) return dr
    return String(a.name || '').localeCompare(String(b.name || ''))
  })

  const top = all.slice(0, 1000)
  const header = [
    'rank',
    'name',
    'premiered',
    'year',
    'weight',
    'rating',
    'imdb_id',
    'tvmaze_id',
    'status',
    'type',
    'language',
    'genres',
    'network',
    'web_channel',
    'official_site',
    'poster',
    'tvmaze_url',
  ]
  const lines = [header.join(',')]
  top.forEach((s, i) => {
    const imdb = (s.externals && s.externals.imdb) || ''
    const network = (s.network && s.network.name) || ''
    const web = (s.webChannel && s.webChannel.name) || ''
    const poster = (s.image && (s.image.medium || s.image.original)) || ''
    lines.push(
      [
        i + 1,
        csvEscape(s.name),
        csvEscape(s.premiered || ''),
        yearOf(s.premiered) || '',
        s.weight ?? '',
        (s.rating && s.rating.average) ?? '',
        csvEscape(imdb),
        s.id ?? '',
        csvEscape(s.status || ''),
        csvEscape(s.type || ''),
        csvEscape(s.language || ''),
        csvEscape((s.genres || []).join('; ')),
        csvEscape(network),
        csvEscape(web),
        csvEscape(s.officialSite || ''),
        csvEscape(poster),
        csvEscape(s.url || ''),
      ].join(','),
    )
  })

  const out = path.join(__dirname, '..', 'popular-tv-2010-present-top1000.csv')
  fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        out,
        scannedKept: all.length,
        written: top.length,
        first: top.slice(0, 8).map((s) => s.name),
        last: top.slice(-3).map((s) => s.name),
        withImdb: top.filter((s) => s.externals && s.externals.imdb).length,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
