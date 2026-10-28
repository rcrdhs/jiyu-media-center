/**
 * Samsung TV (.wgt) packaging. Run via `npm run pack:tizen` (or `pack:tizen:wgt`).
 *
 * 1. `vite build --mode tizen` has written dist-tizen/ (one classic IIFE bundle,
 *    chrome69 target — see vite.config.ts).
 * 2. This copies it into tizen/ (keeps config.xml, project files, tizen.js,
 *    polyfills.js, icon.png), loads polyfills.js + tizen.js first, turns the
 *    bundle tag into a plain deferred script (Tizen refuses type="module" from
 *    the package), and stamps package.json's version into config.xml.
 * 3. `--wgt [--profile NAME]`: also runs the Tizen Studio CLI (build-web +
 *    package) with that security profile. Without a Samsung distributor
 *    certificate that holds the TV's DUID, the .wgt only installs on the
 *    emulator; see docs/install-tvs.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const tizenDir = path.join(root, 'tizen')
const distDir = path.join(root, 'dist-tizen')
const keep = new Set(['config.xml', '.project', '.tproject', 'tizen.js', 'polyfills.js', 'icon.png'])
const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const csp = [
  "default-src 'self' https: http: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https: http:",
  'media-src * blob: data:',
  'connect-src * data: blob:',
  'worker-src * blob:',
  'frame-src *',
  'child-src * blob:',
].join('; ')

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  fail('dist-tizen/index.html is missing. Run `npm run build:tizen` first (npm run pack:tizen does both).')
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
if (!html.includes('Content-Security-Policy')) {
  fail('Built index.html has no Content-Security-Policy meta tag.')
}
html = html.replace(
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
  `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
)
// Absolute favicon path breaks inside the package.
html = html.replace(/href="\/jiyu-logo\.png"/, 'href="./jiyu-logo.png"')
// No modulepreload / module scripts inside a .wgt.
html = html.replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
const bundles = []
html = html.replace(/\s*<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
  if (/tizen\.js|polyfills\.js/.test(src)) return ''
  bundles.push(src)
  return ''
})
if (bundles.length !== 1) fail(`Expected one app bundle in index.html, found ${bundles.length}: ${bundles.join(', ')}`)
const bundlePath = path.join(tizenDir, bundles[0].replace(/^\.\//, ''))
if (!fs.existsSync(bundlePath)) fail(`Bundle missing: ${bundlePath}`)
const head = fs.readFileSync(bundlePath, 'utf8').slice(0, 4000)
if (/^\s*import[\s{*]/m.test(head) || /\bexport\s*\{/.test(head.slice(0, 200))) {
  fail('Bundle still looks like an ES module; check the tizen build mode in vite.config.ts.')
}
// Classic scripts, in order. The bundle is deferred so #root exists when it runs.
html = html.replace(
  '</head>',
  `    <script src="./polyfills.js"></script>\n    <script src="./tizen.js"></script>\n    <script defer src="${bundles[0]}"></script>\n  </head>`,
)
fs.writeFileSync(indexPath, html)

// config.xml version = package.json version (Tizen: x.y.z, x/y <= 255, z <= 65535).
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const configPath = path.join(tizenDir, 'config.xml')
let config = fs.readFileSync(configPath, 'utf8')
config = config.replace(/(<widget\b[^>]*\bversion=")[^"]*(")/, `$1${version}$2`)
fs.writeFileSync(configPath, config)

console.log(`Tizen web app ${version} is in tizen/ (bundle ${bundles[0]}).`)

if (!args.includes('--wgt')) {
  console.log('Open tizen/ in Tizen Studio and build a signed .wgt, or run: npm run pack:tizen:wgt')
  process.exit(0)
}

// ---- Optional: Tizen Studio CLI build + package.
const studio = process.env.TIZEN_STUDIO || 'F:\\Jiyu\\tizen-studio'
const cli = path.join(studio, 'tools', 'ide', 'bin', process.platform === 'win32' ? 'tizen.bat' : 'tizen')
if (!fs.existsSync(cli)) fail(`Tizen CLI not found at ${cli} (set TIZEN_STUDIO).`)
const profile = argValue('--profile') || process.env.TIZEN_PROFILE
const run = (cliArgs) => {
  // tizen.bat needs a shell on Windows; pass one pre-quoted command line.
  const r =
    process.platform === 'win32'
      ? spawnSync([cli, ...cliArgs].map((a) => `"${a}"`).join(' '), { stdio: 'inherit', shell: true })
      : spawnSync(cli, cliArgs, { stdio: 'inherit' })
  if (r.status !== 0) fail(`tizen ${cliArgs.join(' ')} failed (${r.status}).`)
}
const out = path.join(tizenDir, '.buildResult')
fs.rmSync(out, { recursive: true, force: true })
run(['build-web', '-out', '.buildResult', '--', tizenDir])
const pkgArgs = ['package', '-t', 'wgt']
if (profile) pkgArgs.push('-s', profile)
pkgArgs.push('-o', root, '--', out)
run(pkgArgs)
console.log(`Wrote Jiyu.wgt to ${root} (profile ${profile || 'active'}).`)
