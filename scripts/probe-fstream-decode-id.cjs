/**
 * Figure out working getSources id encoding + decrypt with CryptoJS from CDN.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const BASE = 'https://fstream365.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const fs = require('fs')
const vm = require('vm')

;(async () => {
  const servers = await fetch(`${ORIGIN}/ajax/movie/episode/servers/s6ptq_1_1`, {
    headers: { 'User-Agent': UA, Referer: ORIGIN },
  }).then((r) => r.json())
  const token = servers.html.match(/data-id="([^"]+)"/)[1]
  const name = servers.html.match(/data-name="(\d+)"/)[1]
  const embed = (
    await fetch(`${ORIGIN}/ajax/movie/episode/server/sources/${token}_${name}`, {
      headers: { 'User-Agent': UA, Referer: ORIGIN },
    }).then((r) => r.json())
  ).src
  console.log('embed', embed.slice(0, 100))

  const html = await fetch(embed, { headers: { 'User-Agent': UA, Referer: ORIGIN } }).then((r) =>
    r.text(),
  )
  const cfg = JSON.parse(html.match(/window\.vConfig\s*=\s*(\{[\s\S]*?\});/)[1])
  console.log('vConfig.id', cfg.id)
  console.log('vConfig.hash', cfg.hash)
  console.log('vConfig.mid', cfg.mid, Buffer.from(cfg.mid, 'base64').toString())

  // hex of id?
  const hexId = Buffer.from(cfg.id, 'utf8').toString('hex')
  console.log('utf8hex(id)', hexId.slice(0, 80))

  // Working id from prior capture (may be stale) — decode as hex
  const media = JSON.parse(fs.readFileSync('D:/app/scripts/fstream-media.json', 'utf8'))
  const hit = media.find((h) => h.url && h.url.includes('getSources/') && h.body)
  console.log('captured url', hit?.url)
  const workingId = hit?.url?.match(/id=([^&]+)/)?.[1]
  console.log('workingId', workingId)
  if (workingId) {
    try {
      console.log('hex decode', Buffer.from(workingId, 'hex').toString('utf8'))
    } catch (e) {
      console.log('not hex', e.message)
    }
  }

  // Trailing-slash endpoint with vConfig.id
  for (const id of [cfg.id, hexId, cfg.mid, Buffer.from(cfg.mid, 'base64').toString()]) {
    const url = `${BASE}/ajax/getSources/?id=${encodeURIComponent(id)}`
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: embed,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    })
    const t = await r.text()
    console.log('try', id.slice(0, 40), r.status, t.length, t.slice(0, 120))
  }

  // Load crypto-js and try decrypt captured body
  if (hit?.body) {
    const cryptoJs = await fetch(
      'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.0.0/crypto-js.min.js',
    ).then((r) => r.text())
    const sandbox = { console, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Buffer }
    vm.createContext(sandbox)
    vm.runInContext(cryptoJs, sandbox)
    const CryptoJS = sandbox.CryptoJS
    const payload = JSON.parse(hit.body)
    console.log('payload keys', Object.keys(payload))
    // sources is base64 JSON of {ct, iv, s}
    const enc = JSON.parse(Buffer.from(payload.sources, 'base64').toString())
    console.log('enc keys', Object.keys(enc), 'ct len', enc.ct?.length)

    // try hash as passphrase
    for (const key of [cfg.hash, cfg.id, cfg.mid, '9f3e2d1c', Buffer.from(cfg.mid, 'base64').toString()]) {
      try {
        const decrypted = CryptoJS.AES.decrypt(JSON.stringify(enc), key, {
          format: {
            parse: (str) => {
              const obj = typeof str === 'string' ? JSON.parse(str) : str
              const cipherParams = CryptoJS.lib.CipherParams.create({
                ciphertext: CryptoJS.enc.Base64.parse(obj.ct),
              })
              if (obj.iv) cipherParams.iv = CryptoJS.enc.Hex.parse(obj.iv)
              if (obj.s) cipherParams.salt = CryptoJS.enc.Hex.parse(obj.s)
              return cipherParams
            },
          },
        })
        const text = decrypted.toString(CryptoJS.enc.Utf8)
        if (text) console.log('DECRYPTED with', key.slice(0, 30), text.slice(0, 300))
      } catch (e) {
        /* ignore */
      }
    }
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
