const fs = require('fs')
const path = require('path')

const raw = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'jiyu-media-center', 'playlist-sources.json'), 'utf8'),
)
const rows = Array.isArray(raw) ? raw : Object.values(raw)
const sports = rows.find((s) => s.id === 'builtin-iptv-org-sports')
const lines = sports.content.split(/\r?\n/)
const want = ['5Sport', '30A Golf', 'ESPN (1080p)', 'DraftKings', 'A Spor', 'ACI Sport']
let pending = null
const found = []
for (const line of lines) {
  const t = line.trim()
  if (t.startsWith('#EXTINF:')) {
    pending = t.slice(t.lastIndexOf(',') + 1).trim()
    continue
  }
  if (t.startsWith('#')) continue
  if (pending && /^https?:/i.test(t)) {
    if (want.some((w) => pending.includes(w))) found.push({ title: pending, url: t })
    pending = null
  }
}

;(async () => {
  for (const f of found) {
    try {
      const r = await fetch(f.url, { signal: AbortSignal.timeout(12000) })
      const t = await r.text()
      const codecs = [...t.matchAll(/CODECS="([^"]+)"/gi)].map((m) => m[1])
      const hevc = /hev1|hvc1|h265|hevc/i.test(t + codecs.join(','))
      console.log(
        JSON.stringify({
          title: f.title,
          hevc,
          codecs: codecs.slice(0, 4),
          sample: t.slice(0, 120).replace(/\s+/g, ' '),
        }),
      )
    } catch (e) {
      console.log(JSON.stringify({ title: f.title, error: e.message }))
    }
  }
})()
