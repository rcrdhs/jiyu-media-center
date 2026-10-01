async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://cinetaro.to/',
    },
    redirect: 'follow',
  })
  const t = await r.text()
  return { status: r.status, t, ct: r.headers.get('content-type') || '' }
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))]
}

function parseList(html) {
  const items = []
  const seen = new Set()
  // Card blocks roughly: href="/details/ID?tv" ... img ... title in <h3> or similar
  const re =
    /href="(\/details\/(\d+)\?tv)"[\s\S]{0,1200}?<(?:img|Image)[^>]+(?:src|data-src)="([^"]+)"[\s\S]{0,800}?<h3[^>]*>\s*([\s\S]*?)<\/h3>/gi
  let m
  while ((m = re.exec(html))) {
    const id = m[2]
    if (seen.has(id)) continue
    seen.add(id)
    const title = m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    items.push({
      tmdbId: id,
      detailPath: m[1],
      detailUrl: `https://cinetaro.to${m[1]}`,
      poster: m[3].startsWith('http') ? m[3] : `https://cinetaro.to${m[3]}`,
      title,
    })
  }
  if (items.length === 0) {
    for (const hit of html.matchAll(/href="\/details\/(\d+)\?tv"/g)) {
      const id = hit[1]
      if (seen.has(id)) continue
      seen.add(id)
      items.push({
        tmdbId: id,
        detailPath: `/details/${id}?tv`,
        detailUrl: `https://cinetaro.to/details/${id}?tv`,
        poster: '',
        title: '',
      })
    }
  }
  const total =
    html.match(/([\d,]+)\s+total results/i)?.[1]?.replace(/,/g, '') ||
    html.match(/page\s+\d+\s+of\s+([\d,]+)/i)?.[1]?.replace(/,/g, '') ||
    null
  return { items, total: total ? Number(total) : null }
}

async function main() {
  const list = await get('https://cinetaro.to/movie/tv-series?page=1')
  console.log('LIST', { status: list.status, len: list.t.length, cf: /just a moment|cf-turnstile/i.test(list.t) })
  const parsed = parseList(list.t)
  console.log('PARSED', { count: parsed.items.length, totalHint: parsed.total, sample: parsed.items.slice(0, 5) })

  const watchUrls = [
    'https://cinetaro.to/watch/97546?tv&s=1&ep=1',
    'https://cinetaro.to/watch/97546?tv&s=1&ep=1&server=1',
    'https://cinetaro.to/details/97546?tv',
  ]
  for (const url of watchUrls) {
    const page = await get(url)
    const title = page.t.match(/<title[^>]*>([^<]+)/i)?.[1]
    const iframes = uniq([...page.t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((x) => x[1]))
    const embeds = uniq([
      ...page.t.matchAll(/https?:\/\/[^"'\\\s]+(?:embed|vidsrc|videasy|vidlink|autoembed|player\.|peestream|vidking)[^"'\\\s]*/gi),
    ].map((x) => x[0]))
    const watchLinks = uniq([...page.t.matchAll(/href=["']([^"']*\/watch\/[^"']+)["']/gi)].map((x) => x[1])).slice(0, 15)
    const dataEmbed = uniq(
      [...page.t.matchAll(/data-(?:src|url|embed|link)=["']([^"']+)["']/gi)].map((x) => x[1]),
    ).slice(0, 15)
    console.log('\nPAGE', url)
    console.log({
      status: page.status,
      len: page.t.length,
      title,
      iframes: iframes.slice(0, 10),
      embeds: embeds.slice(0, 15),
      watchLinks,
      dataEmbed,
    })
    // dump interesting script inline snippets
    const inline = [...page.t.matchAll(/<(?:script)[^>]*>([\s\S]{0,4000}?)<\/script>/gi)]
      .map((x) => x[1])
      .filter((s) => /embed|vidsrc|tmdb|iframe|server|episode/i.test(s))
      .slice(0, 3)
    for (const s of inline) console.log('INLINE', s.slice(0, 500).replace(/\s+/g, ' '))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
