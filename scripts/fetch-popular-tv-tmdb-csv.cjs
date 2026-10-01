/**
 * Top 1000 popular TMDB TV shows, first air date >= 2010.
 * Reads TMDB_API_KEY from env or repo-root .env (gitignored).
 * Usage: node scripts/fetch-popular-tv-tmdb-csv.cjs
 */
const fs = require('fs')
const path = require('path')

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val
  }
}

loadDotEnv()

const API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY || ''
const BASE = 'https://api.themoviedb.org/3'
const TARGET = 1000
const PAGE_SIZE = 20 // TMDB discover page size

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function tmdb(pathname, params = {}) {
  const url = new URL(BASE + pathname)
  url.searchParams.set('api_key', API_KEY)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`TMDB ${pathname} HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return out
}

async function main() {
  if (!API_KEY) {
    console.error('Set TMDB_API_KEY in the environment')
    process.exit(1)
  }

  const pagesNeeded = Math.ceil(TARGET / PAGE_SIZE)
  const shows = []
  for (let page = 1; page <= pagesNeeded; page++) {
    const json = await tmdb('/discover/tv', {
      sort_by: 'popularity.desc',
      'first_air_date.gte': '2010-01-01',
      include_null_first_air_dates: 'false',
      language: 'en-US',
      page,
    })
    const results = Array.isArray(json.results) ? json.results : []
    if (results.length === 0) break
    shows.push(...results)
    console.error(`discover page ${page}/${pagesNeeded} (+${results.length}, total ${shows.length})`)
    await new Promise((r) => setTimeout(r, 40))
  }

  const top = shows.slice(0, TARGET)
  console.error(`fetching external ids for ${top.length} shows…`)
  const withIds = await mapPool(top, 8, async (show) => {
    try {
      const ext = await tmdb(`/tv/${show.id}/external_ids`)
      return {
        show,
        imdb: ext.imdb_id || '',
        tvdb: ext.tvdb_id || '',
      }
    } catch {
      return { show, imdb: '', tvdb: '' }
    }
  })

  const header = [
    'rank',
    'name',
    'first_air_date',
    'year',
    'popularity',
    'vote_average',
    'vote_count',
    'imdb_id',
    'tmdb_id',
    'tvdb_id',
    'origin_country',
    'original_language',
    'genre_ids',
    'overview',
    'poster',
    'tmdb_url',
  ]
  const lines = [header.join(',')]
  withIds.forEach(({ show, imdb, tvdb }, i) => {
    const year = show.first_air_date ? Number(String(show.first_air_date).slice(0, 4)) : ''
    const poster = show.poster_path
      ? `https://image.tmdb.org/t/p/w342${show.poster_path}`
      : ''
    lines.push(
      [
        i + 1,
        csvEscape(show.name || show.original_name || ''),
        csvEscape(show.first_air_date || ''),
        year || '',
        show.popularity ?? '',
        show.vote_average ?? '',
        show.vote_count ?? '',
        csvEscape(imdb),
        show.id ?? '',
        tvdb || '',
        csvEscape((show.origin_country || []).join('; ')),
        csvEscape(show.original_language || ''),
        csvEscape((show.genre_ids || []).join('; ')),
        csvEscape(show.overview || ''),
        csvEscape(poster),
        csvEscape(`https://www.themoviedb.org/tv/${show.id}`),
      ].join(','),
    )
  })

  const out = path.join(__dirname, '..', 'popular-tv-2010-present-top1000.csv')
  fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        out,
        written: withIds.length,
        withImdb: withIds.filter((x) => x.imdb).length,
        first: withIds.slice(0, 8).map((x) => x.show.name),
        last: withIds.slice(-3).map((x) => x.show.name),
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
