/**
 * Stamp roku/source/config.brs with this PC's LAN IP, then zip the channel.
 * Output: release/jiyu-roku.zip
 *
 *   ROKU_HLS_BASE=http://192.168.1.10:8791 npm run pack:roku
 *   ROKU_HLS_TOKEN=secret npm run pack:roku
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const rokuDir = path.join(root, 'roku')
const configPath = path.join(rokuDir, 'source', 'config.brs')
const outDir = path.join(root, 'release')
const outZip = path.join(outDir, 'jiyu-roku.zip')
const PORT = Number(process.env.ROKU_HLS_PORT || 8791)

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function lanIPv4() {
  const nets = os.networkInterfaces()
  const preferred = []
  const rest = []
  for (const list of Object.values(nets)) {
    if (!list) continue
    for (const n of list) {
      if (n.family !== 'IPv4' && n.family !== 4) continue
      if (n.internal) continue
      if (n.address.startsWith('169.254.')) continue
      if (n.address.startsWith('192.168.') || n.address.startsWith('10.')) {
        preferred.push(n.address)
      } else {
        rest.push(n.address)
      }
    }
  }
  return preferred[0] || rest[0] || '127.0.0.1'
}

function stampConfig() {
  const base =
    String(process.env.ROKU_HLS_BASE || '').trim() || `http://${lanIPv4()}:${PORT}`
  const token = String(process.env.ROKU_HLS_TOKEN || '').trim()
  const body = `' Stamped by npm run pack:roku — ${new Date().toISOString()}
' Override with ROKU_HLS_BASE / ROKU_HLS_TOKEN when packing.
function rokuHlsBase() as string
  return "${base.replace(/\\/g, '\\\\').replace(/"/g, '""')}"
end function

function rokuHlsToken() as string
  return "${token.replace(/\\/g, '\\\\').replace(/"/g, '""')}"
end function
`
  fs.writeFileSync(configPath, body)
  return { base, token: Boolean(token) }
}

if (!fs.existsSync(path.join(rokuDir, 'manifest'))) fail('roku/manifest missing')
if (!fs.existsSync(path.join(rokuDir, 'source', 'main.brs'))) {
  fail('roku/source/main.brs missing')
}

const stamped = stampConfig()
console.log(`[pack:roku] rokuHlsBase = ${stamped.base}`)
if (stamped.token) console.log('[pack:roku] token stamped')

fs.mkdirSync(outDir, { recursive: true })
if (fs.existsSync(outZip)) fs.rmSync(outZip)

// Compress-Archive uses backslash paths; Roku then fails with
// "Script directory /source does not exist in plugin."
const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${rokuDir.replace(/'/g, "''")}'
$dst = '${outZip.replace(/'/g, "''")}'
if (Test-Path $dst) { Remove-Item $dst -Force }
$zip = [System.IO.Compression.ZipFile]::Open($dst, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\\').Replace('\\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
}
Write-Output $dst
(Get-Item $dst).Length
`

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-Command', ps],
  { encoding: 'utf8' },
)
if (result.status !== 0) {
  fail(result.stderr || result.stdout || 'Compress-Archive failed')
}
console.log(result.stdout.trim())
console.log('1) npm run roku-hls   2) sideload release/jiyu-roku.zip  (docs/install-tvs.md)')
