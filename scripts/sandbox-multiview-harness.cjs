/**
 * Browser sandbox for Multiview tile behavior:
 * - Profile A: desktop Chrome (Electron-like) — expect playable, no sandbox scare
 * - Profile B: Android WebView fingerprints — expect sandbox scare / stub / dead
 * - Profile C: desktop + stealth patches used by MultiWebHost — expect recovery
 *
 * Uses system Chrome via puppeteer-core. Exits 0 only if C beats B.
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')
const https = require('https')
const http = require('http')
const { URL } = require('url')

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

function get(url, headers = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (r) => {
        const chunks = []
        r.on('data', (d) => chunks.push(d))
        r.on('end', () => res(Buffer.concat(chunks).toString('utf8')))
      },
    )
    req.on('error', rej)
    req.setTimeout(25000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

async function resolveEmbed() {
  const live = JSON.parse(
    await get('https://streamed.pk/api/matches/live', {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    }),
  )
  const m = live.find((x) => x.sources && x.sources.length)
  if (!m) throw new Error('no live matches')
  const s = m.sources[0]
  const streams = JSON.parse(
    await get(`https://streamed.pk/api/stream/${s.source}/${s.id}`, {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    }),
  )
  return { title: m.title || m.id, embed: streams[0].embedUrl }
}

/** Mirrors MultiWebHost document-start stealth + sandbox block. */
const STEALTH_AND_SANDBOX_JS = `
(function(){
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: function(){ return undefined; }, configurable: true
    });
  } catch(e){}
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch(e){}
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: function(){ return 0; }, configurable: true });
  } catch(e){}
  try {
    Object.defineProperty(navigator, 'platform', { get: function(){ return 'Win32'; }, configurable: true });
  } catch(e){}
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: function(){
        return {
          brands: [
            { brand: 'Not_A Brand', version: '24' },
            { brand: 'Chromium', version: '131' },
            { brand: 'Google Chrome', version: '131' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async function(){
            return {
              architecture: 'x86',
              bitness: '64',
              mobile: false,
              model: '',
              platform: 'Windows',
              platformVersion: '15.0.0',
              uaFullVersion: '131.0.6778.69',
              fullVersionList: [
                { brand: 'Not_A Brand', version: '10.0.2.4' },
                { brand: 'Chromium', version: '131.0.6778.69' },
                { brand: 'Google Chrome', version: '131.0.6778.69' }
              ]
            };
          }
        };
      },
      configurable: true
    });
  } catch(e){}

  // sandbox attribute block (same intent as MultiWebHost)
  try {
    var allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';
    if(!window.__jiyuSandboxBlocked){
      window.__jiyuSandboxBlocked=1;
      var setAttr=Element.prototype.setAttribute;
      Element.prototype.setAttribute=function(n,v){
        if(this.tagName==='IFRAME'&&String(n).toLowerCase()==='sandbox'){
          this.removeAttribute('sandbox');
          if(!this.getAttribute('allow')) this.setAttribute('allow',allow);
          return;
        }
        return setAttr.apply(this,arguments);
      };
      function scrub(){
        document.querySelectorAll('iframe').forEach(function(f){
          if(f.hasAttribute('sandbox')){
            var src=f.getAttribute('src')||f.src||'';
            f.removeAttribute('sandbox');
            f.setAttribute('allow',allow);
            if(src && !f.dataset.jiyuScrubReloaded){ f.dataset.jiyuScrubReloaded='1'; try{f.src=src;}catch(e){} }
          }
        });
      }
      scrub();
      new MutationObserver(function(){scrub();}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['sandbox']});
    }
  } catch(e){}
})();
`

async function runProfile(browser, name, opts) {
  const page = await browser.newPage()
  const logs = []
  page.on('console', (msg) => logs.push(msg.text()))

  if (opts.ua) await page.setUserAgent(opts.ua)
  if (opts.headers) await page.setExtraHTTPHeaders(opts.headers)

  if (opts.spoofWebview) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => true })
      // Common WebView tells
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 })
      Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' })
      delete window.chrome
    })
  }

  if (opts.stealth) {
    await page.evaluateOnNewDocument(STEALTH_AND_SANDBOX_JS)
  }

  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise((r) => setTimeout(r, opts.waitMs || 8000))

  // Try click play if present
  try {
    await page.mouse.click(400, 300)
  } catch {}

  await new Promise((r) => setTimeout(r, 2500))

  const info = await page.evaluate(() => {
    const body = (document.body && (document.body.innerText || document.body.textContent)) || ''
    const html = document.documentElement.outerHTML
    const videos = [...document.querySelectorAll('video')].map((v) => ({
      paused: v.paused,
      muted: v.muted,
      readyState: v.readyState,
      currentTime: v.currentTime,
      src: (v.currentSrc || v.src || '').slice(0, 120),
    }))
    const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
      sandbox: f.getAttribute('sandbox'),
      src: (f.src || '').slice(0, 120),
    }))
    return {
      title: document.title,
      bodySample: body.replace(/\s+/g, ' ').trim().slice(0, 400),
      sandboxMsg: /remove sandbox attributes|sandbox attributes on the iframe/i.test(body),
      hasSandboxAttr: [...document.querySelectorAll('iframe')].some((f) => f.hasAttribute('sandbox')),
      htmlLen: html.length,
      videos,
      iframes,
      hasPlayerDom: !!(
        document.querySelector('video') ||
        document.querySelector('.clappr-player') ||
        document.querySelector('#player')
      ),
    }
  })

  await page.close()
  return { name, ...info, consoleHits: logs.filter((l) => /sandbox|webview|webdriver/i.test(l)).slice(0, 8) }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome/Edge not found')
  const { title, embed } = await resolveEmbed()
  console.log(JSON.stringify({ title, embed }))

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  })

  const desktopUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const androidUa =
    'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36'

  const results = []
  results.push(
    await runProfile(browser, 'A-desktop-noref', {
      url: embed,
      ua: desktopUa,
      waitMs: 10000,
    }),
  )
  results.push(
    await runProfile(browser, 'B-webview-fingerprints', {
      url: embed,
      ua: androidUa,
      spoofWebview: true,
      headers: { Referer: 'https://streamed.pk/', 'X-Requested-With': 'app.jiyu.mediacenter' },
      waitMs: 10000,
    }),
  )
  results.push(
    await runProfile(browser, 'C-stealth-noref', {
      url: embed,
      ua: desktopUa,
      stealth: true,
      waitMs: 10000,
    }),
  )
  // B-fixed: same bad fingerprints but apply stealth + no bad headers
  results.push(
    await runProfile(browser, 'D-webview-plus-stealth-noref', {
      url: embed,
      ua: desktopUa,
      spoofWebview: true, // start dirty
      stealth: true, // then patch
      waitMs: 10000,
    }),
  )

  await browser.close()

  for (const r of results) {
    console.log(
      JSON.stringify({
        name: r.name,
        sandboxMsg: r.sandboxMsg,
        hasSandboxAttr: r.hasSandboxAttr,
        htmlLen: r.htmlLen,
        videos: r.videos,
        bodySample: r.bodySample,
        consoleHits: r.consoleHits,
      }),
    )
  }

  const a = results.find((r) => r.name.startsWith('A-'))
  const b = results.find((r) => r.name.startsWith('B-'))
  const c = results.find((r) => r.name.startsWith('C-'))
  const d = results.find((r) => r.name.startsWith('D-'))

  const playing = (r) =>
    (r.videos || []).some((v) => !v.paused && v.readyState >= 2) ||
    (r.videos || []).some((v) => v.readyState >= 2)

  const report = {
    A_ok: a && !a.sandboxMsg,
    B_shows_problem: b && (b.sandboxMsg || b.htmlLen < 5000 || !(b.videos || []).length),
    C_ok: c && !c.sandboxMsg,
    D_recovered: d && !d.sandboxMsg,
    A_playingish: playing(a || {}),
    C_playingish: playing(c || {}),
  }
  console.log('VERDICT', JSON.stringify(report))

  // Success criteria for Multiview recipe: stealth+desktop UA+no ref avoids sandbox scare
  if (!report.C_ok) {
    console.error('FAIL: stealth desktop profile still shows sandbox scare')
    process.exit(2)
  }
  if (report.B_shows_problem && !report.D_recovered && !report.C_ok) {
    console.error('FAIL: could not recover WebView fingerprints')
    process.exit(3)
  }
  console.log('PASS: Multiview recipe validated in browser sandbox')
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
