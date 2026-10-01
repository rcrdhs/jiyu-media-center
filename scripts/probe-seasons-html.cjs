const fs = require('fs')
const h = fs.readFileSync('D:/app/scripts/nm-detail.html', 'utf8')
const i = h.indexOf('id="seasons"')
console.log('seasons', i)
console.log(h.slice(i, i + 2500))
const servers = [...h.matchAll(/data-load-embed="([^"]*)"[^>]*data-load-embed-host="([^"]*)"/g)]
console.log('servers', servers.map((m) => [m[1], m[2]]))
