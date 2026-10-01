const fs = require('fs')
const path = require('path')

// Inline the parse function from m2box.ts for a quick check
function parseM2BoxSubjectIdFromHtml(html) {
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (match) {
    try {
      const data = JSON.parse(match[1])
      for (const entry of data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const obj = entry
        if (!('subjectId' in obj)) continue
        const titleOk =
          typeof obj.title === 'string' ||
          typeof obj.title === 'number' ||
          typeof obj.detailPath === 'string' ||
          typeof obj.detailPath === 'number'
        if (!titleOk) continue

        const sidRef = obj.subjectId
        let sid = sidRef
        if (typeof sidRef === 'number' && sidRef >= 0 && sidRef < data.length) {
          sid = data[sidRef]
          if (
            Array.isArray(sid) &&
            sid.length === 2 &&
            typeof sid[0] === 'string' &&
            /^(?:Shallow)?Reactive|Ref$/i.test(sid[0])
          ) {
            const inner = sid[1]
            sid = typeof inner === 'number' && inner >= 0 && inner < data.length ? data[inner] : inner
          }
        }
        if (typeof sid === 'string' && /^\d{10,}$/.test(sid)) return sid
        if (typeof sid === 'number' && Number.isFinite(sid) && sid >= 1e10) {
          return String(Math.trunc(sid))
        }
      }
    } catch {}
  }
  const quoted = html.match(/"subjectId"\s*:\s*"(\d{10,})"/)
  return quoted?.[1] ?? null
}

;(async () => {
  const html = await fetch('https://m2box.org/detail/clean-up-company-OrvX6rLJg76', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text())
  const sid = parseM2BoxSubjectIdFromHtml(html)
  console.log('parsed subjectId', sid)

  const slug = 'clean-up-company-OrvX6rLJg76'
  const referer = `https://m2box.org/movies/${slug}?id=${sid}&type=/movie/detail&detailSe=1&detailEp=1&lang=en`
  const url = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subject_id=${sid}&se=1&ep=1`
  const j = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://m2box.org',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
    },
  }).then((r) => r.json())
  console.log('streams', j?.data?.streams?.length, j?.data?.streams?.[0]?.resolutions)
})()
