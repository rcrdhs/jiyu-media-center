const REF = 'https://rivestream.ru/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function provider(name) {
  const url =
    `https://scrapper.rivestream.app/api/provider?provider=${name}` +
    `&id=502&season=1&episode=1`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Referer: REF,
      Origin: 'https://rivestream.ru',
      'User-Agent': UA,
    },
  })
  return res.json()
}

function firstMediaLine(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !line.startsWith('#')) return line
  }
  return null
}

function absolutize(base, maybeRelative) {
  if (!maybeRelative) return null
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative
  return new URL(maybeRelative, base).toString()
}

async function main() {
  const j = await provider('pulse')
  const master = j?.data?.sources?.[0]?.url
  if (!master) {
    console.log('no pulse source', JSON.stringify(j).slice(0, 300))
    return
  }
  console.log('master', master.slice(0, 120))

  for (const origin of ['http://localhost:5173', 'https://rivestream.ru']) {
    const res = await fetch(master, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: REF,
        Origin: origin,
      },
    })
    const text = await res.text()
    const variantRel = firstMediaLine(text)
    const variant = absolutize(master, variantRel)
    console.log(
      JSON.stringify({
        origin,
        masterStatus: res.status,
        acao: res.headers.get('access-control-allow-origin'),
        variantRel: (variantRel || '').slice(0, 90),
        variantHost: variant ? new URL(variant).host : null,
      }),
    )
    if (!variant) continue

    const r2 = await fetch(variant, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: REF,
        Origin: origin,
      },
      signal: AbortSignal.timeout(20000),
    })
    const t2 = await r2.text()
    const segRel = firstMediaLine(t2)
    const seg = absolutize(variant, segRel)
    console.log(
      JSON.stringify({
        origin,
        variantStatus: r2.status,
        acao: r2.headers.get('access-control-allow-origin'),
        isM3u: /#EXTM3U/.test(t2),
        segRel: (segRel || '').slice(0, 90),
      }),
    )
    if (!seg) continue

    const r3 = await fetch(seg, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: REF,
        Origin: origin,
      },
      signal: AbortSignal.timeout(20000),
    })
    const buf = Buffer.from(await r3.arrayBuffer())
    console.log(
      JSON.stringify({
        origin,
        segStatus: r3.status,
        acao: r3.headers.get('access-control-allow-origin'),
        bytes: buf.length,
        magic: buf.slice(0, 8).toString('hex'),
      }),
    )
  }

  // Provider probe order simulation: first HLS that returns #EXTM3U within 4.5s
  const order = [
    'apex',
    'solstice',
    'primevids',
    'citadel',
    'flowcast',
    'pulse',
    'quasar',
    'horizon',
    'hindicast',
    'guru',
  ]
  for (const name of order) {
    const data = await provider(name)
    const sources = data?.data?.sources || []
    const hls = sources.find(
      (s) =>
        String(s.format || s.quality || '').toLowerCase() === 'hls' ||
        /\.m3u8|m3u8-proxy/i.test(s.url || ''),
    )
    if (!hls?.url) {
      console.log(name, 'no hls')
      continue
    }
    const t0 = Date.now()
    try {
      const res = await fetch(hls.url, {
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF, Range: 'bytes=0-2047' },
        signal: AbortSignal.timeout(4500),
      })
      const peek = Buffer.from(await res.arrayBuffer()).toString('utf8')
      const ok = res.ok && /#EXTM3U|#EXT-X-/i.test(peek)
      console.log(name, ok ? 'PROBE_OK' : 'PROBE_FAIL', res.status, Date.now() - t0 + 'ms', peek.slice(0, 40).replace(/\n/g, '|'))
      if (ok) {
        console.log('WOULD_SELECT', name)
        break
      }
    } catch (e) {
      console.log(name, 'PROBE_ERR', Date.now() - t0 + 'ms', e.message)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
