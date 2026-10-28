#!/usr/bin/env node
/**
 * Release step: stage the universal (arm64 + armv7) TV APK under the fixed,
 * version-less asset name `Jiyu-TV.apk`, and advertise it in latest-android.yml.
 *
 *   node scripts/stage-tv-apk.mjs [--version 0.3.89] [--upload F:\Jiyu\pack-out\0.3.89\upload]
 *                                 [--apk android\app\build\outputs\apk\release\Jiyu-0.3.89-universal.apk]
 *
 * Run AFTER latest-android.yml (arm64 path/sha256/size) is written. It only
 * APPENDS universalPath / universalSha256 / universalSize — the phone arm64
 * `path`/`sha256` keys stay exactly as they were (older apps ignore extra keys).
 * Re-running replaces the previous universal* lines. Output is UTF-8 without BOM.
 *
 * https://jiyu.free-river.workers.dev/tv redirects to releases/latest/download/Jiyu-TV.apk.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const version =
  opt('version') || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const upload = opt('upload') || path.join('F:\\Jiyu\\pack-out', version, 'upload')
const apk =
  opt('apk') ||
  path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', `Jiyu-${version}-universal.apk`)
const TV_ASSET = 'Jiyu-TV.apk'

function die(msg) {
  console.error(`stage-tv-apk: ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(apk)) {
  die(`universal APK not found: ${apk}\n  build it with: cd android && gradlew assembleRelease -PjiyuUniversal=true`)
}
const feedFile = path.join(upload, 'latest-android.yml')
if (!fs.existsSync(feedFile)) die(`missing ${feedFile} (write the arm64 feed first)`)

let feed = fs.readFileSync(feedFile, 'utf8').replace(/^\uFEFF/, '')
const feedVersion = /^version:\s*['"]?([^'"\r\n]+)/m.exec(feed)?.[1]?.trim()
if (feedVersion !== version) die(`latest-android.yml is for ${feedVersion}, not ${version}`)
const armPath = /^path:\s*['"]?([^'"\r\n]+)/m.exec(feed)?.[1]?.trim()
if (!armPath || /universal/i.test(armPath)) die(`latest-android.yml path must stay the arm64 APK (got ${armPath})`)

const dest = path.join(upload, TV_ASSET)
fs.copyFileSync(apk, dest)
const buf = fs.readFileSync(dest)
const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

feed = feed
  .split(/\r?\n/)
  .filter((l) => !/^universal(Path|Sha256|Size):/.test(l))
  .join('\n')
  .replace(/\n*$/, '\n')
feed += `universalPath: ${TV_ASSET}\nuniversalSha256: ${sha256}\nuniversalSize: ${buf.length}\n`
fs.writeFileSync(feedFile, feed, { encoding: 'utf8' })

console.log(`staged ${dest} (${buf.length} bytes, sha256 ${sha256})`)
console.log(`updated ${feedFile}:\n${feed}`)
