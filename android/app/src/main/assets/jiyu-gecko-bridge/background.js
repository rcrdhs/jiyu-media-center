/* Jiyu bridge background: cancel requests to the shared ad / popunder / adware list
 * (self.JIYU_AD_BLOCK from ad-block-list.js, generated from electron/ad-block-list.json)
 * so their scripts are never downloaded in GeckoView.
 * Soft-allow Google ad networks on Playmogo / LiveXTV / sports embeds — those hosts
 * refuse playback when googlesyndication is blocked (mirrors electron soft shield). */
(function () {
  'use strict'
  var list = self.JIYU_AD_BLOCK || { hosts: [], urlPatterns: [] }
  var hosts = new Set((list.hosts || []).map(function (h) { return String(h).toLowerCase() }))
  var patterns = (list.urlPatterns || [])
    .map(function (p) { try { return new RegExp(p, 'i') } catch (e) { return null } })
    .filter(Boolean)
  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    } catch (e) {
      return ''
    }
  }
  function isGoogleAds(url) {
    var h = hostOf(url)
    return /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|googletagservices\.com|googletagmanager\.com)$/i.test(h)
  }
  function isPpvAntiAdblockLoader(url) {
    var h = hostOf(url)
    if (!/(^|\.)(wpnxiswpuyrfn\.icu|vbcojhroxkoaf\.online)$/i.test(h)) return false
    try {
      var u = new URL(url)
      var path = (u.pathname || '') + (u.search || '')
      return /\/script\/|\/d3\.php|selAdType|selPath|adbVersion|cdnPath|kl1Mnopq/i.test(path)
    } catch (e) {
      return false
    }
  }
  function isReplaySoft(url) {
    var h = hostOf(url)
    if (!h) return false
    if (h === 'playmogo.com' || h.endsWith('.playmogo.com')) return true
    if (h === 'playmate.to' || h.endsWith('.playmate.to')) return true
    if (h === 'soccerfull.net' || h.endsWith('.soccerfull.net')) return true
    if (h.indexOf('livextv') >= 0) return true
    if (h === 'footreplays.com' || h.endsWith('.footreplays.com')) return true
    if (h === 'fullmatchshows.com' || h.endsWith('.fullmatchshows.com')) return true
    if (/(^|\.)(embed(?:hd)?\.st|embedindia\.st|streamed\.pk|ppv\.st|ppvservices\.st)$/i.test(h)) return true
    if (/(^|\.)(streamcorner|strmcrnr|streamninja)\.(st|foo|cloud|fun|top)$/i.test(h)) return true
    try {
      var path = new URL(url).pathname || ''
      if (/^\/[de]\/[a-z0-9]{6,}/i.test(path)) return true
      if (/^\/embed\/[a-z0-9]/i.test(path)) return true
    } catch (e) {}
    return false
  }
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
      function (details) {
        var url = details && details.url
        if (!url || !isListed(url)) return {}
        var page = details.documentUrl || details.originUrl || details.initiator || ''
        if (isReplaySoft(page) && (isGoogleAds(url) || isPpvAntiAdblockLoader(url))) return {}
        // PPV loaders may not be on the shared list but still need a soft allow
        // when Java-side hijack checks would cancel them.
        if (isPpvAntiAdblockLoader(url) && isReplaySoft(page)) return {}
        return { cancel: true }
      },
      { urls: ['<all_urls>'] },
      ['blocking']
    )
  } catch (e) {
    /* webRequest unavailable: Java-side navigation checks still apply */
  }
})()
