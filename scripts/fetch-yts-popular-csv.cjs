/**
 * Export YTS movies sorted by download_count (most downloaded first).
 * Usage: node scripts/fetch-yts-popular-csv.cjs [limit]
 */
const fs = require('fs')
const path = require('path')

const ORIGINS = [
  'https://yts.lt',
  'https://movies-api.accel.li',
  'https://yts.mx',
  'https://yts.gg',
]
const PAGE_SIZE = 50
const TARGET = Math.max(20, Math.min(5000, Number(process.argv[2]) || 500))

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function fetchPage(origin, page) {
  const url = new URL(`${origin}/api/v2/list_movies.json`)
  url.searchParams.set('limit', String(PAGE_SIZE))
  url.searchParams.set('page', String(page))
  url.searchParams.set('sort_by', 'download_count')
  url.searchParams.set('order_by', 'desc')
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json.status !== 'ok') throw new Error(json.status_message || 'bad status')
  return json.data || {}
}

async function main() {
  let origin = null
  let first = null
  for (const o of ORIGINS) {
    try {
      first = await fetchPage(o, 1)
      origin = o
      break
    } catch (e) {
      console.error(o, e.message || e)
    }
  }
  if (!origin || !first) {
    console.error('No YTS mirror answered')
    process.exit(1)
  }

  const movies = []
  const pagesNeeded = Math.ceil(TARGET / PAGE_SIZE)
  for (let page = 1; page <= pagesNeeded; page++) {
    const data = page === 1 ? first : await fetchPage(origin, page)
    const rows = Array.isArray(data.movies) ? data.movies : []
    if (rows.length === 0) break
    movies.push(...rows)
    console.error(`page ${page}/${pagesNeeded} (+${rows.length}, total ${movies.length})`)
    if (rows.length < PAGE_SIZE) break
    await new Promise((r) => setTimeout(r, 80))
  }

  const top = movies.slice(0, TARGET)
  const header = [
    'rank',
    'title',
    'year',
    'rating',
    'runtime_min',
    'genres',
    'language',
    'imdb_code',
    'yts_id',
    'yts_url',
    'poster',
    'summary',
  ]
  const lines = [header.join(',')]
  top.forEach((m, i) => {
    lines.push(
      [
        i + 1,
        csvEscape(m.title_long || m.title || ''),
        m.year ?? '',
        m.rating ?? '',
        m.runtime ?? '',
        csvEscape((m.genres || []).join('; ')),
        csvEscape(m.language || ''),
        csvEscape(m.imdb_code || ''),
        m.id ?? '',
        csvEscape(m.url || ''),
        csvEscape(m.medium_cover_image || m.large_cover_image || ''),
        csvEscape(String(m.summary || m.description_full || '').replace(/\s+/g, ' ').trim()),
      ].join(','),
    )
  })

  const out = path.join(__dirname, '..', 'yts-popular-downloads-top500.csv')
  fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        origin,
        out,
        written: top.length,
        first: top.slice(0, 15).map((m) => `${m.title} (${m.year})`),
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
