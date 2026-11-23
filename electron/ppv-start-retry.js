/*
 * PPV.st mirror embeds (taifood-blog.asia/embed/... and the other rotating hosts) start
 * JW Player, but on roughly half of the loads JW's hls.js reads the playlists and never
 * asks for the first segment: the <video> keeps a live window (seekable) with nothing
 * buffered, JW sits in "buffering", and ~12 s later the page swaps to its Clappr backup,
 * which plays one segment, stalls for seconds, and reloads itself over and over.
 *
 * This frame script notices that stuck start (or the swap to Clappr) and quietly reloads
 * the embed, at most once per event within a few minutes. After that it keeps whatever
 * plays. If JW started fine but the page later swaps to Clappr anyway (the source
 * hiccuped and JW gave up), it reloads for JW again, at most once in ten minutes.
 * While it retries, a silent black cover (pointer-events: none, no "Unwrapping" text —
 * Jiyu already owns that cover once per play) hides the reload. Volume and mute are
 * restored by Jiyu's usual per-load scripts (wheel volume + webContents audio mute).
 *
 * Only runs on pages that carry the PPV player's own __switchToClappr hook, so other
 * embeds, StreamFree included, are untouched. Safe to inject repeatedly; when injected
 * before the player script (Android content script at document_start) it polls for the
 * hook for a few seconds.
 *
 * Shared by Electron (electron/main.cjs) and the Android Gecko bridge (generated into
 * jiyu-gecko-bridge/ppv-start-retry.js by scripts/sync-ad-block-list.cjs).
 */
(function () {
  var start = function () {
    if (window.__jiyuPpvStartRetry) return 'ppv-retry:bound'
    if (typeof window.__switchToClappr !== 'function' && !window.Clappr) return 'ppv-retry:wait'
    window.__jiyuPpvStartRetry = 1

    // One silent reload max — more than that looked like triple "Unwrapping".
    var MAX_RELOADS = 1
    var STUCK_MS = 5000 // live window known, nothing buffered, JW "buffering"
    var GIVE_UP_MS = 45000 // stop watching this document after this long
    var MEMORY_MS = 180000 // reload count is forgotten after this long
    var MAX_SWAP_RELOADS = 1 // reloads when Clappr takes over after JW was already playing
    var SWAP_MEMORY_MS = 600000
    var SWAP_KEY = '__jiyuPpvSwap:' + location.pathname
    var COVER_ID = '__jiyu_ppv_retry_cover'
    var KEY = '__jiyuPpvRetry:' + location.pathname
    var store = null
    try {
      store = window.sessionStorage
    } catch (_) {}
    var readStore = function (key, memoryMs) {
      try {
        var o = JSON.parse((store && store.getItem(key)) || 'null')
        if (o && typeof o.n === 'number' && Date.now() - o.at < memoryMs) return o.n
      } catch (_) {}
      return 0
    }
    var writeStore = function (key, n) {
      try {
        if (!store) return
        if (n > 0) store.setItem(key, JSON.stringify({ n: n, at: Date.now() }))
        else store.removeItem(key)
      } catch (_) {}
    }
    var readCount = function () {
      return readStore(KEY, MEMORY_MS)
    }
    var writeCount = function (n) {
      writeStore(KEY, n)
    }
    var count = readCount()

    var showCover = function () {
      try {
        // Prefer Jiyu's own unwrap cover when it is still up — do not stack another.
        if (document.getElementById('__jiyu_unwrap_cover')) return
        if (document.getElementById(COVER_ID)) return
        var root = document.body || document.documentElement
        if (!root) return
        var c = document.createElement('div')
        c.id = COVER_ID
        c.setAttribute(
          'style',
          'position:fixed;inset:0;z-index:2147483646;background:#000;pointer-events:none',
        )
        root.appendChild(c)
      } catch (_) {}
    }
    var hideCover = function () {
      try {
        var c = document.getElementById(COVER_ID)
        if (c && c.parentNode) c.parentNode.removeChild(c)
      } catch (_) {}
    }
    // A retry is in progress: keep the stream hidden until it really plays.
    if (count > 0) showCover()

    var pickVideo = function () {
      var vids = document.getElementsByTagName('video')
      var best = null
      var area = 0
      for (var i = 0; i < vids.length; i++) {
        var r = vids[i].getBoundingClientRect()
        var a = r.width * r.height
        if (a >= area) {
          area = a
          best = vids[i]
        }
      }
      return best
    }
    // GeckoView cannot play native HLS. When JW/Clappr leaves <video src="….m3u8">
    // (MEDIA_ERR_SRC_NOT_SUPPORTED / "No video with supported format and MIME type"),
    // attach hls.js over MSE so the same URL plays.
    var HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'
    var loadHlsJs = function (cb) {
      try {
        if (window.Hls && Hls.isSupported) {
          cb(true)
          return
        }
      } catch (_) {}
      if (window.__jiyuHlsLoading) {
        var waits = 0
        var wait = window.setInterval(function () {
          waits++
          try {
            if (window.Hls && Hls.isSupported) {
              window.clearInterval(wait)
              cb(true)
              return
            }
          } catch (_) {}
          if (waits >= 40) {
            window.clearInterval(wait)
            cb(false)
          }
        }, 250)
        return
      }
      window.__jiyuHlsLoading = 1
      try {
        var s = document.createElement('script')
        s.src = HLS_CDN
        s.async = true
        s.onload = function () {
          window.__jiyuHlsLoading = 0
          cb(true)
        }
        s.onerror = function () {
          window.__jiyuHlsLoading = 0
          cb(false)
        }
        ;(document.head || document.documentElement).appendChild(s)
      } catch (_) {
        window.__jiyuHlsLoading = 0
        cb(false)
      }
    }
    var fixBareM3u8 = function (v) {
      try {
        if (!v || v.__jiyuHlsFix) return false
        var src = String(v.currentSrc || v.src || '')
        if (!/\.m3u8(\?|$)/i.test(src)) return false
        var er = v.error && v.error.code
        // error 4 = SRC_NOT_SUPPORTED (MIME dialog). Also catch NETWORK_NO_SOURCE
        // before Gecko paints the sad-face chrome.
        if (er !== 4 && !(v.readyState < 2 && v.networkState === 3)) return false
        v.__jiyuHlsFix = 1
        loadHlsJs(function (ok) {
          try {
            if (!ok || !window.Hls || !Hls.isSupported()) return
            var h = new Hls({ enableWorker: true, lowLatencyMode: true })
            h.loadSource(src)
            h.attachMedia(v)
            h.on(Hls.Events.MANIFEST_PARSED, function () {
              try {
                var p = v.play()
                if (p && p.catch) p.catch(function () {})
              } catch (_) {}
            })
          } catch (_) {}
        })
        return true
      } catch (_) {
        return false
      }
    }
    var jwState = function () {
      try {
        var p = typeof window.jwplayer === 'function' ? window.jwplayer() : null
        return p && typeof p.getState === 'function' ? String(p.getState() || '') : ''
      } catch (_) {
        return ''
      }
    }

    var t0 = Date.now()
    var stuckSince = 0
    var lastT = -1
    var moving = 0
    var playing = false
    var timer = 0
    var done = function () {
      window.clearInterval(timer)
      hideCover()
    }
    var reload = function (why) {
      window.clearInterval(timer)
      writeCount(count + 1)
      showCover()
      try {
        console.log('[jiyu-ppv-retry] reload ' + (count + 1) + '/' + MAX_RELOADS + ' (' + why + ')')
      } catch (_) {}
      location.reload()
    }
    timer = window.setInterval(function () {
      try {
        var now = Date.now()
        var v = pickVideo()
        var onClappr = !!window.Clappr
        if (v) fixBareM3u8(v)
        // Playing for real (time advancing on consecutive checks) on JW: done.
        if (v && !v.paused && v.readyState >= 2) {
          var t = v.currentTime || 0
          moving = lastT >= 0 && t - lastT > 0.05 && t - lastT < 5 ? moving + 1 : 0
          lastT = t
        } else {
          moving = 0
          lastT = v ? v.currentTime || 0 : -1
        }
        if (playing) {
          // Already had real frames — mid-stream JW "buffering" is normal; never
          // reload/black-cover again. Only Clappr takeover after play may retry once.
          if (onClappr) {
            var sw = readStore(SWAP_KEY, SWAP_MEMORY_MS)
            if (sw < MAX_SWAP_RELOADS) {
              writeStore(SWAP_KEY, sw + 1)
              reload('clappr-after-play')
            } else window.clearInterval(timer)
          }
          return
        }
        if (!onClappr && moving >= 3) {
          writeCount(0)
          hideCover()
          playing = true
          return
        }
        if (count >= MAX_RELOADS) {
          // Out of retries: keep whatever plays, drop our cover once anything moves.
          if (moving >= 3 || now - t0 > GIVE_UP_MS) {
            writeCount(0)
            done()
          }
          return
        }
        if (onClappr) {
          reload('clappr')
          return
        }
        // Start-only stuck: empty buffer + JW buffering before first frame.
        // Do not treat a mid-match rebuffer the same (playing gate above).
        var stuck =
          v &&
          v.readyState < 2 &&
          v.buffered.length === 0 &&
          v.seekable.length > 0 &&
          jwState() === 'buffering'
        if (stuck) {
          if (!stuckSince) stuckSince = now
          if (now - stuckSince >= STUCK_MS) {
            reload('jw-stuck')
            return
          }
        } else stuckSince = 0
        // Never got going on JW and never swapped: stop the start watch, keep the swap watch.
        if (now - t0 > GIVE_UP_MS) {
          hideCover()
          playing = true
        }
      } catch (_) {}
    }, 500)
    return 'ppv-retry:watching'
  }
  try {
    if (window.__jiyuPpvStartRetry) return 'ppv-retry:bound'
    if (!/^\/embed\//i.test(location.pathname || '')) return 'ppv-retry:skip'
    if (/(^|\.)(strmfree|streamfree)\./i.test(location.hostname || '')) return 'ppv-retry:skip'
    var r = start()
    if (r === 'ppv-retry:wait' && !window.__jiyuPpvStartRetryPoll) {
      window.__jiyuPpvStartRetryPoll = 1
      var tries = 0
      var poll = window.setInterval(function () {
        try {
          tries++
          if (start() !== 'ppv-retry:wait' || tries >= 40) window.clearInterval(poll)
        } catch (_) {
          window.clearInterval(poll)
        }
      }, 500)
    }
    return r
  } catch (_) {
    return 'ppv-retry:error'
  }
})()
