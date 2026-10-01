/**
 * Find #blackAF and probe seasons/episodes AJAX + detail page.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: ORIGIN + '/', Accept: 'text/html,application/json' },
  })
  return { status: r.status, text: await r.text(), url }
}

function parseMlItems(html) {
  const links = []
  const parts = html.split(/<div class="ml-item">/i).slice(1)
  for (const part of parts) {
    const mask = part.match(
      /<a[^>]*class="[^"]*ml-mask[^"]*"[^>]*href="(\/film\/[^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?data-original="([^"]+)"/i,
    )
    if (!mask) continue
    const ss = part.match(/>SS\s*(\d+)/i)?.[1] || part.match(/SS\s*(\d+)/i)?.[1] || ''
    const eps = part.match(/EPS\s*(\d+)/i)?.[1] || ''
    links.push({
      path: mask[1],
      title: mask[2],
      poster: mask[3],
      id: (mask[1].match(/-(s[a-z0-9]+)$/i) || [])[1] || '',
      ss,
      eps,
    })
  }
  return links
}

;(async () => {
  let found = null
  for (let page = 1; page <= 80; page++) {
    const url =
      page <= 1 ? `${ORIGIN}/movie/filter/series/` : `${ORIGIN}/movie/filter/series/${page}/`
    const { text } = await fetchText(url)
    const items = parseMlItems(text)
    if (page <= 2) {
      console.log('page', page, 'items', items.length)
      console.log(
        items.slice(0, 4).map((x) => ({ t: x.title, id: x.id, p: x.poster.split('/').pop() })),
      )
    }
    const hit = items.find((x) => /#?\s*black\s*af/i.test(x.title) || /blackaf/i.test(x.path))
    if (hit) {
      found = { ...hit, page }
      console.log('FOUND', found)
      break
    }
    if (page % 20 === 0) console.log('scanned page', page)
  }
  if (!found) {
    console.log('not found in 80 pages, try search')
    const search = await fetchText(`${ORIGIN}/search?keyword=blackAF`)
    console.log('search status', search.status, 'len', search.text.length)
    const items = parseMlItems(search.text)
    console.log(
      'search hits',
      items.filter((x) => /black/i.test(x.title)).slice(0, 10),
    )
    found = items.find((x) => /#?\s*black\s*af/i.test(x.title))
  }
  if (!found) {
    console.log('still not found')
    return
  }

  const id = found.id
  console.log('\n--- seasons raw ---')
  const seasons = await fetchText(`${ORIGIN}/ajax/movie/seasons/${id}`)
  console.log(seasons.status, seasons.text.slice(0, 800))

  console.log('\n--- episodes s1 ---')
  const ep1 = await fetchText(`${ORIGIN}/ajax/movie/season/episodes/${id}_1`)
  console.log(ep1.status, ep1.text.slice(0, 1000))

  // alternate endpoints guessed from yify clones
  for (const path of [
    `/ajax/movie_episodes/${id}`,
    `/ajax/v2/episode/list/${id}`,
    `/ajax/season/list/${id}`,
    `/ajax/movie/episodes/${id}`,
    `/ajax/movie_load_info/${id}/`,
  ]) {
    const r = await fetchText(ORIGIN + path)
    console.log('try', path, r.status, r.text.slice(0, 180).replace(/\s+/g, ' '))
  }

  const detail = await fetchText(ORIGIN + found.path)
  console.log('\n--- detail ---', detail.status, detail.url)
  const scripts = [...detail.text.matchAll(/ajax\/[^"']+/gi)].map((m) => m[0])
  console.log('ajax refs', [...new Set(scripts)].slice(0, 30))
  const seasonBits = detail.text.match(/ss-item|seasons-list|data-id="\d+"/gi)
  console.log('season bits', seasonBits?.slice(0, 20))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
