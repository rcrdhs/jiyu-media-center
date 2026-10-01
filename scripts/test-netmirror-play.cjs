/**
 * Smoke-test NetMirror meta parse + TMDB episode list (Node, no Electron).
 */
const fs = require('fs')

function parseNetMirrorMetaFromHtml(html) {
  const dataUri = html.match(
    /id=["']episodes-js-extra["'][^>]*src=["']data:text\/javascript;base64,([A-Za-z0-9+/=]+)["']/i,
  )
  let raw = ''
  if (dataUri?.[1]) raw = Buffer.from(dataUri[1], 'base64').toString('utf8')
  const objMatch = raw.match(/var\s+Episodes\s*=\s*(\{[\s\S]*?\})\s*;/)
  if (!objMatch?.[1]) return null
  const data = JSON.parse(objMatch[1])
  return {
    postId: String(data.post_id || ''),
    tmdbId: String(data.tvid || ''),
    apiKey: String(data.tvapikey || ''),
    tvPlayer: String(data.tvplayer || ''),
  }
}

;(async () => {
  const html = fs.readFileSync('D:/app/scripts/nm-detail.html', 'utf8')
  const meta = parseNetMirrorMetaFromHtml(html)
  console.log('meta', meta)
  const player = `${meta.tvPlayer}${meta.postId}&s=1&e=1&sv=embedru&tv=true`
  console.log('player', player)

  const show = await fetch(
    `https://api.themoviedb.org/3/tv/${meta.tmdbId}?api_key=${meta.apiKey}&language=en-US`,
  ).then((r) => r.json())
  console.log('seasons', show.number_of_seasons, show.name)

  const s1 = await fetch(
    `https://api.themoviedb.org/3/tv/${meta.tmdbId}/season/1?api_key=${meta.apiKey}&language=en-US`,
  ).then((r) => r.json())
  console.log(
    'S1 eps',
    (s1.episodes || []).slice(0, 3).map((e) => ({ n: e.episode_number, name: e.name, air: e.air_date })),
  )

  const page = await fetch(player, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://freemovies.lol/' },
  }).then((r) => r.text())
  console.log('player page', page.slice(0, 300))
})()
