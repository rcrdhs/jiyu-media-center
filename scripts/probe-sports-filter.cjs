const fs = require('fs')
const path = require('path')

const ENGLISH_HINT =
  /\b(english|eng\b|en\b|uk\b|usa\b|us\b|united\s*states|britain|british|canada|canadian|australia|australian|ireland|new\s*zealand|nz\b)\b|[|\[]\s*(en|eng|uk|us|usa|ca|au)\s*[|\]]|:\s*(us|uk|ca|au)\b|^us\s*[:|\-]|group.*\b(us|uk|ca|au|en)\b/i
const NON_ENGLISH_HINT =
  /\b(arabic|español|espanol|spanish|french|français|francais|deutsch|german|italian|italiano|portugu[eê]s|brazil|brasil|turkish|türk|russian|русский|hindi|tamil|telugu|urdu|chinese|mandarin|cantonese|korean|日本語|日本|korean|한국어|thai|vietnamese|polish|romanian|greek|hebrew|persian|farsi|indonesian|malay|tagalog|filipino)\b|[|\[]\s*(ar|es|mx|br|pt|fr|de|it|tr|ru|in|pk|cn|zh|kr|jp|th|vn|pl|ro|gr|il|id|my|ph)\s*[|\]]|:\s*(ar|es|mx|br|fr|de|it|tr|ru|in|cn|kr|jp)\b/i

const SPORTS =
  /sport|espn|nba|nfl|mlb|football|soccer|uefa|f1|tennis|ufc|boxing|golf|hockey|cricket|racing|olympics|ppv|fight/i

function attr(meta, key) {
  const quoted = meta.match(new RegExp(`${key}="([^"]*)"`, 'i'))
  if (quoted) return quoted[1]
  return undefined
}

function isLikelyEnglish(item) {
  const lang = item.language?.trim()
  if (lang) {
    if (/^(en|eng|english)\b/i.test(lang)) return true
    if (/^[a-z]{2,3}\b/i.test(lang)) return false
  }
  const haystack = [item.title, item.description, item.language || '', ...(item.tags || [])].join(
    ' ',
  )
  const english = ENGLISH_HINT.test(haystack)
  const other = NON_ENGLISH_HINT.test(haystack)
  if (other && !english) return false
  return true
}

const file = path.join(process.env.APPDATA, 'jiyu-media-center', 'playlist-sources.json')
const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
const rows = Array.isArray(raw) ? raw : Object.values(raw)
const sports = rows.find((s) => s.id === 'builtin-iptv-org-sports')
if (!sports) {
  console.log('no sports source')
  process.exit(1)
}

const lines = sports.content.split(/\r?\n/)
let pending = null
const items = []
for (const line of lines) {
  const t = line.trim()
  if (!t) continue
  if (t.startsWith('#EXTINF:')) {
    const comma = t.lastIndexOf(',')
    const meta = comma >= 0 ? t.slice(0, comma) : t
    const after = comma >= 0 ? t.slice(comma + 1).trim() : ''
    pending = {
      title: after || attr(meta, 'tvg-name') || 'Untitled',
      group: attr(meta, 'group-title') || '',
      language: attr(meta, 'tvg-language') || attr(meta, 'language') || '',
    }
    continue
  }
  if (t.startsWith('#')) continue
  if (!pending) continue
  items.push({
    ...pending,
    url: t,
    description: pending.group,
    tags: ['iptv', 'imported', pending.group].filter(Boolean),
  })
  pending = null
}

const asSports = items.filter((i) => SPORTS.test(`${i.title} ${i.group}`))
const eng = asSports.filter(isLikelyEnglish)
const filtered = asSports.filter((i) => !isLikelyEnglish(i))

console.log(
  JSON.stringify(
    {
      total: items.length,
      asSports: asSports.length,
      englishSports: eng.length,
      filteredOut: filtered.length,
      withLangAttr: asSports.filter((i) => i.language).length,
      sampleFiltered: filtered.slice(0, 12).map((i) => `${i.title} lang=${i.language}`),
      sampleKept: eng.slice(0, 8).map((i) => `${i.title} lang=${i.language}`),
      sampleLangValues: [...new Set(asSports.map((i) => i.language).filter(Boolean))].slice(0, 30),
    },
    null,
    2,
  ),
)
