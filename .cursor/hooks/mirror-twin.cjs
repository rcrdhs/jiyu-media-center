/**
 * Mirror agent file edits between D:\app and E:\jiyu\app.
 *
 * Cursor afterFileEdit often sends a relative file_path (e.g. "src/foo.ts").
 * The old hook required an absolute path that already existed on disk as given,
 * so relative payloads silently no-op'd and E drifted for months.
 *
 * Also handles postToolUse Write/StrReplace payloads as a backup.
 * Fail-open on all errors.
 */
const fs = require('fs')
const path = require('path')

const ROOTS = ['D:\\app', 'E:\\jiyu\\app']
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  'android\\app\\build',
  'android\\build',
  '.gradle',
])
const LOG = path.join(__dirname, 'mirror-twin.log')

function normalize(p) {
  return path.resolve(p)
}

function log(line) {
  try {
    const stamp = new Date().toISOString()
    fs.appendFileSync(LOG, `[${stamp}] ${line}\n`, 'utf8')
  } catch {
    /* ignore */
  }
  try {
    console.error(`[mirror-twin] ${line}`)
  } catch {
    /* ignore */
  }
}

function shouldSkip(rel) {
  const parts = rel.split(/[/\\]/)
  if (parts.some((part) => SKIP_DIRS.has(part))) return true
  const joined = parts.join('\\').toLowerCase()
  return (
    joined.startsWith('android\\app\\build\\') ||
    joined.startsWith('android\\build\\') ||
    joined.startsWith('release\\')
  )
}

function candidateRoots(payload) {
  const roots = []
  const workspaceRoots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots
    : []
  for (const wr of workspaceRoots) {
    if (wr) roots.push(normalize(wr))
  }
  for (const r of ROOTS) roots.push(normalize(r))
  try {
    roots.push(normalize(process.cwd()))
  } catch {
    /* ignore */
  }
  return [...new Set(roots.map((r) => r.toLowerCase()))].map((lower) => {
    return (
      ROOTS.map(normalize).find((r) => r.toLowerCase() === lower) ||
      workspaceRoots.map(normalize).find((r) => r.toLowerCase() === lower) ||
      normalize(lower)
    )
  })
}

function resolveEditedFile(payload) {
  const raw =
    payload.file_path ||
    payload.filePath ||
    payload.path ||
    payload?.tool_input?.path ||
    payload?.tool_input?.file_path ||
    payload?.tool_input?.target_notebook ||
    null

  if (!raw || typeof raw !== 'string') return null

  // Absolute and present.
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return normalize(raw)

  // Absolute missing — still return so callers can see the miss.
  if (path.isAbsolute(raw)) {
    const abs = normalize(raw)
    if (fs.existsSync(abs)) return abs
  }

  // Relative: try workspace roots + twin roots + cwd.
  for (const root of candidateRoots(payload)) {
    const abs = normalize(path.join(root, raw))
    if (fs.existsSync(abs)) return abs
  }

  // Last resort: as-given relative to cwd.
  try {
    const abs = normalize(raw)
    if (fs.existsSync(abs)) return abs
  } catch {
    /* ignore */
  }
  return null
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

function mirrorFile(filePath) {
  const info = matchRoot(filePath)
  if (!info) {
    log(`skip outside twins: ${filePath}`)
    return 0
  }
  if (shouldSkip(info.rel)) {
    log(`skip filtered: ${info.rel}`)
    return 0
  }

  let copied = 0
  for (const root of ROOTS) {
    const r = normalize(root)
    if (r.toLowerCase() === info.root.toLowerCase()) continue
    if (!fs.existsSync(r)) {
      log(`twin missing: ${r}`)
      continue
    }
    const dest = path.join(r, info.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(filePath, dest)
    log(`${filePath} -> ${dest}`)
    copied += 1
  }
  return copied
}

function decodeHookStdin(buf) {
  if (!buf || buf.length === 0) return '{}'
  // Cursor on Windows has sent UTF-16LE (BOM FF FE) and UTF-8 BOM — both break JSON.parse.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Rare UTF-16BE
    const swapped = Buffer.alloc(buf.length - 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return swapped.toString('utf16le')
  }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // Heuristic: lots of NULs → treat as UTF-16LE without BOM
  const nuls = (text.match(/\u0000/g) || []).length
  if (nuls > text.length / 4) {
    text = buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  return text.replace(/^\uFEFF/, '')
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)))
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)))
    // Hooks sometimes close stdin without end on Windows — don't hang forever.
    setTimeout(() => resolve(Buffer.concat(chunks)), 2000)
  })
}

async function main() {
  try {
    const buf = await readStdin()
    const raw = decodeHookStdin(buf)
    const payload = JSON.parse(raw || '{}')
    const event = payload.hook_event_name || payload.event || 'unknown'

    // postToolUse backup: only care about write-like tools.
    if (event === 'postToolUse' || payload.tool_name || payload.toolName) {
      const tool = String(payload.tool_name || payload.toolName || '')
      if (tool && !/^(Write|StrReplace|EditNotebook|Delete|DeleteFile|TabWrite)$/i.test(tool)) {
        return
      }
    }

    const filePath = resolveEditedFile(payload)
    if (!filePath) {
      log(
        `no resolvable file (event=${event} raw=${JSON.stringify(
          payload.file_path || payload?.tool_input?.path || null,
        )})`,
      )
      return
    }
    if (!fs.existsSync(filePath)) {
      log(`missing file: ${filePath}`)
      return
    }

    mirrorFile(filePath)
  } catch (err) {
    log(err && err.message ? err.message : String(err))
  }
}

void main()
