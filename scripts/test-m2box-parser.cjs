const { parseM2BoxSeasonsFromHtml, m2boxEpisodesFromSeasons } = require('../src/lib/m2box.ts')
// can't require ts easily — duplicate minimal test in plain js

function resolveNuxtOnce(data, ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < data.length) {
    let v = data[ref]
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      /^(?:Shallow)?Reactive|Ref$/i.test(v[0])
    ) {
      return resolveNuxtOnce(data, v[1])
    }
    return v
  }
  return ref
}

function asPositiveInt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value)
    return n >= 1 ? n : null
  }
  return null
}

;(async () => {
  const html = await fetch('https://m2box.org/detail/mourinho-AGUExygeV43', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  const data = JSON.parse(match[1])
  let resource = null
  for (const entry of data) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'seasons' in entry) {
      resource = entry
      break
    }
  }
  const seasonsArr = data[resource.seasons]
  const seasons = []
  for (const seasonRef of seasonsArr) {
    const season = data[seasonRef]
    const se = asPositiveInt(resolveNuxtOnce(data, season.se))
    const maxEp = asPositiveInt(resolveNuxtOnce(data, season.maxEp))
    if (se && maxEp && maxEp <= 500) seasons.push({ season: se, maxEpisode: maxEp })
  }
  console.log('Mourinho seasons', seasons)
  const eps = []
  for (const { season, maxEpisode } of seasons) {
    for (let episode = 1; episode <= maxEpisode; episode++) {
      eps.push(`S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`)
    }
  }
  console.log('episodes', eps.join(', '))
})()
