/*
 * Live rewind guard (page world, every frame of the in-app browser).
 *
 * Sports embeds play live HLS through hls.js (JW Player's hlsjs provider,
 * Clappr). After the viewer rewinds, hls.js runs synchronizeToLiveEdge on the
 * next playlist refresh: once currentTime is more than liveMaxLatencyDuration
 * behind the edge it sets media.currentTime back to the live edge, so a rewind
 * is undone a few seconds later. This keeps the rewound position: after a
 * viewer seek backwards, live-edge jumps from synchronizeToLiveEdge are ignored
 * while enough is buffered ahead to last until the next playlist refresh.
 * Many embeds only list ~24 s of segments, so once the rewound buffer is about
 * to run out the jump is let through; holding it into a stall made JW Player
 * tear the provider down ~11 s later and restart the stream timeline at 0.
 * Seeking back near the edge, or the stream reloading, ends the hold. Stall
 * nudges and every other seek are left alone.
 *
 * It also watches live media playlists (no #EXT-X-ENDLIST) to learn how far
 * back the stream keeps segments, exposes that as window.__jiyuLiveInfo(media)
 * for Jiyu's seek overlay, and shows a short notice (window.__jiyuLiveNotice)
 * when a rewind goes past what the stream can serve and playback goes back to
 * live. VOD / replay playlists never count as live.
 *
 * Shared by Electron (electron/main.cjs) and the Android Gecko bridge
 * (generated into jiyu-gecko-bridge/live-rewind-guard.js by
 * scripts/sync-ad-block-list.cjs).
 */
(function () {
  try {
    if (window.__jiyuLiveRewindGuard) return 'bound';
    var P = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    var d = P && Object.getOwnPropertyDescriptor(P, 'currentTime');
    if (!d || typeof d.get !== 'function' || typeof d.set !== 'function') return 'no-media';
    window.__jiyuLiveRewindGuard = true;
    window.__jiyuLiveRewindHeld = 0;
    var holds = new WeakMap();
    var lastSync = new WeakMap();
    var HOLD_MS = 3 * 60 * 60 * 1000;
    var LIVE_SYNC = /synchronizeToLiveEdge/;
    var PLAYER_NUDGE = /_tryNudgeBuffer|_tryFixBufferStall|_trySkipBufferHole|_reportStall/;
    var range = function (m) {
      try {
        var s = m.seekable;
        if (!s || !s.length) return null;
        return { start: s.start(0), end: s.end(s.length - 1) };
      } catch (_) {
        return null;
      }
    };
    var aheadOf = function (m, t) {
      try {
        var b = m.buffered;
        for (var i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.25 && t <= b.end(i)) return b.end(i) - t;
        }
      } catch (_) {}
      return 0;
    };
    var release = function (ev) {
      try {
        if (ev && ev.target) holds.delete(ev.target);
      } catch (_) {}
    };
    document.addEventListener('emptied', release, true);
    document.addEventListener('loadstart', release, true);
    // --- live playlist tracking -------------------------------------------
    var live = { at: 0, win: 0 };
    var LIVE_FRESH_MS = 30000;
    var notePlaylist = function (text) {
      try {
        if (typeof text !== 'string' || text.slice(0, 7) !== '#EXTM3U') return;
        if (text.indexOf('#EXTINF') < 0) return; // master playlist
        if (/#EXT-X-ENDLIST|#EXT-X-PLAYLIST-TYPE:VOD/.test(text)) {
          live.at = 0;
          return;
        }
        var sum = 0;
        var re = /#EXTINF:\s*([\d.]+)/g;
        var m;
        while ((m = re.exec(text))) sum += Number(m[1]) || 0;
        live.at = Date.now();
        live.win = sum;
      } catch (_) {}
    };
    try {
      var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      var xsend = XP && XP.send;
      if (xsend) {
        var onXhrLoad = function () {
          try {
            var rt = this.responseType;
            if (rt === '' || rt === 'text') notePlaylist(this.responseText);
          } catch (_) {}
        };
        XP.send = function () {
          try {
            this.addEventListener('load', onXhrLoad);
          } catch (_) {}
          return xsend.apply(this, arguments);
        };
      }
      var f0 = window.fetch;
      if (typeof f0 === 'function') {
        window.fetch = function (input) {
          var p = f0.apply(this, arguments);
          try {
            var u = typeof input === 'string' ? input : (input && input.url) || '';
            p.then(function (res) {
              try {
                var ct = (res.headers && res.headers.get('content-type')) || '';
                if (/m3u8/i.test(u) || /mpegurl/i.test(ct)) res.clone().text().then(notePlaylist, function () {});
              } catch (_) {}
            }, function () {});
          } catch (_) {}
          return p;
        };
      }
    } catch (_) {}
    var bufferStart = function (m, t) {
      try {
        var b = m.buffered;
        for (var i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.25 && t <= b.end(i) + 0.25) return b.start(i);
        }
      } catch (_) {}
      return t;
    };
    /** Live window for a media element, or null when it is not a live stream. */
    var liveInfo = function (m, at) {
      try {
        if (!live.at || Date.now() - live.at > LIVE_FRESH_MS || !(live.win > 0)) return null;
        var dur = Number(m.duration);
        if (!isFinite(dur) || dur <= 0) return null;
        var r = range(m);
        var edge = r && isFinite(r.end) && r.end > 0 ? r.end : dur;
        var cur = isFinite(at) ? at : Number(d.get.call(m));
        var lo = Math.min(edge - live.win, bufferStart(m, cur));
        if (r && isFinite(r.start)) lo = Math.max(lo, r.start);
        lo = Math.max(0, lo);
        return { win: live.win, edge: edge, lo: lo, cur: cur, room: cur - lo, reach: edge - lo };
      } catch (_) {
        return null;
      }
    };
    window.__jiyuLiveInfo = function (m) {
      return m ? liveInfo(m) : null;
    };
    // --- notice -----------------------------------------------------------
    var NOTICE_ID = 'jiyu-live-rewind-notice';
    var NOTICE_GAP_MS = 8000;
    var lastNotice = 0;
    var noticeTimer = 0;
    var noticeFade = 0;
    var showNotice = function (kind, info) {
      try {
        var now = Date.now();
        if (now - lastNotice < NOTICE_GAP_MS) return false;
        lastNotice = now;
        var secs = info && isFinite(info.reach) ? Math.round(info.reach) : 0;
        var span = secs >= 3 ? 'about ' + secs + ' seconds' : 'a few seconds';
        var text =
          'Live streams only allow rewinding ' +
          span +
          (kind === 'limit' ? ' \u2014 this is as far back as it goes.' : ' \u2014 jumping back to live.');
        var el = document.getElementById(NOTICE_ID);
        if (!el) {
          el = document.createElement('div');
          el.id = NOTICE_ID;
          el.setAttribute('role', 'status');
          el.setAttribute('aria-live', 'polite');
          var st = el.style;
          st.position = 'fixed';
          st.left = '50%';
          st.bottom = '16%';
          st.transform = 'translateX(-50%)';
          st.zIndex = '2147483647';
          st.maxWidth = 'min(88vw, 32rem)';
          st.padding = '0.55rem 1rem';
          st.borderRadius = '999px';
          st.border = '1px solid rgba(255,255,255,0.18)';
          st.background = 'rgba(8,10,14,0.88)';
          st.color = '#f4f4f5';
          st.font = '600 0.8rem/1.35 system-ui, sans-serif';
          st.textAlign = 'center';
          st.boxShadow = '0 10px 28px rgba(0,0,0,0.45)';
          st.pointerEvents = 'none';
          st.opacity = '0';
          st.transition = 'opacity 300ms ease';
        }
        el.textContent = text;
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        var host = fs && fs.tagName !== 'VIDEO' ? fs : document.body || document.documentElement;
        if (el.parentNode !== host) host.appendChild(el);
        window.clearTimeout(noticeTimer);
        window.clearTimeout(noticeFade);
        // Next frame so the opacity transition runs on a fresh node.
        window.setTimeout(function () {
          el.style.opacity = '1';
        }, 16);
        noticeTimer = window.setTimeout(function () {
          el.style.opacity = '0';
          noticeFade = window.setTimeout(function () {
            try {
              if (el.parentNode) el.parentNode.removeChild(el);
            } catch (_) {}
          }, 400);
        }, 3500);
        window.__jiyuLiveRewindNotices = (window.__jiyuLiveRewindNotices || 0) + 1;
        return true;
      } catch (_) {
        return false;
      }
    };
    window.__jiyuLiveNotice = function (kind, m) {
      var info = m ? liveInfo(m) : null;
      if (!info) return false;
      return showNotice(kind, info);
    };
    var stack = function () {
      try {
        return String(new Error().stack || '');
      } catch (_) {
        return '';
      }
    };
    Object.defineProperty(P, 'currentTime', {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        return d.get.call(this);
      },
      set: function (value) {
        try {
          var to = Number(value);
          var from = Number(d.get.call(this));
          if (isFinite(to) && isFinite(from)) {
            var st = stack();
            if (LIVE_SYNC.test(st)) {
              var hold = holds.get(this);
              var now = Date.now();
              var prev = lastSync.get(this);
              lastSync.set(this, now);
              // Playlist refresh interval (sync runs once per level load).
              var every = prev ? Math.min(15, Math.max(2, (now - prev) / 1000)) : 8;
              var r = range(this);
              if (
                hold &&
                now - hold < HOLD_MS &&
                to > from + 1 &&
                r &&
                from >= r.start + 0.5 &&
                from <= r.end &&
                aheadOf(this, from) > every + 2
              ) {
                window.__jiyuLiveRewindHeld += 1;
                return;
              }
              if (hold) {
                holds.delete(this);
                // The rewound point ran out / left the window: back to live.
                if (to > from + 1) {
                  var li = liveInfo(this, from);
                  if (li) showNotice('live', li);
                }
              }
            } else if (!PLAYER_NUDGE.test(st)) {
              if (to < from - 2) {
                holds.set(this, Date.now());
                // Site controls / keyboard rewinding past what the stream keeps.
                var li2 = liveInfo(this, from);
                if (li2 && to < li2.lo - 0.5) showNotice('live', li2);
              } else if (to > from) {
                var r2 = range(this);
                if (!r2 || r2.end - to < 12) holds.delete(this);
              }
            }
          }
        } catch (_) {}
        return d.set.call(this, value);
      },
    });
    return 'guarded';
  } catch (_) {
    return 'error';
  }
})();
