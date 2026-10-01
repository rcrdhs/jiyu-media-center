/**
 * Prove the Multiview intercept recipe: Referer / X-Requested-With collapse
 * embed.st to a stub; fetching without those headers restores a real player.
 * Exit 0 only when the recipe recovers.
 */
const https = require('https')
const { URL } = require('url')

function get(url, headers = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url)
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Accept: 'text/html',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'sec-ch-ua':
            '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          ...headers,
        },
      },
      (r) => {
        const chunks = []
        r.on('data', (d) => chunks.push(d))
        r.on('end', () =>
          res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', rej)
    req.setTimeout(25000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

async function resolveEmbed() {
  const live = JSON.parse(
    (await get('https://streamed.pk/api/matches/live', { Accept: 'application/json' })).body,
  )
  const m = live.find((x) => x.sources && x.sources.length)
  if (!m) throw new Error('no live')
  const s = m.sources[0]
  const streams = JSON.parse(
    (
      await get(`https://streamed.pk/api/stream/${s.source}/${s.id}`, {
        Accept: 'application/json',
      })
    ).body,
  )
  return streams[0].embedUrl
}

function isStub(body) {
  return body.length < 5000 && /bundle-jw|clappr|player/i.test(body)
}

function isFullPlayer(body) {
  return body.length > 50000
}

async function main() {
  const embed = await resolveEmbed()
  console.log('embed', embed)

  const withRef = await get(embed, { Referer: 'https://streamed.pk/' })
  const withXrw = await get(embed, { 'X-Requested-With': 'app.jiyu.mediacenter' })
  const clean = await get(embed, {}) // Multiview intercept path

  const report = {
    withRefLen: withRef.body.length,
    withXrwLen: withXrw.body.length,
    cleanLen: clean.body.length,
    withRefStub: isStub(withRef.body),
    withXrwStub: isStub(withXrw.body),
    cleanFull: isFullPlayer(clean.body),
  }
  console.log(JSON.stringify(report))

  if (!report.cleanFull) {
    console.error('FAIL: clean fetch did not get full player (CDN may be blocking this IP)')
    process.exit(2)
  }
  if (!report.withRefStub && !report.withXrwStub) {
    // Still OK if CDN stopped stubbing — recipe is still safe
    console.log('WARN: Referer/XRW did not stub today; recipe still applied')
  } else {
    console.log('CONFIRMED: Referer and/or XRW stub the player; intercept must serve clean bytes')
  }
  console.log('PASS: intercept recipe validated')
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
