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
  <a href="/nba/vod/game9"><h3>Lakers vs Celtics</h3><p>NBA</p><span>Final</span></a>
</div>
</body></html>`

const shell = parseStreamCornerCatalogHtml(SPA_SHELL)
assert.equal(shell.length, 0, 'SPA shell must not become catalog rows')

const cards = parseStreamCornerCatalogHtml(RENDERED)
assert.equal(cards.length, 3, `expected 3 cards, got ${cards.map((c) => c.href).join(',')}`)

const live = cards.find((c) => c.href === '/stream/admin/abc123')
assert.ok(live)
assert.equal(live?.title, 'FC Cologne vs. Bayer Leverkusen')
assert.equal(live?.league, 'Bundesliga')
assert.equal(live?.live, true)
assert.equal(live?.provider, 'admin')

const item = streamCornerEntryToItem(live!, Date.parse('2026-11-08T17:10:00Z'))
assert.ok(item, 'live admin card should become a shelf row')
assert.equal(item?.tags?.includes('streamcorner'), true)
assert.equal(item?.tags?.includes('live-now'), true)
assert.equal(item?.category, 'sports')

const guy = cards.find((c) => c.href.includes('family-guy'))
assert.equal(streamCornerEntryToItem(guy!, Date.now()), null, '24/7 non-sports channel stays off the shelf')

const vod = cards.find((c) => c.href.startsWith('/nba/vod/'))
assert.equal(vod?.kind, 'vod')

console.log('streamcorner-catalog-parse: ok', cards.length, 'cards')
