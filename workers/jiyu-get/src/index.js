/**
 * Jiyu short links — redirect-only Worker.
 *
 *   /tv     newest TV APK. Prefers the fixed-name universal asset `Jiyu-TV.apk`
 *           (arm64 + armv7, needed for 32-bit Fire TV / Google TV sticks). Until a
 *           release carries it, falls back to the arm64 APK named in latest-android.yml.
 *   /tv64   newest arm64 APK (path from latest-android.yml).
 *   /apk    alias of /tv64 (phones).
 *   /win    newest Windows installer (path from latest.yml).
 *   /nnn    Nationwide live HLS (jiyu-nnn Worker) for Roku in-channel play.
 *   /       tiny HTML page with the links.
 *
 * Every target is a GitHub "releases/latest/download/<asset>" URL, so publishing a
 * new release is all it takes — this Worker never needs a redeploy for a version bump.
 */
const REPO = 'rcrdhs/jiyu-media-center'
const LATEST = `https://github.com/${REPO}/releases/latest/download/`
const RELEASES = `https://github.com/${REPO}/releases/latest`
const TV_ASSET = 'Jiyu-TV.apk'
const CACHE_SECONDS = 300

async function cachedFetch(url, init, ctx) {
  const cache = caches.default
  const key = new Request(`https://jiyu-get.cache/${encodeURIComponent(url)}::${init?.method || 'GET'}`)
  const hit = await cache.match(key)
  if (hit) return hit
  let res
  try {
    res = await fetch(url, { redirect: 'follow', cf: { cacheTtl: CACHE_SECONDS }, ...init })
  } catch {
    return new Response('', { status: 599 })
  }
  const body = init?.method === 'HEAD' ? null : await res.text()
  const stored = new Response(body, {
    status: res.status,
    headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` },
  })
  if (res.status < 500) ctx.waitUntil(cache.put(key, stored.clone()))
  return stored
}

/** `path:` from an electron-builder style yml (latest.yml / latest-android.yml). */
async function feedPath(file, ctx, key = 'path') {
  const res = await cachedFetch(LATEST + file, undefined, ctx)
  if (!res.ok) return null
  const text = await res.text()
  const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(text)
  const name = m ? m[1].trim() : ''
  // Asset names only — never follow an absolute URL or a path out of the release.
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null
}

async function assetExists(name, ctx) {
  const res = await cachedFetch(LATEST + name, { method: 'HEAD' }, ctx)
  return res.status >= 200 && res.status < 400
}

function go(url) {
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
  })
}

function page() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jiyu</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:40em;margin:3em auto;padding:0 1em;background:#0b0b10;color:#eee}a{color:#8ab4ff}code{background:#222;padding:.1em .4em;border-radius:4px}</style>
<h1>Jiyu downloads</h1>
<ul>
<li><a href="/tv">TV APK</a> &mdash; Google TV / Android TV / Fire TV (type <code>jiyu.free-river.workers.dev/tv</code> in the Downloader app)</li>
<li><a href="/apk">Android phone APK</a> (arm64)</li>
<li><a href="/win">Windows installer</a></li>
<li><a href="/nnn">Nationwide live (Roku HLS)</a></li>
<li><a href="${RELEASES}">All files on GitHub</a></li>
</ul>`
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  })
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const path = new URL(request.url).pathname.replace(/\/+$/, '').toLowerCase() || '/'
    if (path === '/') return page()
    if (path === '/tv') {
      if (await assetExists(TV_ASSET, ctx)) return go(LATEST + TV_ASSET)
      const arm64 = await feedPath('latest-android.yml', ctx)
      return go(arm64 ? LATEST + arm64 : RELEASES)
    }
    if (path === '/tv64' || path === '/apk' || path === '/android') {
      const arm64 = await feedPath('latest-android.yml', ctx)
      return go(arm64 ? LATEST + arm64 : RELEASES)
    }
    if (path === '/win' || path === '/windows') {
      const exe = await feedPath('latest.yml', ctx)
      return go(exe ? LATEST + exe : RELEASES)
    }
    if (path === '/nnn' || path === '/nationwide') {
      return go('https://jiyu-nnn.free-river.workers.dev/live.m3u8')
    }
    if (path === '/releases') return go(RELEASES)
    return new Response('Not found', { status: 404 })
  },
}
