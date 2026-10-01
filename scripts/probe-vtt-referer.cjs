;(async () => {
  const url =
    'https://scrapper.rivestream.app/api/provider?provider=citadel&id=127532&season=1&episode=1'
  const r = await fetch(url, {
    headers: { Origin: 'https://rivestream.ru', Referer: 'https://rivestream.ru/' },
  })
  const j = await r.json()
  const blob = JSON.stringify(j)
  const caps = blob.match(/https?:[^"']+\.(?:vtt|srt)[^"']*/gi) || []
  console.log('status', r.status, 'caps', caps.slice(0, 5))
  if (!caps[0]) {
    const any = blob.match(/"file":"([^"]+)"/g)
    console.log('files sample', (any || []).slice(0, 8))
    return
  }
  for (const ref of [null, 'https://rivestream.ru/']) {
    const h = { Accept: 'text/vtt,*/*' }
    if (ref) {
      h.Referer = ref
      h.Origin = 'https://rivestream.ru'
    }
    const vr = await fetch(caps[0], { headers: h })
    const t = await vr.text()
    console.log('fetch', ref || 'noref', vr.status, t.slice(0, 100).replace(/\n/g, ' '))
  }
})().catch((e) => console.error(e))
