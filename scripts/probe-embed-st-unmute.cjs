async function main() {
  const bundle = await fetch('https://strmd.b-cdn.net/js/bundle-jw.js').then((r) => r.text())
  for (const term of [
    'CLICK UNMUTE',
    'UNMUTE STREAM',
    'muted:true',
    'autostart',
    'clickToPlay',
    'mute',
    'jwplayer',
    'Clappr',
  ]) {
    const i = bundle.toLowerCase().indexOf(term.toLowerCase())
    console.log(term, i >= 0 ? bundle.slice(Math.max(0, i - 80), i + 180) : 'NOT FOUND')
  }
}

main().catch(console.error)
