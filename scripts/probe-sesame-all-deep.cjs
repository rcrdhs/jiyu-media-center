const REF = 'https://rivestream.ru/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const PROVIDERS = [
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

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}
function firstMedia(text) {
  return lines(text).find((l) => !l.startsWith('#')) || null
}
function abs(base, rel) {
  if (!rel) return null
  return /^https?:\/\//i.test(rel) ? rel : new URL(rel, base).toString()
}

async function deepHlsOk(masterUrl) {
  const mt = await (
    await fetch(masterUrl, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF },
      signal: AbortSignal.timeout(8000),
    })
  ).text()
  if (!/#EXTM3U/i.test(mt)) return { ok: false, step: 'master-not-m3u8' }
  let mediaUrl = abs(masterUrl, firstMedia(mt))
  if (!mediaUrl) return { ok: false, step: 'no-variant' }
  // If master is a media playlist (has EXTINF), mediaUrl is already a segment.
  const isMaster = /#EXT-X-STREAM-INF/i.test(mt)
  if (isMaster) {
    const vtRes = await fetch(mediaUrl, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF },
      signal: AbortSignal.timeout(8000),
    })
    const vt = await vtRes.text()
    if (!/#EXTM3U/i.test(vt)) return { ok: false, step: 'variant-not-m3u8', status: vtRes.status }
    mediaUrl = abs(mediaUrl, firstMedia(vt))
    if (!mediaUrl) return { ok: false, step: 'no-segment' }
  }
  const segRes = await fetch(mediaUrl, {
    headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF },
    signal: AbortSignal.timeout(10000),
  })
  const buf = Buffer.from(await segRes.arrayBuffer())
  const sample = buf.slice(0, 64).toString('utf8')
  const looksVideo =
    segRes.ok &&
    buf.length > 188 &&
    !/^<!doctype|^<html|Upstream error|Forbidden|unauthorized/i.test(sample)
  return {
    ok: looksVideo,
    step: 'segment',
    status: segRes.status,
    bytes: buf.length,
    sample: sample.slice(0, 40),
    segHost: (() => {
      try {
        return new URL(mediaUrl).host
      } catch {
        return ''
      }
    })(),
  }
}

async function main() {
  for (const name of PROVIDERS) {
    const res = await fetch(
      `https://scrapper.rivestream.app/api/provider?provider=${name}&id=502&season=1&episode=1`,
      {
        headers: {
          Accept: 'application/json',
          Referer: REF,
          Origin: 'https://rivestream.ru',
          'User-Agent': UA,
        },
      },
    )
    const j = await res.json()
    const sources = j?.data?.sources || []
    if (!sources.length) {
      console.log(name, 'empty')
      continue
    }
    for (const s of sources.slice(0, 2)) {
      const url = s.url || ''
      const kind =
        String(s.format || s.quality || '').toLowerCase() === 'hls' || /m3u8-proxy|\.m3u8/i.test(url)
          ? 'hls'
          : /\.mp4|\/proxy\?/i.test(url)
            ? 'mp4'
            : 'other'
      if (kind === 'hls') {
        try {
          const deep = await deepHlsOk(url)
          console.log(JSON.stringify({ provider: name, kind, quality: s.quality, ...deep }))
        } catch (e) {
          console.log(JSON.stringify({ provider: name, kind, quality: s.quality, err: e.message }))
        }
      } else if (kind === 'mp4') {
        try {
          const r = await fetch(url, {
            headers: {
              'User-Agent': UA,
              Accept: '*/*',
              Referer: REF,
              Range: 'bytes=0-1023',
            },
            signal: AbortSignal.timeout(10000),
          })
          const b = Buffer.from(await r.arrayBuffer())
          console.log(
            JSON.stringify({
              provider: name,
              kind,
              quality: s.quality,
              status: r.status,
              bytes: b.length,
              sample: b.slice(0, 30).toString('utf8'),
            }),
          )
        } catch (e) {
          console.log(JSON.stringify({ provider: name, kind, err: e.message }))
        }
      } else {
        console.log(JSON.stringify({ provider: name, kind, quality: s.quality, url: url.slice(0, 80) }))
      }
    }
  }
}

main().catch(console.error)
