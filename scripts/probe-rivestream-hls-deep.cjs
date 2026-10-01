async function main() {
  const t = await fetch('https://rivestream.ru/_next/static/chunks/1446-e920d125df04a54a.js').then((r) => r.text())
  const patterns = [
    'nonEmbed',
    'directstream',
    'setNonEmbed',
    'insertunit',
    'filmku',
    'frembed',
    'multiembed',
    'vsrc.su',
    'watchMode',
    'direct"',
    'm3u8',
    'quality',
    'format:',
    'isLocal',
    'source:"',
  ]
  for (const p of patterns) {
    let idx = 0
    let n = 0
    while ((idx = t.indexOf(p, idx)) >= 0 && n < 2) {
      console.log('\n==', p, n, '==')
      console.log(t.slice(Math.max(0, idx - 120), idx + 450))
      idx += p.length
      n++
    }
  }
  const concats = [...t.matchAll(/["']https:[^"']+["']\.concat\([^)]{0,160}\)/g)].slice(0, 25)
  console.log('\nconcat urls', concats.map((m) => m[0].slice(0, 220)))
}

main().catch(console.error)
