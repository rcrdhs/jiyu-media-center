const fs = require('fs')
const path = require('path')

const f = path.join(process.env.TEMP, 'jiyu-probe', 'ls', '004838.ldb')
const text = fs.readFileSync(f).toString('utf8')

const titles = [...text.matchAll(/"title":"([^"]{3,160})"/g)].map((m) => m[1])
const playUrls = [...text.matchAll(/"playUrl":"([^"]+)"/g)].map((m) => m[1])
const urls = [
  ...text.matchAll(/https:\/\/embed(?:india)?\.st\/embed\/[^\x00"']{5,180}/g),
].map((m) => m[0])
const sources = [...text.matchAll(/"source":"([^"]+)"/g)].map((m) => m[1])

const sportsTitles = [...new Set(titles)].filter((t) =>
  /contender|wwe|nxt|sox|royals|boca|pirates|ufc|fight|nba|nfl|mlb|live|dana|diamondbacks/i.test(
    t,
  ),
)

console.log(
  JSON.stringify(
    {
      sportsTitles: sportsTitles.slice(-40),
      playUrls: [...new Set(playUrls)].slice(-20),
      embedUrls: [...new Set(urls)].slice(-20),
      sources: [...new Set(sources)],
    },
    null,
    2,
  ),
)
