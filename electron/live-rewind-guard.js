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
              if (hold) holds.delete(this);
            } else if (!PLAYER_NUDGE.test(st)) {
              if (to < from - 2) {
                holds.set(this, Date.now());
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
