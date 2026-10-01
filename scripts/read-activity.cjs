const fs = require('fs')
const path = require('path')
const root = path.join(process.env.APPDATA, 'jiyu-media-center', 'Local Storage', 'leveldb')

for (const name of fs.readdirSync(root)) {
  if (!/\.(ldb|log)$/i.test(name)) continue
  const buf = fs.readFileSync(path.join(root, name))
  const text = buf.toString('utf8')
  // activity log key
  const key = 'jiyu.activity.log.v1'
  let idx = 0
  while ((idx = text.indexOf(key, idx)) >= 0) {
    const slice = text.slice(idx, idx + 8000)
    const cleaned = slice.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    console.log('---', name, '---')
    console.log(cleaned.slice(0, 4000))
    idx += key.length
  }
  // also hunt Failed to fetch contexts
  let f = 0
  while ((f = text.indexOf('Failed to fetch', f)) >= 0) {
    console.log(
      'FAIL@',
      name,
      text
        .slice(Math.max(0, f - 100), f + 80)
        .replace(/[^\x20-\x7e]/g, '.'),
    )
    f += 15
  }
}
