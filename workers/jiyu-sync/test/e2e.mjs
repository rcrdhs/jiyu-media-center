// End-to-end test for the deployed jiyu-sync Worker. Never prints tokens.
const BASE = process.env.SYNC_URL || 'https://jiyu-sync.free-river.workers.dev'
let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++ }
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
const h = await call('GET', '/v1/health'); ok(h.status === 200 && h.data.ok, 'health')
const httpRes = await fetch(BASE.replace('https:', 'http:') + '/v1/health', { redirect: 'manual' }).catch(() => null)
ok(!httpRes || httpRes.status !== 200 || !(await httpRes.json().catch(() => ({}))).ok, `plain http refused/redirected (status ${httpRes?.status})`)
const A = await call('POST', '/v1/auth/register', { body: { label: 'e2e Desktop' } })
ok(A.status === 200 && /^jys_/.test(A.data.token) && A.data.token.length >= 47, 'register returns 32-byte token')
ok(/^[A-Z2-9]{8}$/.test(A.data.pairCode) && A.data.pairCodeExpiresAt - Date.now() > 9 * 60e3, 'pair code 8 chars, ~10 min expiry')
const tA = A.data.token
const bad = await call('POST', '/v1/auth/pair', { body: { code: 'ZZZZZZZZ', label: 'x' } }); ok(bad.status === 404, 'wrong pair code rejected')
const B = await call('POST', '/v1/auth/pair', { body: { code: A.data.pairCode.slice(0, 4) + '-' + A.data.pairCode.slice(4).toLowerCase(), label: 'e2e Phone' } })
ok(B.status === 200 && B.data.userId === A.data.userId && B.data.token !== tA, 'pair second device (same account)')
const tB = B.data.token
const reuse = await call('POST', '/v1/auth/pair', { body: { code: A.data.pairCode, label: 'again' } }); ok(reuse.status === 404, 'pair code is single-use')
const p1 = await call('PUT', '/v1/progress', { token: tA, body: { entries: [
  { id: 'tmdb:movie:1', title: 'Movie One', category: 'movies', playlistIndex: 0, currentTime: 600, duration: 6000, ageMs: 1000 },
  { id: 'tmdb:tv:2', title: 'Show Two', category: 'series', playlistIndex: 3, currentTime: 120, duration: 1400, ageMs: 0 },
] } })
ok(p1.status === 200 && p1.data.results.every((r) => r.accepted) && p1.data.rev === 1, `push 2 rows -> rev ${p1.data?.rev}`)
const g1 = await call('GET', '/v1/progress?since=0', { token: tB })
ok(g1.status === 200 && g1.data.entries.length === 2 && g1.data.rev === 1, 'device B pulls both rows')
ok(Math.abs(g1.data.now - Date.now()) < 120e3 && g1.data.entries.every((e) => e.updatedAt <= g1.data.now), 'server-stamped updatedAt')
const g2 = await call('GET', '/v1/progress?since=1', { token: tB }); ok(g2.data.entries.length === 0, 'since=rev returns nothing new')
const p2 = await call('PUT', '/v1/progress', { token: tB, body: { entries: [{ id: 'tmdb:tv:2', title: 'Show Two', category: 'series', playlistIndex: 4, currentTime: 30, duration: 1400, ageMs: 0 }] } })
ok(p2.data.results[0].accepted && p2.data.rev === 2, 'B updates a row -> rev 2')
const stale = await call('PUT', '/v1/progress', { token: tA, body: { entries: [{ id: 'tmdb:tv:2', title: 'Show Two', category: 'series', playlistIndex: 3, currentTime: 999, ageMs: 3600e3 }] } })
ok(stale.data.results[0].accepted === false && stale.data.results[0].current.playlistIndex === 4, 'older edit rejected, server row returned')
const g3 = await call('GET', '/v1/progress?since=1', { token: tA }); ok(g3.data.entries.length === 1 && g3.data.entries[0].playlistIndex === 4, 'A incremental pull gets only the changed row')
const del = await call('PUT', '/v1/progress', { token: tA, body: { entries: [{ id: 'tmdb:movie:1', deleted: true, category: 'movies', ageMs: 0 }] } })
ok(del.data.results[0].accepted && del.data.results[0].deleted, 'delete via single PUT tombstone')
const g4 = await call('GET', `/v1/progress?since=${p2.data.rev}`, { token: tB }); ok(g4.data.entries.length === 1 && g4.data.entries[0].deleted === true, 'B sees tombstone')
const big = await call('PUT', '/v1/progress', { token: tA, body: { entries: Array.from({ length: 101 }, (_, i) => ({ id: `x${i}` })) } }); ok(big.status === 413, 'over 100 rows rejected')
const devs = await call('GET', '/v1/devices', { token: tA })
ok(devs.data.devices.length === 2 && devs.data.devices.filter((d) => d.current).length === 1, 'device list shows 2, one current')
const idB = devs.data.devices.find((d) => !d.current).id
const rv = await call('DELETE', `/v1/devices/${idB}`, { token: tA }); ok(rv.status === 200, 'revoke device B')
const after = await call('GET', '/v1/progress?since=0', { token: tB }); ok(after.status === 401, 'revoked token -> 401')
const nobody = await call('GET', '/v1/progress', {}); ok(nobody.status === 401, 'no token -> 401')
const pc = await call('POST', '/v1/auth/pair-code', { token: tA }); ok(pc.status === 200 && pc.data.pairCode !== A.data.pairCode, 'new pair code issued')
const so = await call('POST', '/v1/auth/signout', { token: tA }); ok(so.status === 200, 'last device signs out (account removed)')
const gone = await call('GET', '/v1/devices', { token: tA }); ok(gone.status === 401, 'signed-out token -> 401')
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
