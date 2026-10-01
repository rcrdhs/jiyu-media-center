const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const YM = 'https://ww.ymovies.vip'
const ID = 'soft'

async function text(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
  })
  return { status: r.status, text: await r.text(), url: r.url }
}

;(async () => {
  const servers = await text(`${YM}/ajax/movie/episode/servers/${ID}_1_1`, {
    Referer: YM + '/',
    'X-Requested-With': 'XMLHttpRequest',
  })
  const html = JSON.parse(servers.text).html
  const token = (html.match(/data-id="([^"]+)"/i) || [])[1]
  const src = JSON.parse(
    (
      await text(`${YM}/ajax/movie/episode/server/sources/${token}_11`, {
        Referer: YM + '/',
        'X-Requested-With': 'XMLHttpRequest',
      })
    ).text,
  ).src
  console.log('embed', src)

  const page = await text(src, { Referer: YM + '/' })
  console.log('page', page.status, page.len)

  // Pull getSources-ish endpoints from embed HTML + scripts
  const htmlBody = page.text
  const ajaxHits = [...htmlBody.matchAll(/["']([^"']*getSources[^"']*)["']/gi)].map((m) => m[1])
  const apiHits = [...htmlBody.matchAll(/["'](\/ajax\/[^"']+)["']/gi)].map((m) => m[1])
  console.log('ajax in html', [...new Set([...ajaxHits, ...apiHits])].slice(0, 20))

  // Fetch player script and find getSources URL pattern
  const scriptRel = (htmlBody.match(/src="(\/assets\/js\/player\/script\.min\.js[^"]*)"/i) || [])[1]
  if (scriptRel) {
    const scriptUrl = new URL(scriptRel, 'https://fstream365.com').toString()
    const js = await text(scriptUrl, { Referer: src })
    console.log('script', js.status, js.text.length)
    const snippets = []
    for (const re of [/getSources[^"'\s]{0,80}/g, /\/ajax\/[^"']{5,80}/g, /atob\([^)]{0,40}/g]) {
      snippets.push(...[...js.text.matchAll(re)].map((m) => m[0]).slice(0, 8))
    }
    console.log('js snippets', [...new Set(snippets)].slice(0, 30))

    // Find id/h/a/t construction near getSources
    const idx = js.text.indexOf('getSources')
    if (idx >= 0) console.log('context', js.text.slice(Math.max(0, idx - 200), idx + 300))
  }

  // data-id / file params on page
  const dataIds = [...htmlBody.matchAll(/data-([a-z]+)="([^"]{8,})"/gi)].slice(0, 15)
  console.log(
    'data attrs',
    dataIds.map((m) => [m[1], m[2].slice(0, 60)]),
  )
  const inline = [...htmlBody.matchAll(/<(?:script)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((t) => /id|sources|file|srv/i.test(t) && t.length < 5000)
  console.log(
    'inline scripts',
    inline.map((t) => t.slice(0, 400)),
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
