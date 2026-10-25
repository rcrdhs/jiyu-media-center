/* Jiyu bridge background: cancel requests to the shared ad / popunder / adware list
 * (self.JIYU_AD_BLOCK from ad-block-list.js, generated from electron/ad-block-list.json)
 * so their scripts are never downloaded in GeckoView. */
(function () {
  'use strict'
  var list = self.JIYU_AD_BLOCK || { hosts: [], urlPatterns: [] }
  var hosts = new Set((list.hosts || []).map(function (h) { return String(h).toLowerCase() }))
  var patterns = (list.urlPatterns || [])
    .map(function (p) { try { return new RegExp(p, 'i') } catch (e) { return null } })
    .filter(Boolean)
  function isListed(url) {
    var host
    try {
      var u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return false
      host = u.hostname.toLowerCase().replace(/^www\./, '')
    } catch (e) {
      return false
    }
    for (var h = host; h; ) {
      if (hosts.has(h)) return true
      var dot = h.indexOf('.')
      if (dot < 0) break
      h = h.slice(dot + 1)
    }
    for (var i = 0; i < patterns.length; i++) if (patterns[i].test(url)) return true
    return false
  }
  try {
    browser.webRequest.onBeforeRequest.addListener(
      function (details) { return isListed(details.url) ? { cancel: true } : {} },
      { urls: ['<all_urls>'] },
      ['blocking']
    )
  } catch (e) {
    /* webRequest unavailable: Java-side navigation checks still apply */
  }
})()
