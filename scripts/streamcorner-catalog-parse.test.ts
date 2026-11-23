/**
 * Real StreamCorner parser (not a reimplementation).
 * The Android scrape waits until this HTML shape exists.
 * Run: npx tsx scripts/streamcorner-catalog-parse.test.ts
 */
import assert from 'node:assert/strict'
import {
  parseStreamCornerCatalogHtml,
  streamCornerEntryToItem,
} from '../src/lib/streamCorner'

const SPA_SHELL =
  '<!doctype html><html><head><title>StreamCorner</title></head>' +
  '<body><div id="root"></div>' +
  '<script type="module" src="/assets/app.js"></script></body></html>'

const RENDERED = `<!doctype html><html><body>
<div class="min-w-0 h-full">
  <a href="/stream/admin/abc123"><h3>FC Cologne vs. Bayer Leverkusen</h3><p>Bundesliga</p><span>LIVE</span></a>
</div>
<div class="min-w-0 h-full">
  <a href="/stream/admin/family-guy"><h3>Family Guy</h3><p>24/7 STREAMS</p><span>LIVE</span></a>
</div>
<div class="min-w-0 h-full">
  <a href="/stream/admin/nfl-network"><h3>NFL Network</h3><p>24/7 STREAMS</p><span>LIVE</span></a>
</div>
<div class="min-w-0 h-full">
  <a href="/nba/vod/game9"><h3>Lakers vs Celtics</h3><p>NBA</p><span>Final</span></a>
</div>
</body></html>`

const shell = parseStreamCornerCatalogHtml(SPA_SHELL)
assert.equal(shell.length, 0, 'SPA shell must not become catalog rows')

const cards = parseStreamCornerCatalogHtml(RENDERED)
assert.equal(cards.length, 4, `expected 4 cards, got ${cards.map((c) => c.href).join(',')}`)

const live = cards.find((c) => c.href === '/stream/admin/abc123')
assert.ok(live)
assert.equal(live?.title, 'FC Cologne vs. Bayer Leverkusen')
assert.equal(live?.league, 'Bundesliga')
assert.equal(live?.live, true)
assert.equal(live?.provider, 'admin')

const item = streamCornerEntryToItem(live!, Date.parse('2026-11-08T17:10:00Z'))
assert.ok(item, 'live admin card should become a shelf row')
assert.equal(item?.title, 'FC Cologne vs. Bayer Leverkusen · SC')
assert.equal(item?.tags?.includes('streamcorner'), true)
assert.equal(item?.tags?.includes('live-now'), true)
assert.equal(item?.category, 'sports')
assert.doesNotMatch(String(item?.description), /StreamCorner/i)
assert.match(String(item?.description), /\bSC\b/)

const scheduled = streamCornerEntryToItem(
  { ...live!, start: '11/23/26 02:00PM ET', live: true },
  Date.parse('2026-11-23T15:10:00Z'),
)
assert.ok(scheduled, 'dated future card should stay on the shelf as Upcoming')
assert.equal(scheduled?.tags?.includes('upcoming'), true, 'future kickoff must be Upcoming even if the site says LIVE')
assert.equal(scheduled?.tags?.includes('live-now'), false)
assert.ok(Number(scheduled?.eventStartsAt) > Date.parse('2026-11-23T15:10:00Z'))

const guy = cards.find((c) => c.href.includes('family-guy'))
assert.equal(streamCornerEntryToItem(guy!, Date.now()), null, '24/7 non-sports channel stays off the shelf')

const nflNet = cards.find((c) => c.href.includes('nfl-network'))
const nflItem = streamCornerEntryToItem(nflNet!, Date.now())
assert.ok(nflItem, '24/7 sports channels stay on the shelf')
assert.equal(nflItem?.title, 'NFL Network · SC')
assert.equal(nflItem?.tags?.includes('always-live'), true)
assert.equal(nflItem?.tags?.includes('24/7-streams'), true)
assert.equal(nflItem?.tags?.includes('live-now'), false)
assert.equal(nflItem?.eventStartsAt, undefined)
assert.match(String(nflItem?.description), /24\/7/)

const nflNoHeading = streamCornerEntryToItem(
  { ...nflNet!, league: 'NFL', category: 'football', start: undefined, live: true },
  Date.now(),
)
assert.equal(nflNoHeading?.tags?.includes('always-live'), true, 'NFL Network is 24/7 even if the heading scraped as NFL')
assert.equal(nflNoHeading?.tags?.includes('live-now'), false)

const vod = cards.find((c) => c.href.startsWith('/nba/vod/'))
assert.equal(vod?.kind, 'vod')

console.log('streamcorner-catalog-parse: ok', cards.length, 'cards')
