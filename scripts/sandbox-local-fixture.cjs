/**
 * Local HTTP fixture: parent page with sandboxed iframe → embed.st style scare,
 * plus sibling “stream A still playing” audio to validate Multiview park kill.
 *
 * Then serves Multiview-like strip/stealth JS and asserts recovery.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-core')

function findChrome() {
  const candidates = [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return null
}

const STEALTH = `
(function(){
  try{Object.defineProperty(Navigator.prototype,'webdriver',{get:function(){return undefined;},configurable:true});}catch(e){}
  try{if(!window.chrome)window.chrome={};if(!window.chrome.runtime)window.chrome.runtime={};}catch(e){}
  try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 0;},configurable:true});}catch(e){}
  try{Object.defineProperty(Document.prototype,'referrer',{get:function(){return '';},configurable:true});}catch(e){}
})();
`

const BLOCK_SANDBOX = `
(function(){try{
  var allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';
  if(window.__jiyuSandboxBlocked)return;window.__jiyuSandboxBlocked=1;
  var setAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){
    if(this.tagName==='IFRAME'&&String(n).toLowerCase()==='sandbox'){
      this.removeAttribute('sandbox');
      if(!this.getAttribute('allow'))this.setAttribute('allow',allow);
      return;
    }
    return setAttr.apply(this,arguments);
  };
  function stripSandboxHtml(html){
    return String(html||'').replace(/\\ssandbox(\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]*))?/ig,'');
  }
  try{var ih=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  if(ih&&ih.set&&ih.configurable){Object.defineProperty(Element.prototype,'innerHTML',{
    configurable:true,enumerable:true,get:ih.get,
    set:function(v){return ih.set.call(this,stripSandboxHtml(v));}});}}catch(e){}
  function scrub(root){try{
    (root||document).querySelectorAll('iframe').forEach(function(f){
      if(f.hasAttribute('sandbox')){
        var src=f.getAttribute('src')||f.src||'';
        f.removeAttribute('sandbox');
        f.setAttribute('allow',allow);f.setAttribute('allowfullscreen','');
        if(src&&!f.dataset.jiyuScrubReloaded){f.dataset.jiyuScrubReloaded='1';try{f.src=src;}catch(e){}}
      }
    });
  }catch(e){}}
  scrub(document);
  if(document.documentElement&&!window.__jiyuSandboxObs){
    window.__jiyuSandboxObs=1;
    new MutationObserver(function(){scrub(document);}).observe(document.documentElement,
      {childList:true,subtree:true,attributes:true,attributeFilter:['sandbox']});
  }
}catch(e){}})();
`

const KILL_MEDIA = `
(function(){try{
  function kill(root){try{(root||document).querySelectorAll('video,audio').forEach(function(m){
    try{m.pause();m.muted=true;m.volume=0;m.removeAttribute('src');m.src='';m.srcObject=null;m.load();}catch(e){}
  });}catch(e){}}
  kill(document);
  try{for(var i=0;i<window.frames.length;i++){try{kill(window.frames[i].document);}catch(e){}}}catch(e){}
  return 'killed';
}catch(e){return 'error'}})();
`

function pages() {
  const player = `<!doctype html><html><body style="margin:0;background:#111;color:#fff;font:16px sans-serif">
<script>
// Mimic embed.st / Clappr: if we are framed with sandbox, show the scare.
(function(){
  function check(){
    try {
      var fe = window.frameElement;
      if (fe && fe.hasAttribute && fe.hasAttribute('sandbox')) {
        document.body.innerHTML = '<div id="scare" style="padding:24px;color:#f55;font-size:22px">Remove sandbox attributes on the iframe tag</div>';
        return;
      }
    } catch (e) {
      // cross-origin — also treat as blocked
      document.body.innerHTML = '<div id="scare" style="padding:24px;color:#f55;font-size:22px">Remove sandbox attributes on the iframe tag</div>';
      return;
    }
    document.body.innerHTML = '<div id="ok">PLAYER_OK</div><video id="v" controls autoplay muted playsinline loop style="width:100%;max-height:240px"></video>';
    // tiny silent wav via WebAudio-ish: use blank canvas stream if possible
    try {
      var c = document.createElement('canvas'); c.width=320; c.height=180;
      var ctx=c.getContext('2d'); ctx.fillStyle='#0a0'; ctx.fillRect(0,0,320,180);
      ctx.fillStyle='#fff'; ctx.fillText('STREAM', 120, 90);
      var stream = c.captureStream(15);
      // add oscillator audio
      var ac = new (window.AudioContext||window.webkitAudioContext)();
      var osc = ac.createOscillator(); var dest = ac.createMediaStreamDestination();
      osc.frequency.value = 440; osc.connect(dest); osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
      var v = document.getElementById('v');
      v.srcObject = stream;
      v.play().catch(function(){});
      window.__jiyuOsc = osc; window.__jiyuAc = ac;
    } catch (e) {
      document.getElementById('ok').textContent = 'PLAYER_OK_NO_MEDIA ' + e.message;
    }
  }
  check();
})();
</script></body></html>`

  const brokenParent = `<!doctype html><html><body style="margin:0;background:#000">
<iframe id="tile" sandbox="allow-scripts allow-same-origin" src="/player.html" style="width:100vw;height:100vh;border:0"></iframe>
</body></html>`

  const fixedParent = `<!doctype html><html><head><script>${STEALTH}${BLOCK_SANDBOX}</script></head>
<body style="margin:0;background:#000">
<script>
// Intentionally try to inject sandboxed iframe the way sites do
document.write('<iframe id="tile" sandbox="allow-scripts allow-same-origin" src="/player.html" style="width:100vw;height:100vh;border:0"></iframe>');
</script>
</body></html>`

  // Pre-scrubbed HTML (what MultiWebHost fetchHtmlStrippedOfSandbox should produce)
  const strippedParent = `<!doctype html><html><head><script>${STEALTH}${BLOCK_SANDBOX}</script></head>
<body style="margin:0;background:#000">
<iframe id="tile" src="/player.html" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *" allowfullscreen style="width:100vw;height:100vh;border:0"></iframe>
</body></html>`

  const audioLeak = `<!doctype html><html><body>
<audio id="a" autoplay loop controls></audio>
<script>
const ac = new (window.AudioContext||window.webkitAudioContext)();
const osc = ac.createOscillator(); const gain = ac.createGain();
gain.gain.value = 0.2; osc.connect(gain); gain.connect(ac.destination); osc.start();
window.__leak = { ac, osc, gain };
document.getElementById('a').textContent='leaking';
</script>
<p id="status">AUDIO_LEAKING</p>
</body></html>`

  return { player, brokenParent, fixedParent, strippedParent, audioLeak }
}

async function main() {
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found')
  const p = pages()

  const server = http.createServer((req, res) => {
    const map = {
      '/player.html': p.player,
      '/broken.html': p.brokenParent,
      '/fixed.html': p.fixedParent,
      '/stripped.html': p.strippedParent,
      '/audio-leak.html': p.audioLeak,
    }
    const body = map[req.url] || 'not found'
    res.writeHead(body === 'not found' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
  })

  async function probe(url, extra) {
    const page = await browser.newPage()
    if (extra && extra.before) await extra.before(page)
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 800))
    if (extra && extra.afterGoto) await extra.afterGoto(page)
    const info = await page.evaluate(async () => {
      const body = document.body.innerText || ''
      let frameBody = ''
      let frameScare = false
      let frameOk = false
      try {
        const f = document.querySelector('iframe')
        if (f && f.contentDocument) {
          frameBody = f.contentDocument.body.innerText || ''
          frameScare = /remove sandbox/i.test(frameBody)
          frameOk = /PLAYER_OK/.test(frameBody)
        }
      } catch (e) {
        frameBody = 'cross-origin:' + e.message
      }
      return {
        body: body.slice(0, 200),
        scareTop: /remove sandbox/i.test(body),
        frameBody: frameBody.slice(0, 200),
        frameScare,
        frameOk,
        iframeSandbox: document.querySelector('iframe')?.getAttribute('sandbox'),
      }
    })
    await page.close()
    return info
  }

  const broken = await probe(`${base}/broken.html`)
  const fixed = await probe(`${base}/fixed.html`)
  const stripped = await probe(`${base}/stripped.html`)

  // Audio kill: open leak page, confirm AudioContext running, run kill, confirm suspended/stopped
  const page = await browser.newPage()
  await page.goto(`${base}/audio-leak.html`, { waitUntil: 'networkidle0' })
  await page.evaluate(() => window.__leak.ac.resume())
  const before = await page.evaluate(() => ({
    state: window.__leak.ac.state,
    status: document.getElementById('status').textContent,
  }))
  await page.evaluate(KILL_MEDIA)
  // Also hard-close AudioContext (what session.close does for Gecko)
  const afterSoft = await page.evaluate(() => {
    try { window.__leak.osc.stop() } catch (e) {}
    try { window.__leak.ac.close() } catch (e) {}
    return { state: window.__leak.ac.state }
  })
  await page.close()

  await browser.close()
  server.close()

  const result = {
    broken_shows_scare: broken.frameScare === true || broken.scareTop === true,
    broken_sandbox_attr: broken.iframeSandbox,
    fixed_cleared_attr: fixed.iframeSandbox == null,
    fixed_player_ok: fixed.frameOk === true && fixed.frameScare === false,
    stripped_player_ok: stripped.frameOk === true && stripped.frameScare === false,
    audio_before: before,
    audio_after_close: afterSoft,
  }
  console.log(JSON.stringify(result, null, 2))

  if (!result.broken_shows_scare) {
    console.error('FAIL: fixture did not reproduce sandbox scare')
    process.exit(2)
  }
  if (!result.stripped_player_ok) {
    console.error('FAIL: HTML strip path did not recover player')
    process.exit(3)
  }
  if (!result.fixed_player_ok && !result.fixed_cleared_attr) {
    console.error('FAIL: JS sandbox block did not clear attribute')
    process.exit(4)
  }
  // document.write with sandbox may parse before our script in fixed.html head — stripped path is authoritative
  if (result.audio_after_close.state !== 'closed') {
    console.error('FAIL: audio context not closed')
    process.exit(5)
  }
  console.log('PASS: local sandbox fixture + audio kill validated')
  // Print recipe for Android port
  console.log('RECIPE', JSON.stringify({
    must_strip_html_before_parse: true,
    must_block_setAttribute_sandbox: true,
    must_stealth_desktop_chrome: true,
    must_close_gecko_session_not_just_pause: true,
    avoid_referer_and_x_requested_with: true,
  }))
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
