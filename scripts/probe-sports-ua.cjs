const fs = require('fs')
const path = require('path')

const raw = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'jiyu-media-center', 'playlist-sources.json'), 'utf8'),
)
const rows = Array.isArray(raw) ? raw : Object.values(raw)
const sports = rows.find((s) => s.id === 'builtin-iptv-org-sports')
const lines = sports.content.split(/\r?\n/)
const want = ['ESPN (1080p)', 'DraftKings', 'ACC Network', '5Sport (1080p)', '30A Golf']
let pending = null
const found = []
for (const line of lines) {
  const t = line.trim()
  if (t.startsWith('#EXTINF:')) {
    pending = t
    continue
  }
  if (t.startsWith('#')) continue
  if (pending && /^https?:/i.test(t)) {
    const title = pending.slice(pending.lastIndexOf(',') + 1).trim()
    if (want.some((w) => title.includes(w))) {
      const uaMatch = pending.match(/http-user-agent="([^"]+)"/i)
      found.push({ title, url: t, ua: uaMatch ? uaMatch[1] : null })
    }
    pending = null
  }
}
console.log('found', found.length)
const uas = [
  null,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 JiyuMedia/0.3.3',
]

;(async () => {
  for (const f of found) {
    console.log('\n==', f.title, f.url.slice(0, 70))
    const list = [...uas]
    if (f.ua) list.push(f.ua)
    for (const ua of list) {
      try {
        const headers = { Accept: '*/*' }
        if (ua) headers['User-Agent'] = ua
        const r = await fetch(f.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) })
        const txt = (await r.text()).slice(0, 90).replace(/\s+/g, ' ')
        const label = ua ? `…${ua.slice(-24)}` : 'default'
        console.log(r.status, label, txt.slice(0, 60))
      } catch (e) {
        console.log('ERR', ua ? ua.slice(-24) : 'default', e.cause?.code || e.message)
      }
    }
  }
})()
