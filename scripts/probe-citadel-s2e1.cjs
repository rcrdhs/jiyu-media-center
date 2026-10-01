async function main() {
  const url =
    'https://scrapper.rivestream.app/api/provider?provider=citadel&id=127532&season=2&episode=1'
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://rivestream.ru',
      Referer: 'https://rivestream.ru/',
    },
  })
  const j = await r.json()
  const sources = j?.data?.sources || []
  const caps = j?.data?.captions || []
  console.log(
    'sources sample',
    sources.slice(0, 3).map((s) => ({ quality: s.quality, format: s.format, url: s.url?.slice(0, 100) })),
  )
  console.log('captions', caps)
}
main()
