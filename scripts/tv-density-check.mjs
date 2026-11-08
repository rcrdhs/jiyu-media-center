/**
 * Layout regression for the Android TV / Fire TV density fix.
 *
 * Loads the real src/index.css (not a copy) and measures representative CSS
 * viewports. devicePixelRatio is varied because 1080p Android TV / Fire TV
 * WebViews are often 960×540 CSS px at dpr 2, not 1920×1080.
 *
 * This is a browser simulation. It does not drive a television.
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME || '/usr/bin/google-chrome'
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

function tiles(n) {
  return Array.from({ length: n }, (_, i) => {
    const names = ['Sports', 'Movies', 'Anime', 'TV Series', 'News', 'Kids']
    return `<a class="section-tile" href="#t${i}"><h3>${names[i % names.length]}</h3><p>Shelf</p><span>${i + 1} streams</span></a>`
  }).join('')
}

function cards(n, extra = '') {
  return Array.from({ length: n }, (_, i) => `
    <div class="media-card-wrap ${extra}">
      <a class="media-card ${extra}" href="#c${i}${extra}">
        <div class="media-card-art"></div>
        <div class="media-card-body"><h3>Title ${i + 1} that wraps onto two lines</h3></div>
      </a>
      <div class="media-card-actions">
        <button class="card-heart-btn" type="button" aria-label="Save">♡</button>
        <button class="card-check-btn" type="button">Play next</button>
      </div>
    </div>`).join('')
}

function pageHtml(className) {
  const android = className.includes('is-android')
  const sidebarClass = android ? 'sidebar sidebar-android' : 'sidebar'
  const navHidden = android ? ' hidden' : ''
  return `<!doctype html><html class="${className}"><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/src/index.css">
  </head><body>
  <div id="root"><div class="app-shell">
    <aside class="${sidebarClass}">
      <div class="sidebar-chrome">
        <div class="brand-row"><button class="brand brand-btn" type="button">Jiyu</button></div>
        <div class="sections-menu-wrap"><button class="sections-menu-btn" type="button">Sections</button></div>
      </div>
      <nav class="side-nav"${navHidden}><a class="nav-link" href="#home">Home</a></nav>
      <div class="side-footer"><a class="side-library nav-link" href="#lib">Library</a></div>
    </aside>
    <main class="main-stage">
      <div class="page">
        <header class="page-header"><h1>Movies</h1><p class="lede">Features and film house streams.</p></header>
        <div class="section-tiles">${tiles(6)}</div>
        <section class="section-block">
          <div class="section-head"><h2>Catalog</h2></div>
          <div class="catalog-grid" id="catalog">${cards(12)}</div>
        </section>
        <div class="continue-row" id="cont">${Array.from({ length: 8 }, (_, i) => `
          <div class="continue-card-wrap"><a class="continue-card" href="#k${i}">
            <div class="continue-card-art"></div>
            <div class="continue-card-body"><h3>Continue ${i + 1}</h3></div>
          </a></div>`).join('')}
        </div>
        <section class="favorite-matches"><div class="catalog-grid">${cards(6, 'is-sports')}</div></section>
      </div>
    </main>
  </div></div>
  </body></html>`
}

function measureJs() {
  const rowCount = (sel) => {
    const nodes = [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 8 && r.height > 8
    })
    if (!nodes.length) return { count: 0, cols: 0, cardW: 0, cardH: 0 }
    const tops = nodes.map((n) => Math.round(n.getBoundingClientRect().top))
    const first = Math.min(...tops)
    const row = nodes.filter((n, i) => Math.abs(tops[i] - first) < 10)
    const r0 = row[0].getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visible = row.filter((n) => {
      const r = n.getBoundingClientRect()
      return r.left >= -1 && r.right <= vw + 1 && r.top < vh && r.bottom > 0
    }).length
    return { count: nodes.length, cols: row.length, visible, cardW: Math.round(r0.width), cardH: Math.round(r0.height) }
  }
  const railEl = document.querySelector('.sidebar')
  const rail = railEl.getBoundingClientRect()
  const shell = document.querySelector('.app-shell').getBoundingClientRect()
  const sbCss = getComputedStyle(railEl)
  const play = document.querySelector('.card-check-btn').getBoundingClientRect()
  const lib = document.querySelector('.side-library').getBoundingClientRect()
  const nav = document.querySelector('.side-nav')
  const home = nav?.querySelector('.nav-link') || null
  const homeRect = home ? home.getBoundingClientRect() : null
  const navDisplay = nav ? getComputedStyle(nav).display : 'none'
  const inside = (r) =>
    r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
  const probe = document.createElement('div')
  probe.className = 'player-shell'
  probe.innerHTML = '<button class="control-btn" type="button">Pause</button>'
  document.body.appendChild(probe)
  const playerMin = getComputedStyle(probe.querySelector('.control-btn')).minHeight
  probe.remove()
  return {
    inner: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    tiles: rowCount('.section-tile'),
    catalog: rowCount('#catalog .media-card-wrap'),
    cont: rowCount('.continue-card-wrap'),
    fav: rowCount('.favorite-matches .media-card-wrap'),
    rail: { x: Math.round(rail.x), w: Math.round(rail.width), h: Math.round(rail.height), cssH: sbCss.height, display: sbCss.display, flex: sbCss.flexDirection, shellH: Math.round(shell.height), inside: inside(rail) },
    play: { w: Math.round(play.width), h: Math.round(play.height), inside: inside(play) },
    lib: { w: Math.round(lib.width), h: Math.round(lib.height), inside: inside(lib) },
    sectionLink: homeRect
      ? {
          display: navDisplay,
          text: (home.textContent || '').trim(),
          x: Math.round(homeRect.x),
          w: Math.round(homeRect.width),
          inRail:
            navDisplay !== 'none' &&
            homeRect.width > 36 &&
            homeRect.left >= rail.left - 6 &&
            homeRect.right <= rail.right + 6,
        }
      : null,
    playerMin,
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/src/index.css') {
    res.setHeader('content-type', 'text/css; charset=utf-8')
    res.end(css)
    return
  }
  const cls = url.searchParams.get('cls') || ''
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(pageHtml(cls))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})

async function measure(width, height, dpr, cls) {
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: dpr })
  await page.goto(`${origin}/?cls=${encodeURIComponent(cls)}`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForSelector('#catalog .media-card-wrap')
  const data = await page.evaluate(measureJs)
  await page.close()
  return data
}

const failures = []
function check(name, ok, detail) {
  const mark = ok ? 'ok' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''))
}

const tv = 'tv-mode is-android is-native'
const tizen = 'tv-mode is-tizen'
const phone = 'is-android is-native'

const tv960 = await measure(960, 540, 1, tv)
const tv960dpr2 = await measure(960, 540, 2, tv)
const tv1280 = await measure(1280, 720, 1, tv)
const tv1440 = await measure(1440, 810, 1, tv)
const tv1920 = await measure(1920, 1080, 1, tv)
const tv640 = await measure(640, 360, 1, tv)
const tizen1920 = await measure(1920, 1080, 1, tizen)
const phonePort = await measure(390, 844, 1, phone)
const phoneLand = await measure(844, 390, 1, phone)
const tablet = await measure(1280, 800, 1, phone)
const desktop = await measure(1440, 900, 1, '')

const dump = (label, m) =>
  console.log(
    label,
    JSON.stringify({
      tiles: m.tiles,
      catalog: m.catalog,
      cont: m.cont,
      fav: m.fav,
      rail: m.rail,
      play: m.play,
      playerMin: m.playerMin,
    }),
  )

dump('tv960', tv960)
dump('tv1280', tv1280)
dump('tv1920', tv1920)
dump('tizen', tizen1920)
dump('phone', phonePort)
dump('tablet', tablet)
dump('desktop', desktop)

check('960 dpr does not change columns', tv960.catalog.cols === tv960dpr2.catalog.cols && tv960.tiles.cols === tv960dpr2.tiles.cols, `dpr1 ${tv960.catalog.cols}/${tv960.tiles.cols} dpr2 ${tv960dpr2.catalog.cols}/${tv960dpr2.tiles.cols}`)
check('android tv 960 shows at least 5 catalog cards', tv960.catalog.cols >= 5, `cols ${tv960.catalog.cols} w ${tv960.catalog.cardW}`)
check('android tv 960 section tiles are not stuck at 3', tv960.tiles.cols >= 4, `cols ${tv960.tiles.cols} w ${tv960.tiles.cardW}`)
check('android tv 960 card is short enough for a second row', tv960.catalog.cardH > 0 && tv960.catalog.cardH <= 250, `h ${tv960.catalog.cardH}`)
check(
  'android tv 960 continue cards fit more than 3 across',
  tv960.cont.cardW > 0 && Math.floor(760 / tv960.cont.cardW) >= 4,
  `w ${tv960.cont.cardW}`,
)
check('android tv 960 favorite cards are not half the screen', tv960.fav.cardW > 0 && tv960.fav.cardW <= 300, `w ${tv960.fav.cardW}`)
check(
  'android tv 960 lists sections in the left rail',
  tv960.rail.inside &&
    tv960.rail.w >= 180 &&
    tv960.rail.w <= 260 &&
    tv960.rail.h >= 500 &&
    tv960.sectionLink?.inRail === true &&
    tv960.sectionLink.text === 'Home',
  JSON.stringify({ rail: tv960.rail, section: tv960.sectionLink }),
)
check('android tv 960 play-next control is readable', tv960.play.h >= 32 && tv960.play.w >= 48, JSON.stringify(tv960.play))
check('android tv 960 library control is on screen', tv960.lib.inside && tv960.lib.h >= 32, JSON.stringify(tv960.lib))

check('android tv 1280 catalog is denser than 3', tv1280.catalog.cols >= 6, `cols ${tv1280.catalog.cols}`)
check('android tv 1280 tiles', tv1280.tiles.cols >= 5, `cols ${tv1280.tiles.cols}`)
check('android tv 1440 catalog', tv1440.catalog.cols >= 6, `cols ${tv1440.catalog.cols}`)

check('android tv 1920 tiles are not 3 stretched bars', tv1920.tiles.cols >= 6 && tv1920.tiles.cardW < 360, `cols ${tv1920.tiles.cols} w ${tv1920.tiles.cardW}`)
check('android tv 1920 catalog keeps couch-sized cards', tv1920.catalog.cols >= 6 && tv1920.catalog.cardW >= 160, `cols ${tv1920.catalog.cols} w ${tv1920.catalog.cardW}`)
check('player control min size unchanged on tv', tv1920.playerMin === tv960.playerMin && parseFloat(tv1920.playerMin) >= 40, tv1920.playerMin)

check('tizen keeps 5 section tiles and the wide sidebar', tizen1920.tiles.cols === 5 && tizen1920.rail.w >= 200, `tiles ${tizen1920.tiles.cols} rail ${tizen1920.rail.w}`)
check('tizen catalog is not the android-tv 124px grid', tizen1920.catalog.cardW >= 165, `w ${tizen1920.catalog.cardW}`)

check('phone portrait is not tv density', phonePort.tiles.cols === 3 && phonePort.rail.w >= 300 && phonePort.rail.h < 320, `tiles ${phonePort.tiles.cols} rail ${phonePort.rail.w}x${phonePort.rail.h}`)
check('phone landscape keeps 3 tiles and the icon rail', phoneLand.tiles.cols === 3 && phoneLand.rail.w < 120 && phoneLand.sectionLink?.display === 'none', `tiles ${phoneLand.tiles.cols} rail ${phoneLand.rail.w} section ${phoneLand.sectionLink?.display}`)
check('tablet landscape keeps 3 section tiles', tablet.tiles.cols === 3, `cols ${tablet.tiles.cols} w ${tablet.tiles.cardW}`)
check('tablet catalog cards stay larger than android tv 1280', tablet.catalog.cardW > tv1280.catalog.cardW + 20, `tablet ${tablet.catalog.cardW} tv ${tv1280.catalog.cardW}`)
check('desktop keeps 5 tiles and the text sidebar', desktop.tiles.cols === 5 && desktop.rail.w >= 200, `tiles ${desktop.tiles.cols} rail ${desktop.rail.w}`)
check(
  'narrow android tv rail still on screen',
  tv640.rail.inside && tv640.rail.h >= 300 && tv640.lib.inside && tv640.play.h >= 30 && tv640.catalog.cols >= 2,
  JSON.stringify({ rail: tv640.rail, lib: tv640.lib, playH: tv640.play.h, cols: tv640.catalog.cols }),
)

await browser.close()
server.close()

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall tv density checks passed')
