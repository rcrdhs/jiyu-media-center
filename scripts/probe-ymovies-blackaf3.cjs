/**
 * Probe #blackAF (s2634) episode chain + seasons HTML + player JS endpoints.
 */
const ORIGIN = 'https://ww.ymovies.vip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const ID = 's2634'

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: ORIGIN + '/', Accept: 'text/html,application/json' },
  })
  return { status: r.status, text: await r.text(), url }
}

;(async () => {
  const search = await fetchText(`${ORIGIN}/movie/search/blackAF`)
  const card = search.text.split(/<div class="ml-item">/i).find((p) => /blackaf-s2634/i.test(p))
  console.log('search card poster', card?.match(/data-original="([^"]+)"/)?.[1])
  console.log('search card title', card?.match(/title="([^"]+)"/)?.[1])

  const seasons = await fetchText(`${ORIGIN}/ajax/movie/seasons/${ID}`)
  console.log('\nseasons full:', seasons.text)
  try {
    const html = JSON.parse(seasons.text).html
    console.log('parsed season ids', [
      ...html.matchAll(/class="[^"]*ss-item[^"]*"[^>]*data-id="(\d+)"/gi),
    ].map((m) => m[1]))
    console.log('any data-id', [...html.matchAll(/data-id="([^"]+)"/gi)].map((m) => m[1]))
  } catch (e) {
    console.log('seasons parse err', e.message)
  }

  const ep1 = await fetchText(`${ORIGIN}/ajax/movie/season/episodes/${ID}_1`)
  console.log('\nep1:', ep1.text.slice(0, 1500))
  try {
    const data = JSON.parse(ep1.text)
    console.log('ep keys', Object.keys(data))
    console.log('totalItems', data.totalItems)
    const html = data.html || ''
    const rows = [...html.matchAll(/data-id="(\d+)_(\d+)"[^>]*title="([^"]+)"/gi)].map((m) => ({
      s: m[1],
      e: m[2],
      t: m[3],
    }))
    console.log('rows', rows)
  } catch (e) {
    console.log('ep parse', e.message)
  }

  // Fetch player JS from watching page
  const watch = await fetchText(`${ORIGIN}/film/blackaf-s2634/watching.html`)
  console.log('\nwatching', watch.status, watch.text.length)
  const scripts = [...watch.text.matchAll(/src="([^"]+\.js[^"]*)"/gi)].map((m) => m[1])
  console.log('scripts', scripts)
  for (const src of scripts) {
    if (!/player|movie|episode|watch/i.test(src)) continue
    const url = src.startsWith('http') ? src : ORIGIN + src
    const js = await fetchText(url)
    console.log('\nJS', url, js.status, js.text.length)
    const ajaxHits = [...js.text.matchAll(/ajax\/[a-z0-9_\/.-]+/gi)].map((m) => m[0])
    console.log('ajax in js', [...new Set(ajaxHits)].slice(0, 40))
    // also string fragments
    for (const key of ['seasons', 'episodes', 'servers', 'sources', 'movie/season']) {
      const i = js.text.indexOf(key)
      if (i >= 0) console.log('ctx', key, js.text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' '))
    }
  }

  // movie_load_info
  const info = await fetchText(`${ORIGIN}/ajax/movie_load_info/${ID}/`)
  console.log('\nmovie_load_info', info.status, info.text.slice(0, 500))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
