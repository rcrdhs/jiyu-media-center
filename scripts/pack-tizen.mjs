import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const tizenDir = path.join(root, 'tizen')
const distDir = path.join(root, 'dist')
const keep = new Set(['config.xml', '.project', '.tproject', 'tizen.js', 'icon.png'])

const csp = [
  "default-src 'self' https: http: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https: http:",
  'media-src * blob: data:',
  'connect-src * data: blob:',
  'frame-src *',
  'child-src *',
].join('; ')

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing. The web build has to finish before the Tizen copy.')
  process.exit(1)
}

for (const name of fs.readdirSync(tizenDir)) {
  if (keep.has(name)) continue
  fs.rmSync(path.join(tizenDir, name), { recursive: true, force: true })
}

fs.cpSync(distDir, tizenDir, { recursive: true })

const logo = path.join(root, 'public', 'jiyu-logo.png')
if (fs.existsSync(logo)) {
  fs.copyFileSync(logo, path.join(tizenDir, 'icon.png'))
}

const indexPath = path.join(tizenDir, 'index.html')
let html = fs.readFileSync(indexPath, 'utf8')
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
if (!html.includes('Content-Security-Policy')) {
  console.error('Built index.html has no Content-Security-Policy meta tag.')
  process.exit(1)
}
html = html.replace(
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
  cspMeta,
)
if (!html.includes('./tizen.js')) {
  html = html.replace(
    '<script type="module"',
    '<script src="./tizen.js"></script>\n    <script type="module"',
  )
}
fs.writeFileSync(indexPath, html)

console.log('Tizen web app is in tizen/. Open that folder in Tizen Studio and build a signed .wgt.')
