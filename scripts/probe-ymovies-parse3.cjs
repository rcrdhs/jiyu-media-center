/**
 * Dump ml-item pairing accuracy + find #blackAF + episode hang diagnosis.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: ORIGIN + '/', Accept: 'text/html,application/json' },
  })
  return { status: r.status, text: await r.text() }
}

;(async () => {
  const { text } = await fetchText(`${ORIGIN}/movie/filter/series/`)
  const parts = text.split(/<div class="ml-item">/i).slice(1)
  console.log('ml-item parts', parts.length)
  for (let i = 0; i < 3; i++) {
    const part = parts[i]
    console.log(`\n===== ITEM ${i} (len ${part.length}) =====`)
    console.log(part.slice(0, 700))
    const hrefs = [...part.matchAll(/href="(\/film\/[^"]+)"/gi)].map((m) => m[1])
    const posters = [...part.matchAll(/data-original="([^"]+)"/gi)].map((m) => m[1])
    const titles = [...part.matchAll(/title="([^"]+)"/gi)].map((m) => m[1])
    console.log('hrefs', hrefs)
    console.log('posters', posters)
    console.log('titles', titles.slice(0, 4))
  }

  // Try keyword filter paths
  for (const path of [
    '/search/blackAF',
    '/movie/search/blackAF',
    '/movie/filter/series/?keyword=blackAF',
    '/movie/filter/series/country/all/genre/all/year/all/sort/latest/keyword/blackAF',
    '/keyword/blackAF',
    '/film/blackaf',
    '/film/black-af',
    '/film/blackaf-s',
  ]) {
    const r = await fetchText(ORIGIN + path)
    const has = /black\s*af|#blackaf/i.test(r.text)
    const films = (r.text.match(/\/film\/[^"]*black[^"]*/gi) || []).slice(0, 5)
    console.log(path, r.status, 'hasBlackAF', has, 'films', films)
  }

  // Probe No Game No Life episodes end-to-end like the app
  const id = 's1ax4'
  const seasons = await fetchText(`${ORIGIN}/ajax/movie/seasons/${id}`)
  console.log('\nseasons s1ax4', seasons.status, seasons.text.slice(0, 300))
  const html = JSON.parse(seasons.text).html || ''
  console.log('ss-item count', (html.match(/ss-item/g) || []).length)
  console.log('spinner?', /cssload/i.test(html))

  // Maybe seasons need watching page cookie / different URL shape
  const detail = await fetchText(`${ORIGIN}/film/no-game-no-life-s1ax4`)
  console.log('detail', detail.status)
  const ajax = [...new Set([...detail.text.matchAll(/\/ajax\/[^"'\\\s]+/g)].map((m) => m[0]))]
  console.log('detail ajax', ajax.slice(0, 40))
  // look for season markup in detail
  console.log('detail has ss-item', /ss-item/i.test(detail.text))
  console.log('detail season snippet', (detail.text.match(/seasons[\s\S]{0,200}/i) || [])[0])

  const watch = await fetchText(`${ORIGIN}/film/no-game-no-life-s1ax4/watching.html`)
  console.log('watching', watch.status, watch.text.length)
  const wajax = [...new Set([...watch.text.matchAll(/\/ajax\/[^"'\\\s]+/g)].map((m) => m[0]))]
  console.log('watching ajax', wajax.slice(0, 40))
  console.log('watching ss-item', /ss-item/i.test(watch.text))
  const ss = [...watch.text.matchAll(/class="[^"]*ss-item[^"]*"[^>]*data-id="(\d+)"/gi)].map(
    (m) => m[1],
  )
  console.log('watching season ids', ss)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
