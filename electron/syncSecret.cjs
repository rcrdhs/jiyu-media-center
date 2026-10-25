/**
 * Continue-watching sync device token (desktop).
 *
 * The renderer never keeps the token in localStorage: it lives in
 * <userData>/sync-token.bin, encrypted with Electron safeStorage (DPAPI on Windows) when
 * available — same JYE1 / JYP1 file format as the bilibili.tv session. Never logged.
 */
const fs = require('fs')
const path = require('path')
const { app, ipcMain, safeStorage } = require('electron')

const TOKEN_RE = /^jys_[A-Za-z0-9_-]{40,128}$/

function tokenFile() {
  return path.join(app.getPath('userData'), 'sync-token.bin')
}

function canEncrypt() {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable())
  } catch {
    return false
  }
}

function readToken() {
  try {
    const buf = fs.readFileSync(tokenFile())
    const tag = buf.subarray(0, 4).toString('latin1')
    const body = buf.subarray(4)
    let token = ''
    if (tag === 'JYE1') token = safeStorage.decryptString(body)
    else if (tag === 'JYP1') token = body.toString('utf8')
    return TOKEN_RE.test(token) ? token : null
  } catch {
    return null
  }
}

function writeToken(token) {
  const encrypted = canEncrypt()
  const body = encrypted ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')
  const file = tokenFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(encrypted ? 'JYE1' : 'JYP1', 'latin1'), body]), {
    mode: 0o600,
  })
  fs.renameSync(tmp, file)
  return encrypted
}

function clearToken() {
  try {
    fs.unlinkSync(tokenFile())
  } catch {
    /* already gone */
  }
}

function registerSyncSecretIpc() {
  ipcMain.handle('sync:secretGet', async () => {
    const token = readToken()
    return { token, encrypted: token ? canEncrypt() : false }
  })
  ipcMain.handle('sync:secretSet', async (_event, token) => {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, encrypted: false }
    const encrypted = writeToken(token)
    return { ok: true, encrypted }
  })
  ipcMain.handle('sync:secretClear', async () => {
    clearToken()
    return { ok: true }
  })
}

module.exports = { registerSyncSecretIpc }
