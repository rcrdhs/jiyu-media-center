/**
 * Jiyu relay — used ONLY by the Samsung (Tizen) build. Desktop (Electron IPC) and
 * Android (CapacitorHttp) fetch these sources natively and never call it.
 *
 *   GET/POST /r?u=<url>        CORS relay for a short allowlist of scraper hosts.
 *                              Not an open proxy: any other host is a 403.
 *   GET      /hls?u=&ref=      HLS playlist fetched with Referer/Origin <ref>. Only
 *                              allowlisted referers. Every URI inside is rewritten
 *                              to /seg?…&s=<hmac>, so only URLs that came out of a
 *                              relayed playlist can be fetched — no free-form video proxy.
 *   GET      /seg?u=&ref=&s=    signed segment / key / sub-playlist (streams the body).
 *   GET      /yt?v=<id>         https YouTube IFrame-API page (fixes Error 153: a
 *                              file:// / widget origin sends no Referer). Accepts
 *                              the app's postMessage commands.
 *   GET      /health
 *
 * Video bytes only flow through /seg, and only for referer-locked sources (Movy,
 * Atlantic, Bilibili …). Plain IPTV / YouTube / iframe embeds stay direct.
 */

const DATA_HOSTS = [
  // streamed.pk API (matches / streams JSON)
  /^(?:[a-z0-9-]+\.)*streamed\.pk$/,
  /^(?:[a-z0-9-]+\.)*streamed\.su$/,
  /^(?:api\.)?ppv\.st$/,
  /^subsplease\.org$/,
  /^livextv-backend\.onrender\.com$/,
  /^livextv\.hybrows\.workers\.dev$/,
  /^(?:www\.)?livextv\.(?:com|live|pro)$/,
  /^i\.mjh\.nz$/,
  /^epgshare01\.online$/,
  /^(?:www\.)?fullmatchshows\.com$/,
  /^(?:www\.)?soccerfull\.net$/,
  /^www\.youtube\.com$/,
]

/** YouTube: only the live lookups the app makes, not the whole site. */
function youtubePathAllowed(method, url) {
  if (method === 'POST') {
    return /^\/youtubei\/v1\/(?:navigation\/resolve_url|player)$/.test(url.pathname)
  }
  return /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/.test(url.pathname)
}

/** Sources whose CDNs reject requests without their Referer (Player.tsx referrers). */
const HLS_REFERERS = [
  /^https:\/\/(?:[a-z0-9-]+\.)*movy\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*atlantic[a-z0-9-]*\.[a-z.]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*bilibili\.tv$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*biliintl\.com$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*rivestream\.[a-z]+$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*streamo\.pro$/,
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:embedsports|embedme|streamed)\.[a-z]+$/,
]

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_DATA_BYTES = 12 * 1024 * 1024
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024
const PASS_HEADERS = ['content-type', 'x-youtube-client-name', 'x-youtube-client-version', 'accept', 'accept-language']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Accept-Language, X-Youtube-Client-Name, X-Youtube-Client-Version, X-Relay-Referer, X-Relay-UA, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Relay-Status, X-Relay-Cache',
  'Access-Control-Max-Age': '86400',
}

function reply(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...headers } })
}

// ---- tiny per-isolate rate limit (best effort; free, no bindings) ----
const buckets = new Map()
function limited(request, kind, perMinute) {
  const ip = request.headers.get('cf-connecting-ip') || 'x'
  const key = `${kind}:${ip}`
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || now - b.t > 60_000) {
    b = { t: now, n: 0 }
    buckets.set(key, b)
    if (buckets.size > 5000) buckets.clear()
  }
  b.n += 1
  return b.n > perMinute
}

function parseTarget(raw) {
  try {
    const u = new URL(raw || '')
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    if (u.port && u.port !== '443' && u.port !== '80') return null
    return u
  } catch {
    return null
  }
}

function hostAllowed(host) {
  return DATA_HOSTS.some((re) => re.test(host.toLowerCase()))
}

function refererAllowed(ref) {
  try {
    const o = new URL(ref).origin.toLowerCase()
    return HLS_REFERERS.some((re) => re.test(o))
  } catch {
    return false
  }
}

function ttlFor(url) {
  const h = url.hostname
  if (h === 'i.mjh.nz' || h === 'epgshare01.online') return 900
  if (h === 'subsplease.org') return 300
  if (/livextv/.test(h)) return 600
  if (h === 'www.youtube.com') return 45
  return 60 // streamed.pk / ppv live lists
}

async function readCapped(res, cap) {
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > cap) return null
  const buf = await res.arrayBuffer()
  return buf.byteLength > cap ? null : buf
}

// ---------------------------------------------------------------- /r
async function relayData(request, ctx) {
  const reqUrl = new URL(request.url)
  const target = parseTarget(reqUrl.searchParams.get('u'))
  if (!target) return reply('Bad url', 400)
  if (!hostAllowed(target.hostname)) return reply('Host not allowed', 403)
  const method = request.method === 'POST' ? 'POST' : 'GET'
  if (target.hostname === 'www.youtube.com' && !youtubePathAllowed(method, target)) {
    return reply('Path not allowed', 403)
  }
  if (method === 'POST' && target.hostname !== 'www.youtube.com') return reply('POST not allowed', 405)
  if (limited(request, 'r', 240)) return reply('Slow down', 429, { 'Retry-After': '30' })

  const headers = new Headers()
  for (const name of PASS_HEADERS) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }
  headers.set('User-Agent', request.headers.get('x-relay-ua') || DESKTOP_UA)
  const ref = request.headers.get('x-relay-referer') || reqUrl.searchParams.get('ref')
  if (ref && /^https?:\/\//i.test(ref)) {
    headers.set('Referer', ref)
  }

  let body = null
  if (method === 'POST') {
    const buf = await request.arrayBuffer()
    if (buf.byteLength > 64 * 1024) return reply('Body too large', 413)
    body = buf
  }

  // Cache: GETs by URL+referer; YouTube POSTs by body (resolve_url/player are idempotent).
  const ttl = ttlFor(target)
  let cacheKey = null
  if (method === 'GET') {
    cacheKey = new Request(`https://relay.cache/r/${encodeURIComponent(target.href)}|${encodeURIComponent(ref || '')}`)
  } else {
    const digest = await crypto.subtle.digest('SHA-256', body)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    cacheKey = new Request(`https://relay.cache/p/${encodeURIComponent(target.pathname)}/${hex}`)
  }
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) {
    const out = new Response(hit.body, hit)
    out.headers.set('X-Relay-Cache', 'HIT')
    return out
  }

  let res
  try {
    res = await fetch(target.href, { method, headers, body, redirect: 'manual' })
    // Follow up to 4 redirects, but only to allowlisted hosts.
    for (let i = 0; i < 4 && res.status >= 300 && res.status < 400; i++) {
      const loc = res.headers.get('location')
      const next = loc ? parseTarget(new URL(loc, target).href) : null
      if (!next || !hostAllowed(next.hostname)) break
      res = await fetch(next.href, { method: 'GET', headers, redirect: 'manual' })
    }
  } catch (err) {
    return reply(`Upstream failed: ${err && err.message ? err.message : 'error'}`, 502)
  }
  const buf = await readCapped(res, MAX_DATA_BYTES)
  if (!buf) return reply('Upstream too large', 413)
  const outHeaders = {
    ...CORS,
    'Content-Type': res.headers.get('content-type') || 'text/plain; charset=utf-8',
    'Cache-Control': `public, max-age=${ttl}`,
    'X-Relay-Status': String(res.status),
    'X-Relay-Cache': 'MISS',
  }
  const out = new Response(buf, { status: res.status, headers: outHeaders })
  if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, out.clone()))
  return out
}

// ---------------------------------------------------------------- /hls + /seg
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(sig).slice(0, 18)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function signedSegUrl(origin, key, abs, ref) {
  const s = await hmac(key, `${abs}|${ref}`)
  return `${origin}/seg?u=${encodeURIComponent(abs)}&ref=${encodeURIComponent(ref)}&s=${s}`
}

async function rewritePlaylist(text, base, ref, origin, key) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      out.push(line)
      continue
    }
    if (t.startsWith('#')) {
      // URI="…" in EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP / I-FRAME lists.
      const m = /URI="([^"]+)"/.exec(t)
      if (m) {
        const abs = new URL(m[1], base).href
        out.push(t.replace(m[0], `URI="${await signedSegUrl(origin, key, abs, ref)}"`))
      } else out.push(t)
      continue
    }
    const abs = new URL(t, base).href
    out.push(await signedSegUrl(origin, key, abs, ref))
  }
  return out.join('\n')
}

function upstreamHeaders(ref, request) {
  const h = new Headers({ 'User-Agent': DESKTOP_UA, Accept: '*/*' })
  h.set('Referer', ref.endsWith('/') ? ref : `${ref}/`)
  try {
    h.set('Origin', new URL(ref).origin)
  } catch {
    /* ignore */
  }
  const range = request.headers.get('range')
  if (range) h.set('Range', range)
  return h
}

function looksLikePlaylist(contentType, url, firstBytes) {
  if (/mpegurl/i.test(contentType)) return true
  if (/\.m3u8?(\?|$)/i.test(url)) return true
  return firstBytes.startsWith('#EXTM3U')
}

async function relayHls(request, env, ctx, signed) {
  const reqUrl = new URL(request.url)
  const target = parseTarget(reqUrl.searchParams.get('u'))
  const ref = reqUrl.searchParams.get('ref') || ''
  if (!target) return reply('Bad url', 400)
  if (!refererAllowed(ref)) return reply('Referer not allowed', 403)
  const key = env.RELAY_KEY
  if (!key) return reply('Relay not configured', 503)
  if (signed) {
    const s = reqUrl.searchParams.get('s') || ''
    if (s !== (await hmac(key, `${target.href}|${ref}`))) return reply('Bad signature', 403)
    if (limited(request, 'seg', 900)) return reply('Slow down', 429, { 'Retry-After': '10' })
  } else if (limited(request, 'hls', 120)) {
    return reply('Slow down', 429, { 'Retry-After': '10' })
  }

  let res
  try {
    res = await fetch(target.href, { headers: upstreamHeaders(ref, request), redirect: 'follow' })
  } catch (err) {
    return reply(`Upstream failed: ${err && err.message ? err.message : 'error'}`, 502)
  }
  const ct = res.headers.get('content-type') || ''
  const playlistByName = /\.m3u8?(\?|$)/i.test(target.pathname) || /mpegurl/i.test(ct)
  if (!signed || playlistByName) {
    // Entry point must be a playlist — /hls never streams arbitrary bytes.
    const buf = await readCapped(res, MAX_PLAYLIST_BYTES)
    if (!buf) return reply('Playlist too large', 413)
    const text = new TextDecoder().decode(buf)
    if (!looksLikePlaylist(ct, target.pathname, text.slice(0, 16).replace(/^\uFEFF/, ''))) {
      if (!signed) return reply('Not an HLS playlist', 415)
      return new Response(buf, {
        status: res.status,
        headers: { ...CORS, 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' },
      })
    }
    const body = res.ok ? await rewritePlaylist(text, res.url || target.href, ref, reqUrl.origin, key) : text
    return new Response(body, {
      status: res.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': /#EXT-X-ENDLIST/.test(text) ? 'public, max-age=300' : 'no-store',
      },
    })
  }
  // Signed segment / key: stream through, no buffering.
  const headers = { ...CORS, 'Content-Type': ct || 'video/mp2t', 'Cache-Control': 'public, max-age=600' }
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(name)
    if (v) headers[name] = v
  }
  return new Response(res.body, { status: res.status, headers })
}

// ---------------------------------------------------------------- /yt
function ytPage(reqUrl) {
  const p = reqUrl.searchParams
  const v = String(p.get('v') || '')
  if (!/^[A-Za-z0-9_-]{11}$/.test(v)) return reply('Bad video id', 400)
  const cfg = {
    v,
    mute: p.get('mute') === '1',
    controls: p.get('controls') === '1' ? 1 : 0,
    start: Math.max(0, Math.floor(Number(p.get('start') || 0)) || 0),
  }
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jiyu YouTube</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;inset:0;width:100%;height:100%}
#msg{position:absolute;left:0;right:0;bottom:8%;text-align:center;color:#ddd;font:28px/1.4 system-ui,sans-serif;display:none}</style>
</head><body><div id="p"></div><div id="msg"></div>
<script>
var CFG=${JSON.stringify(cfg)};var player=null,ready=false,queue=[];
function send(o){try{o.jiyuYt=1;parent.postMessage(JSON.stringify(o),'*')}catch(e){}}
function state(){if(!ready)return;try{send({type:'state',state:player.getPlayerState(),time:player.getCurrentTime(),duration:player.getDuration(),muted:player.isMuted(),volume:player.getVolume()})}catch(e){}}
function run(func,args){if(!ready){queue.push([func,args]);return}
 try{if(func==='toggle'){var s=player.getPlayerState();if(s===1||s===3)player.pauseVideo();else player.playVideo()}
 else if(func==='seekBy'){var d=player.getDuration()||0,t=player.getCurrentTime()+Number(args&&args[0]||0);if(d>0)t=Math.min(t,d-1);player.seekTo(Math.max(0,t),true)}
 else if(func==='volumeBy'){var nv=Math.max(0,Math.min(100,player.getVolume()+Number(args&&args[0]||0)));player.setVolume(nv);if(nv>0)player.unMute()}
 else if(typeof player[func]==='function'){player[func].apply(player,args||[])}}catch(e){}
 setTimeout(state,150)}
window.addEventListener('message',function(ev){var d=ev.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch(e){return}}
 if(!d||typeof d!=='object')return;if(d.event==='listening'){send({type:'ready',ready:ready});return}
 if(d.event==='command'&&typeof d.func==='string')run(d.func,Array.isArray(d.args)?d.args:[])});
function onYouTubeIframeAPIReady(){player=new YT.Player('p',{videoId:CFG.v,host:'https://www.youtube.com',
 playerVars:{autoplay:1,mute:CFG.mute?1:0,controls:CFG.controls,rel:0,modestbranding:1,playsinline:1,iv_load_policy:3,fs:0,disablekb:1,start:CFG.start||undefined,origin:location.origin},
 events:{onReady:function(){ready=true;if(CFG.mute)player.mute();else{player.unMute();player.setVolume(100)}player.playVideo();
  var q=queue;queue=[];q.forEach(function(c){run(c[0],c[1])});send({type:'ready',ready:true});state()},
 onStateChange:function(){state()},
 onError:function(e){var m=document.getElementById('msg');m.style.display='block';
  m.textContent=(e.data===101||e.data===150||e.data===152)?'This video cannot be played outside YouTube.':'YouTube error '+e.data;send({type:'error',code:e.data})}}})}
setInterval(state,2000);
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body></html>`
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // No frame-ancestors: '*' does not match file:// / app:// (Tizen .wgt) parents.
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (path === '/health') return reply('ok', 200, { 'Content-Type': 'text/plain' })
    if (path === '/yt' && (request.method === 'GET' || request.method === 'HEAD')) return ytPage(url)
    if (path === '/r' && ['GET', 'HEAD', 'POST'].includes(request.method)) return relayData(request, ctx)
    if (path === '/hls' && request.method === 'GET') return relayHls(request, env, ctx, false)
    if (path === '/seg' && request.method === 'GET') return relayHls(request, env, ctx, true)
    return reply('Not found', 404, { 'Content-Type': 'text/plain' })
  },
}
