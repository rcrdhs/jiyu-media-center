/**
 * Probe PPV mirrors: site/API reachability + HLS segment status for a live game.
 */
const MIRRORS = [
  'https://ppv.st',
  'https://ppv.tj',
  'https://ppvs.pk',
  'https://ppv.rw',
  'https://ppv.ms',
  'https://ppv.bi',
  'https://ppv.ug',
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

async function fetchText(url, headers = {}, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      ok: res.ok,
      status: res.status,
      final: res.url,
      len: buf.length,
      text: buf.toString('utf8'),
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      final: url,
      len: 0,
      text: '',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(t)
  }
}

function pickLiveStream(apiJson) {
  const now = Math.floor(Date.now() / 1000)
  const streams = apiJson?.streams
  if (!Array.isArray(streams)) return null
  const candidates = []
  for (const cat of streams) {
    for (const s of cat.streams || []) {
      const start = Number(s.starts_at) || 0
      const end = Number(s.ends_at) || 0
      const live = s.always_live || (start > 0 && start <= now && (!end || end >= now))
      if (!live || !s.iframe) continue
      if (end && end - now < 20 * 60) continue
      candidates.push({
        name: s.name,
        iframe: s.iframe,
        uri: s.uri_name,
        end,
        left: end ? end - now : null,
        category: cat.category,
      })
    }
  }
  candidates.sort((a, b) => (b.left ?? 0) - (a.left ?? 0))
  return candidates.find((c) => /vs\.|vs /i.test(c.name)) || candidates[0] || null
}

async function probeMirror(origin) {
  const row = { origin, site: null, api: null, pick: null, embed: null, m3u8: null, ts: null }
  const site = await fetchText(origin + '/', { Accept: 'text/html', Referer: origin + '/' })
  row.site = {
    status: site.status,
    len: site.len,
    error: site.error,
    finalHost: (() => {
      try {
        return new URL(site.final).host
      } catch {
        return ''
      }
    })(),
  }

  // Try common API hosts / paths used by ppv.st
  const apiCandidates = [
    origin.replace(/^(https?:\/\/)(?:www\.)?/, '$1api.'),
    origin,
  ]
  const apiPaths = ['/api/streams', '/api/stream', '/streams']
  let apiHit = null
  let apiJson = null
  for (const base of apiCandidates) {
    for (const path of apiPaths) {
      const url = base.replace(/\/$/, '') + path
      const res = await fetchText(url, {
        Accept: 'application/json',
        Referer: origin + '/',
        Origin: origin,
      })
      if (!res.ok) continue
      try {
        const json = JSON.parse(res.text)
        if (json && (json.streams || json.success || Array.isArray(json))) {
          apiHit = { url, status: res.status, len: res.len }
          apiJson = json
          break
        }
      } catch {
        /* not json */
      }
    }
    if (apiHit) break
  }
  row.api = apiHit || { status: 0, error: 'no streams api' }

  if (!apiJson) return row

  const pick = pickLiveStream(apiJson)
  if (!pick) {
    row.pick = { error: 'no live iframe' }
    return row
  }
  row.pick = { name: pick.name, left: pick.left, category: pick.category }

  // Rewrite iframe host to this mirror's embed host when possible
  let iframe = pick.iframe
  try {
    const u = new URL(iframe)
    // Keep embedindia / whatever the API returned — mirrors often share embeds
    iframe = u.toString()
  } catch {
    /* ignore */
  }

  const emb = await fetchText(iframe, {
    Accept: 'text/html',
    Referer: origin + '/',
  })
  row.embed = {
    host: (() => {
      try {
        return new URL(iframe).host
      } catch {
        return ''
      }
    })(),
    status: emb.status,
    len: emb.len,
    error: emb.error,
  }

  return row
}

async function main() {
  const results = []
  for (const origin of MIRRORS) {
    process.stdout.write(`checking ${origin}...\n`)
    try {
      results.push(await probeMirror(origin))
    } catch (err) {
      results.push({
        origin,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  console.log(JSON.stringify({ now: new Date().toISOString(), results }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
