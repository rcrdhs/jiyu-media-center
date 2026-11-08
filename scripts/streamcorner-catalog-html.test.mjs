/**
 * StreamCorner catalog HTML: the SPA shell has no watch links, and a rendered
 * card is what Android waits for and what parseStreamCornerCatalogHtml reads.
 * Run: node --test scripts/streamcorner-catalog-html.test.mjs
 *
 * Mirrors StreamCornerScrape.htmlHasWatchLinks (the Android scrape gate).
 * The parser check is scripts/streamcorner-catalog-parse.test.ts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

function htmlHasWatchLinks(html) {
  if (html == null || html.length < 40) return false
  return (
    html.includes('href="/stream/') ||
    html.includes("href='/stream/") ||
    html.includes('href="/nba/') ||
    html.includes("href='/nba/")
  )
}

const SPA_SHELL =
  '<!doctype html><html><head><title>StreamCorner</title></head>' +
  '<body><div id="root"></div>' +
  '<script type="module" src="/assets/app.js"></script></body></html>'

test('SPA shell is not a finished StreamCorner catalog', () => {
  assert.equal(htmlHasWatchLinks(SPA_SHELL), false)
  assert.equal(SPA_SHELL.includes('/stream/'), false)
  assert.equal(SPA_SHELL.includes('id="root"'), true)
})

test('root-relative watch hrefs are the ready signal', () => {
  const card =
    '<html><body><div class="min-w-0 h-full">' +
    '<a href="/stream/admin/abc123"><h3>FC Cologne vs. Bayer Leverkusen</h3>' +
    '<p>Bundesliga</p><span>LIVE</span></a></div></body></html>'
  assert.equal(htmlHasWatchLinks(card), true)
  assert.equal(htmlHasWatchLinks('<html><body><a href=\'/nba/vod/x\'>pad pad pad pad pad</a></body></html>'), true)
})

test('absolute watch hrefs are not the ready signal', () => {
  const html =
    SPA_SHELL.replace('</body>', '<a href="https://streamcorner.fun/stream/admin/x">x</a></body>')
  assert.equal(htmlHasWatchLinks(html), false)
})
