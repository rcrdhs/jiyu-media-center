/**
 * Dump Anime → Full Shows titles that are NOT from SubsPlease
 * (typically TMDB · Anime Full Shows) from the local IndexedDB LevelDB files.
 */
const fs = require('fs')
const path = require('path')

const dir = path.join(
  process.env.APPDATA || '',
  'jiyu-media-center',
  'IndexedDB',
  'http_localhost_5173.indexeddb.leveldb',
)

if (!fs.existsSync(dir)) {
  console.error('IndexedDB not found:', dir)
  process.exit(1)
}

const files = fs.readdirSync(dir).filter((f) => /\.(ldb|log)$/i.test(f))
const blob = Buffer.concat(files.map((f) => fs.readFileSync(path.join(dir, f))))

/** Collect UTF-8-ish strings from binary IDB dump. */
function extractStrings(buf, minLen = 3, maxLen = 200) {
  const out = []
  let cur = []
  const flush = () => {
    if (cur.length >= minLen && cur.length <= maxLen) {
      out.push(Buffer.from(cur).toString('utf8'))
    }
    cur = []
  }
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    // printable ASCII + common UTF-8 continuation start
    if (b >= 0x20 && b <= 0x7e) {
      cur.push(b)
    } else if (b >= 0xc2 && b <= 0xf4) {
      // keep multi-byte seq if valid-ish
      cur.push(b)
    } else if (b >= 0x80 && b <= 0xbf && cur.length) {
      cur.push(b)
    } else {
      flush()
    }
  }
  flush()
  return out
}

const strings = extractStrings(blob)

// Find object-ish JSON fragments that mention sources.
const jsonSnippets = []
const text = blob.toString('latin1')
const sourceNeedles = ['builtin-tmdb-anime', 'builtin-subsplease', 'full-shows']
for (const needle of sourceNeedles) {
  let idx = 0
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    jsonSnippets.push(text.slice(Math.max(0, idx - 1200), Math.min(text.length, idx + 400)))
    idx += needle.length
  }
}

function decodeLatinJsonish(chunk) {
  // Recover UTF-8 from latin1 slice when possible
  try {
    return Buffer.from(chunk, 'latin1').toString('utf8')
  } catch {
    return chunk
  }
}

function titlesFromChunks(chunks, sourceId) {
  const titles = new Map() // title -> { sourceId, tags }
  for (const raw of chunks) {
    const c = decodeLatinJsonish(raw)
    if (!c.includes(sourceId) && sourceId !== '*') continue

    // Structured clone sometimes still has JSON-looking keys from put payloads.
    const titleMatches = [
      ...c.matchAll(/"title"\s*:\s*"((?:\\.|[^"\\]){1,180})"/g),
    ]
    for (const m of titleMatches) {
      let t = m[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, ' ')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .trim()
      if (!t || t.length < 2) continue
      if (/^(torrent-|builtin-|jiyu:|https?:|magnet:)/i.test(t)) continue
      if (/subsplease|torrentSourceId|category|full-shows|new-releases/i.test(t)) continue
      const near = c.slice(Math.max(0, m.index - 200), m.index + 400)
      const isSubs =
        /builtin-subsplease|subsplease\.org/i.test(near) || /subsplease\.org/i.test(c)
      const isTmdb = /builtin-tmdb-anime|jiyu:\/\/tmdb-anime|jiyu:\/\/tmdb-tv\//i.test(near)
      const hasFull = /full-shows/i.test(near) || /full-shows/i.test(c)
      const catAnime = /"category"\s*:\s*"anime"/i.test(near) || /category[\s\S]{0,20}anime/i.test(near)
      titles.set(t, {
        title: t,
        isSubs: Boolean(isSubs),
        isTmdb: Boolean(isTmdb),
        hasFull: Boolean(hasFull),
        catAnime: Boolean(catAnime),
        sourceHint: isTmdb ? 'tmdb' : isSubs ? 'subsplease' : 'unknown',
      })
    }
  }
  return titles
}

const byTitle = titlesFromChunks(jsonSnippets, '*')

// Also: scan string table for titles that appear near tmdb anime detail urls.
const tmdbIds = new Set()
for (const s of strings) {
  const m = s.match(/^jiyu:\/\/tmdb-tv\/(\d+)$/i)
  if (m) tmdbIds.add(m[1])
}

// Heuristic list: prefer entries tagged TMDB anime / full-shows and not SubsPlease.
const nonSubs = []
const subs = []
for (const entry of byTitle.values()) {
  if (entry.isSubs && !entry.isTmdb) {
    subs.push(entry)
    continue
  }
  // Non-SubsPlease full shows: TMDB anime rows, or full-shows tagged anime without subsplease.
  if (entry.isTmdb || (entry.hasFull && entry.catAnime && !entry.isSubs)) {
    nonSubs.push(entry)
  }
}

nonSubs.sort((a, b) => a.title.localeCompare(b.title))
subs.sort((a, b) => a.title.localeCompare(b.title))

const uniqueNonSubs = []
const seen = new Set()
for (const e of nonSubs) {
  const key = e.title.toLowerCase()
  if (seen.has(key)) continue
  seen.add(key)
  uniqueNonSubs.push(e.title)
}

console.log(JSON.stringify({
  indexedDbDir: dir,
  snippetHits: jsonSnippets.length,
  parsedTitles: byTitle.size,
  nonSubsPleaseFullShows: uniqueNonSubs.length,
  subsPleaseParsed: subs.length,
  tmdbDetailUrlsSeen: tmdbIds.size,
  titles: uniqueNonSubs,
}, null, 2))
