const REF = 'https://rivestream.ru/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

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

async function main() {
  const j = await (
    await fetch(
      'https://scrapper.rivestream.app/api/provider?provider=pulse&id=502&season=1&episode=1',
      {
        headers: {
          Accept: 'application/json',
          Referer: REF,
          Origin: 'https://rivestream.ru',
          'User-Agent': UA,
        },
      },
    )
  ).json()
  const master = j?.data?.sources?.[0]?.url
  if (!master) throw new Error('no master')
  const mt = await (
    await fetch(master, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF } })
  ).text()
  const variant = abs(master, firstMedia(mt))
  if (!variant) throw new Error('no variant from master')
  const vt = await (
    await fetch(variant, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF } })
  ).text()
  const segProxy = abs(variant, firstMedia(vt))
  if (!segProxy) throw new Error('no segment from variant')
  const upstream = new URL(segProxy).searchParams.get('url')
  console.log('upstream', upstream)

  for (const h of [
    { Referer: 'https://tiki.aether.cx/', Origin: 'https://tiki.aether.cx' },
    { Referer: 'https://mov3.4pa.top/', Origin: 'https://mov3.4pa.top' },
    { Referer: REF, Origin: 'https://rivestream.ru' },
    { Referer: 'https://proxy.valhallastream.dpdns.org/' },
    {},
  ]) {
    try {
      const r = await fetch(upstream, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...h },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      })
      const b = Buffer.from(await r.arrayBuffer())
      console.log(
        JSON.stringify({
          headers: h,
          status: r.status,
          type: r.headers.get('content-type'),
          bytes: b.length,
          sample: b.slice(0, 40).toString('utf8'),
        }),
      )
    } catch (e) {
      console.log(JSON.stringify({ headers: h, err: e.message }))
    }
  }
}

main().catch(console.error)
