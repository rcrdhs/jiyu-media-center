;(async () => {
  const t = await fetch('https://spa.aoneroom.com/ssrStatic/m2boxorg/public/_nuxt/K0LPz00A.js').then((r) =>
    r.text(),
  )
  const paths = [...t.matchAll(/subject\/[a-zA-Z]+/g)].map((x) => x[0])
  console.log('subject paths', [...new Set(paths)].sort())
  const wefeed = [...t.matchAll(/wefeed-h5api-bff\/[a-zA-Z/_-]+/g)].map((x) => x[0])
  console.log('wefeed paths', [...new Set(wefeed)].sort())
  const playIdx = t.indexOf('subject/play')
  if (playIdx >= 0) console.log('play context', t.slice(playIdx - 80, playIdx + 200))
})()
