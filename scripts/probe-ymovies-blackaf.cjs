/**
 * Probe YMovies list parsing + episode AJAX for #blackAF / poster pairing.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: ORIGIN + '/' } })
  return { status: r.status, text: await r.text() }
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function parseListCurrent(html) {
  const links = []
  const re =
    /href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[\s\S]*?data-original="([^"]+)"[\s\S]*?SS\s*(\d+)[\s\S]*?EPS\s*(\d+)/gi
  let m
  while ((m = re.exec(html))) {
    links.push({
      path: m[1],
      title: decodeHtml(m[2]),
      poster: m[3],
      id: (m[1].match(/-(s[a-z0-9]+)$/i) || [])[1] || '',
      seasons: m[4],
      eps: m[5],
    })
  }
  return links
}

/** Tighter: poster must be inside the same card as the href (limit span). */
function parseListTight(html) {
  const links = []
  const cardRe =
    /<div[^>]*class="[^"]*flw-item[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi
  // fallback: split on flw-item
  const parts = html.split(/(?=<div[^>]*class="[^"]*flw-item)/i)
  for (const part of parts) {
    const href = part.match(/href="(\/film\/[^"]+)"[^>]*title="([^"]+)"/i)
    if (!href) continue
    const poster =
      part.match(/data-original="([^"]+)"/i)?.[1] ||
      part.match(/data-src="([^"]+)"/i)?.[1] ||
      part.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)?.[1] ||
      ''
    const ss = part.match(/SS\s*(\d+)/i)?.[1] || ''
    const eps = part.match(/EPS\s*(\d+)/i)?.[1] || ''
    links.push({
      path: href[1],
      title: decodeHtml(href[2]),
      poster,
      id: (href[1].match(/-(s[a-z0-9]+)$/i) || [])[1] || '',
      seasons: ss,
      eps,
      partLen: part.length,
    })
  }
  return links
}

;(async () => {
  const { status, text } = await fetchText(ORIGIN + '/movie/filter/series/')
  console.log('list status', status, 'len', text.length)

  // dump a sample card around first film
  const idx = text.indexOf('flw-item')
  console.log('flw-item at', idx)
  console.log('--- sample html ---')
  console.log(text.slice(Math.max(0, idx), idx + 1200))
  console.log('--- end sample ---')

  const current = parseListCurrent(text)
  console.log('current parser count', current.length)
  console.log('first 5 current:', current.slice(0, 5).map((x) => ({ t: x.title, id: x.id, p: x.poster.slice(-40) })))

  // find adjacent pairs where poster might be wrong (same poster twice)
  const posters = new Map()
  for (const l of current) {
    if (!posters.has(l.poster)) posters.set(l.poster, [])
    posters.get(l.poster).push(l.title)
  }
  const dupes = [...posters.entries()].filter(([, titles]) => titles.length > 1).slice(0, 5)
  console.log('duplicate posters (sample)', dupes)

  const tight = parseListTight(text)
  console.log('tight parser count', tight.length)
  console.log('first 5 tight:', tight.slice(0, 5).map((x) => ({ t: x.title, id: x.id, p: x.poster.slice(-40) })))

  // search blackAF across a few pages
  for (let page = 1; page <= 30; page++) {
    const url =
      page <= 1 ? ORIGIN + '/movie/filter/series/' : ORIGIN + `/movie/filter/series/${page}/`
    const pageHtml = page === 1 ? text : (await fetchText(url)).text
    const hit = pageHtml.match(/href="(\/film\/[^"]*black[^"]*)"[^>]*title="([^"]+)"/i)
    if (hit) {
      console.log('found on page', page, hit[1], hit[2])
      const around = pageHtml.indexOf(hit[0])
      console.log('card context:', pageHtml.slice(around - 200, around + 900))
      const id = (hit[1].match(/-(s[a-z0-9]+)$/i) || [])[1]
      console.log('ymoviesId', id)
      if (id) {
        const seasons = await fetchText(`${ORIGIN}/ajax/movie/seasons/${id}`)
        console.log('seasons', seasons.status, seasons.text.slice(0, 400))
        const eps = await fetchText(`${ORIGIN}/ajax/movie/season/episodes/${id}_1`)
        console.log('eps1', eps.status, eps.text.slice(0, 600))
      }
      break
    }
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
