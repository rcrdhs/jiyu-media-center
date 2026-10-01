const fs = require('fs')

async function main() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html',
  }
  const html = await (await fetch('https://zenox.lol/tv?genre=16', { headers })).text()
  fs.writeFileSync('scripts/zenox-anim.html', html)

  // Look for series- IDs / media keys in HTML / RSC
  const seriesIds = [...html.matchAll(/series-(\d+)/g)].map((m) => m[1])
  const mediaKeys = [...html.matchAll(/media=([a-z]+-\d+)/gi)].map((m) => m[1])
  const tmdbPaths = [...html.matchAll(/image\.tmdb\.org\/t\/p\/w500\/([a-zA-Z0-9]+)\.jpg/g)].map(
    (m) => m[1],
  )
  const titles = [...html.matchAll(/<h3[^>]*>([^<]{1,160})<\/h3>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&').trim(),
  )

  // RSC flight data often embeds JSON-ish
  const pushChunks = [...html.matchAll(/self\.__next_f\.push\(\[.*?\]\)/gs)].map((m) => m[0])
  let idInRsc = []
  for (const chunk of pushChunks) {
    idInRsc.push(...[...chunk.matchAll(/"id"\s*:\s*(\d{2,8})/g)].map((m) => m[1]))
    idInRsc.push(...[...chunk.matchAll(/series-(\d+)/g)].map((m) => m[1]))
  }

  console.log(
    JSON.stringify(
      {
        len: html.length,
        titleCount: titles.length,
        titles: titles.slice(0, 25),
        seriesIds: [...new Set(seriesIds)].slice(0, 30),
        mediaKeys: [...new Set(mediaKeys)].slice(0, 30),
        posterCount: tmdbPaths.length,
        rscPushes: pushChunks.length,
        idInRsc: [...new Set(idInRsc)].slice(0, 40),
      },
      null,
      2,
    ),
  )

  // Try catalog API guesses with genre
  for (const path of [
    '/api/catalog/tv?genre=16&page=1',
    '/api/browse/tv?genre=16&page=1',
    '/api/tv?genre=16&page=1',
    '/api/list/tv?genre=16&page=1',
    '/api/search?q=&genre=16&type=tv',
    '/tv?genre=16&page=1&_rsc=1',
  ]) {
    try {
      const r = await fetch('https://zenox.lol' + path, {
        headers: {
          ...headers,
          Accept: path.includes('_rsc') ? 'text/x-component' : 'application/json,text/html',
          RSC: path.includes('_rsc') ? '1' : undefined,
        },
      })
      const t = await r.text()
      console.log(
        JSON.stringify({
          path,
          status: r.status,
          ct: r.headers.get('content-type'),
          sample: t.slice(0, 200).replace(/\s+/g, ' '),
        }),
      )
    } catch (e) {
      console.log(JSON.stringify({ path, error: e.message }))
    }
  }

  // Details sample for classification fields
  const detail = await (
    await fetch('https://zenox.lol/api/details/tv/94664', { headers: { ...headers, Accept: 'application/json' } })
  ).json()
  console.log(
    'detail keys',
    Object.keys(detail.details || {}),
    JSON.stringify(
      {
        genreIds: detail.details?.genreIds,
        genres: detail.details?.genres,
        originCountry: detail.details?.originCountry,
        originalLanguage: detail.details?.originalLanguage,
        mediaType: detail.details?.mediaType,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
