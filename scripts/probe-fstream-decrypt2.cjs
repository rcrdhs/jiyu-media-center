/**
 * Find AES keys in fstream script and decrypt captured sources.
 */
const fs = require('fs')
const vm = require('vm')
const https = require('https')

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    }).on('error', reject)
  })
}

;(async () => {
  const hits = JSON.parse(fs.readFileSync('D:/app/scripts/fstream-all-hits.json', 'utf8'))
  const row = hits.find((h) => h.url.includes('getSources/') && h.body.includes('sources'))
  const payload = JSON.parse(row.body)
  const enc = JSON.parse(Buffer.from(payload.sources, 'base64').toString('utf8'))
  console.log('enc', { iv: enc.iv, s: enc.s, ct: enc.ct.slice(0, 40) })

  // Parse URL params from the working request
  const u = new URL(row.url)
  const idHex = u.searchParams.get('id')
  const hHex = u.searchParams.get('h')
  const a = u.searchParams.get('a')
  const t = u.searchParams.get('t')
  const idPlain = Buffer.from(idHex, 'hex').toString('utf8')
  const hPlain = Buffer.from(hHex, 'hex').toString('utf8')
  console.log({ idPlain: idPlain.slice(0, 60), hPlain, a, t })

  const cryptoJs = await fetchText(
    'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.0.0/crypto-js.min.js',
  )
  const sandbox = { console }
  vm.createContext(sandbox)
  vm.runInContext(cryptoJs, sandbox)
  const CryptoJS = sandbox.CryptoJS

  function tryDecrypt(passphrase) {
    try {
      const decrypted = CryptoJS.AES.decrypt(enc.ct, passphrase, {
        iv: CryptoJS.enc.Hex.parse(enc.iv),
        salt: CryptoJS.enc.Hex.parse(enc.s),
        format: CryptoJS.format.OpenSSL, // may be wrong
      })
      // Proper CryptoJSAesJson style:
    } catch {}
    try {
      const cipherParams = CryptoJS.lib.CipherParams.create({
        ciphertext: CryptoJS.enc.Base64.parse(enc.ct),
        iv: CryptoJS.enc.Hex.parse(enc.iv),
        salt: CryptoJS.enc.Hex.parse(enc.s),
      })
      const key = CryptoJS.EvpKDF(passphrase, cipherParams.salt, { keySize: 8, iterations: 1 })
      // Actually CryptoJS.AES.decrypt with passphrase uses OpenSSL KDF when salt present
      const out = CryptoJS.AES.decrypt(
        { ciphertext: CryptoJS.enc.Base64.parse(enc.ct), salt: CryptoJS.enc.Hex.parse(enc.s) },
        passphrase,
      )
      const text = out.toString(CryptoJS.enc.Utf8)
      if (text && text.length > 10) return text
    } catch (e) {
      return null
    }
    try {
      const out = CryptoJS.AES.decrypt(
        JSON.stringify(enc),
        passphrase,
        {
          format: {
            stringify() {},
            parse(str) {
              const obj = typeof str === 'string' ? JSON.parse(str) : str
              const cp = CryptoJS.lib.CipherParams.create({
                ciphertext: CryptoJS.enc.Base64.parse(obj.ct),
              })
              if (obj.iv) cp.iv = CryptoJS.enc.Hex.parse(obj.iv)
              if (obj.s) cp.salt = CryptoJS.enc.Hex.parse(obj.s)
              return cp
            },
          },
        },
      )
      const text = out.toString(CryptoJS.enc.Utf8)
      if (text && text.length > 10) return text
    } catch {}
    return null
  }

  const candidates = [
    hPlain,
    a,
    t,
    idPlain,
    a + t,
    t + a,
    hPlain + a,
    'https://fstream365.com',
    'fstream365',
    // common megacloud-style
    '25742532543745305e5e5466217a4c546c2160296f546c',
  ]

  // Extract long hex strings from player script as potential keys
  const js = fs.readFileSync('D:/app/scripts/fstream-script.min.js', 'utf8')
  const hexes = [...js.matchAll(/['\"]([a-f0-9]{32,64})['\"]/gi)].map((m) => m[1])
  candidates.push(...new Set(hexes))

  for (const key of candidates) {
    const text = tryDecrypt(key)
    if (text) {
      console.log('SUCCESS key', key.slice(0, 40))
      console.log(text.slice(0, 500))
      return
    }
  }
  console.log('no decrypt; tried', candidates.length, 'keys')

  // Try a as hex passphrase
  for (const key of [a, t]) {
    const asUtf = key
    const asHexParsed = CryptoJS.enc.Hex.parse(key)
    try {
      const out = CryptoJS.AES.decrypt(
        { ciphertext: CryptoJS.enc.Base64.parse(enc.ct), iv: CryptoJS.enc.Hex.parse(enc.iv) },
        asHexParsed,
        { iv: CryptoJS.enc.Hex.parse(enc.iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
      )
      const text = out.toString(CryptoJS.enc.Utf8)
      if (text) console.log('raw key success', key, text.slice(0, 300))
    } catch {}
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
