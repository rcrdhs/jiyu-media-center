/**
 * The blue atlantic.st screen is the site's error page, not a video.
 * These checks lock the detection used to avoid loading that page.
 */
import assert from 'node:assert/strict'
import {
  isAtlanticWarpPlaylistError,
  isStreamRefererDocumentUrl,
  looksLikeAtlanticWarpPage,
} from '../src/lib/atlanticHls.ts'

assert.equal(
  looksLikeAtlanticWarpPage(
    '<html><title>atlantic.st</title><p>using Cloudflare Warp VPN, please disable it, and refresh</p></html>',
  ),
  true,
)
assert.equal(
  looksLikeAtlanticWarpPage('atlantic.st\nPlease disable Cloudflare Warp and refresh this page'),
  true,
)
assert.equal(looksLikeAtlanticWarpPage('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example/a.m3u8'), false)
assert.equal(looksLikeAtlanticWarpPage(''), false)

assert.equal(isStreamRefererDocumentUrl('https://atlantic.st/'), true)
assert.equal(isStreamRefererDocumentUrl('https://www.atlantic.st/watch/1'), true)
assert.equal(isStreamRefererDocumentUrl('https://player.movy.sx/e/1'), true)
assert.equal(isStreamRefererDocumentUrl('https://route.transcode.cfd/proxy/master.m3u8'), false)
assert.equal(isStreamRefererDocumentUrl('not a url'), false)

assert.equal(isAtlanticWarpPlaylistError('Atlantic Warp interstitial (not HLS)'), true)
assert.equal(isAtlanticWarpPlaylistError('Network error — stream offline'), false)

console.log('atlantic page checks passed')
