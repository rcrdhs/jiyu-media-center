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
  const master = j.data.sources[0].url
  const masterText = await (
    await fetch(master, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF } })
  ).text()
  const variant = abs(master, firstMedia(masterText))
  const variantText = await (
    await fetch(variant, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF } })
  ).text()
  console.log('variant sample:\n', variantText.slice(0, 600))
  const segRel = firstMedia(variantText)
  const seg = abs(variant, segRel)
  console.log('\nsegRel', segRel)
  console.log('seg', seg)

  // Try appending the same headers blob the master uses
  const masterHeaders = new URL(master).searchParams.get('headers')
  console.log('master headers param', masterHeaders)

  const candidates = [seg]
  if (seg && masterHeaders && !seg.includes('headers=')) {
    const u = new URL(seg)
    u.searchParams.set('headers', masterHeaders)
    candidates.push(u.toString())
  }
  // Also try tiki/mov referers in headers param
  if (seg) {
    const u = new URL(seg)
    u.searchParams.set(
      'headers',
      JSON.stringify({ Origin: 'https://tiki.aether.cx', Referer: 'https://tiki.aether.cx/' }),
    )
    candidates.push(u.toString())
    const u2 = new URL(seg)
    u2.searchParams.set(
      'headers',
      JSON.stringify({ Origin: 'https://mov3.4pa.top', Referer: 'https://mov3.4pa.top/' }),
    )
    candidates.push(u2.toString())
  }

  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', Referer: REF },
        signal: AbortSignal.timeout(15000),
      })
      const b = Buffer.from(await r.arrayBuffer())
      console.log(
        JSON.stringify({
          status: r.status,
          bytes: b.length,
          body: b.slice(0, 40).toString('utf8'),
          url: url.slice(0, 140),
        }),
      )
    } catch (e) {
      console.log('ERR', e.message, url.slice(0, 100))
    }
  }
}

main().catch(console.error)
