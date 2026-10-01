const fs = require('fs')
const html = fs.readFileSync('D:/app/scripts/nm-detail.html', 'utf8')
const m = html.match(/id="episodes-js-extra"[^>]*src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"/)
if (!m) {
  console.log('no match')
  process.exit(1)
}
const decoded = Buffer.from(m[1], 'base64').toString('utf8')
console.log(decoded)
const json = decoded.replace(/^var Episodes=/, '').replace(/;?\s*$/, '')
console.log(JSON.stringify(JSON.parse(json), null, 2))
