/**
 * Mirror agent file edits between D:\app and E:\jiyu\app.
 * Triggered by Cursor afterFileEdit; fail-open on errors.
 */
const fs = require('fs')
const path = require('path')

const ROOTS = ['D:\\app', 'E:\\jiyu\\app']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release'])

function normalize(p) {
  return path.resolve(p)
}

function matchRoot(filePath) {
  const resolved = normalize(filePath)
  for (const root of ROOTS) {
    const r = normalize(root)
    const rel = path.relative(r, resolved)
    if (rel === '') continue
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { root: r, rel }
    }
  }
  return null
}

function shouldSkip(rel) {
  return rel.split(path.sep).some((part) => SKIP_DIRS.has(part))
}

function readStdin() {
  return new Promise((resolve) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', () => resolve(input))
  })
}

async function main() {
  try {
    const raw = await readStdin()
    const payload = JSON.parse(raw || '{}')
    const filePath = payload.file_path
    if (!filePath || !fs.existsSync(filePath)) return

    const info = matchRoot(filePath)
    if (!info || shouldSkip(info.rel)) return

    for (const root of ROOTS) {
      const r = normalize(root)
      if (r.toLowerCase() === info.root.toLowerCase()) continue
      if (!fs.existsSync(r)) continue

      const dest = path.join(r, info.rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(filePath, dest)
      console.error(`[mirror-twin] ${filePath} -> ${dest}`)
    }
  } catch (err) {
    console.error('[mirror-twin]', err && err.message ? err.message : err)
  }
}

void main()
