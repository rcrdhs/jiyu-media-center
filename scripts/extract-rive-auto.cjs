const fs = require('fs')
const src = fs.readFileSync('D:/app/electron/main.cjs', 'utf8')
const start = src.indexOf('const RIVESTREAM_EMBED_AUTO_SCRIPT = ')
const end = src.indexOf('function forceRiveEmbedHop', start)
if (start < 0 || end < 0) {
  console.error('not found', start, end)
  process.exit(1)
}
let block = src.slice(start, end).trim()

block = block.replace(
  'else idx = Math.max(0, ORDER.indexOf(prefer));',
  'else idx = -1; // first Direct→Embed hop starts at ORDER[0]',
)

block = block.replace(
  "return /Cloud:\\\\s*use AD-Blocker|Cloud:\\\\s*use video downloader|no working sources|access denied|http error 403|err_name_not_resolved/i.test(t);",
  "return /Cloud:\\\\s*use AD-Blocker|Cloud:\\\\s*use video downloader|no working sources|access denied|http error 403|err_name_not_resolved|Firefox Can't Open This Page|will not allow Firefox to display|X-Frame-Options|to protect your security/i.test(t);",
)

block = block.replace(
  'if (/^Servers\\\\s*&\\\\s*Mode$/i.test(raw) || /^QUICK\\\\s*MENU$/i.test(raw))',
  'if (/Servers\\\\s*&\\\\s*Mode/i.test(raw) || /^QUICK\\\\s*MENU$/i.test(raw))',
)

const out =
  '/** Shared Rivestream embed auto-hop (Direct first, then Embed hosts). */\n' +
  'export ' +
  block +
  '\n'
fs.writeFileSync('D:/app/src/lib/rivestreamEmbedAuto.ts', out)
console.log('wrote', out.length, 'chars')
