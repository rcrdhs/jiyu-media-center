/* Eval bridge — all frames connect so autoplay can reach cross-origin embed players. */
(function () {
  function runCode(code) {
    return new Promise(function (resolve) {
      var src = String(code || "");
      // 1) Content-script world: sees page DOM (video.play works) and returns values.
      //    CSP cannot block this the way inline <script> inject can.
      try {
        var direct = (0, eval)(src);
        resolve({ result: direct, error: null });
        return;
      } catch (_) {
        /* fall through to page-world inject (jwplayer / page globals) */
      }

      var reqId = "jiyu_" + Math.random().toString(36).slice(2);
      function onMsg(ev) {
        var d = ev.data;
        if (!d || d.__jiyuEvalId !== reqId) return;
        window.removeEventListener("message", onMsg);
        resolve({ result: d.__jiyuEvalResult, error: d.__jiyuEvalError || null });
      }
      window.addEventListener("message", onMsg);
      var script = document.createElement("script");
      // MUST assign the IIFE return value — wrapping without `return`/`=` discarded
      // autoplay results and left Clappr Idle until a manual double-tap.
      script.textContent =
        "(function(){var id=" +
        JSON.stringify(reqId) +
        ";try{var r=(" +
        src +
        ");window.postMessage({__jiyuEvalId:id,__jiyuEvalResult:r},'*');}" +
        "catch(e){window.postMessage({__jiyuEvalId:id,__jiyuEvalError:String(e&&e.message||e)},'*');}})();";
      try {
        (document.documentElement || document).appendChild(script);
        script.remove();
      } catch (_) {
        resolve({ result: null, error: "inject-failed" });
        return;
      }
      setTimeout(function () {
        window.removeEventListener("message", onMsg);
        resolve({ result: null, error: "timeout" });
      }, 5000);
    });
  }

  function jiyuEachMedia(fn) {
    function walk(root) {
      if (!root || !root.querySelectorAll) return;
      var nodes = [];
      var all = [];
      try {
        nodes = root.querySelectorAll("video,audio");
      } catch (_) {}
      for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
      try {
        all = root.querySelectorAll("*");
      } catch (_) {}
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) walk(all[j].shadowRoot);
      }
    }
    try {
      walk(document);
    } catch (_) {}
  }

  function jiyuForwardMute(muted) {
    var n = 0;
    try {
      n = window.frames.length;
    } catch (_) {
      return;
    }
    for (var i = 0; i < n; i++) {
      try {
        window.frames[i].postMessage({ __jiyuAudio: 1, muted: !!muted }, "*");
      } catch (_) {}
    }
  }

  function jiyuApplyMute(muted) {
    window.__jiyuWantMute = muted ? 1 : 0;
    jiyuEachMedia(function (m) {
      try {
        m.muted = !!muted;
        m.volume = muted ? 0 : 1;
      } catch (_) {}
    });
    if (window.__jiyuMuteTimer) {
      clearInterval(window.__jiyuMuteTimer);
      window.__jiyuMuteTimer = 0;
    }
    if (!muted) return;
    window.__jiyuMuteTimer = setInterval(function () {
      if (window.__jiyuWantMute !== 1) return;
      jiyuEachMedia(function (m) {
        try {
          if (!m.muted || m.volume > 0) {
            m.muted = true;
            m.volume = 0;
          }
        } catch (_) {}
      });
      jiyuForwardMute(true);
    }, 400);
  }

  var guard =
    "(function(){if(window.__jiyuGuard2){if(window.__jiyuRefreshRole)window.__jiyuRefreshRole();return;}" +
    "window.__jiyuGuard2=1;var origPlay=HTMLMediaElement.prototype.play;" +
    "var md=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');" +
    "var vd=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume');" +
    "function passive(){if(window.__jiyuTileMute===true)return true;if(window.__jiyuTileMute===false)return false;" +
    "var n=String(window.name||'');" +
    "if(n.indexOf('|active')!==-1)return false;if(n.indexOf('|passive')!==-1)return true;" +
    "if(window.__jiyuRole==='active')return false;if(window.__jiyuRole==='passive')return true;" +
    "return false;}" +
    "function each(fn){function walk(root){if(!root||!root.querySelectorAll)return;" +
    "var nodes=[];try{nodes=root.querySelectorAll('video,audio');}catch(e){}" +
    "for(var i=0;i<nodes.length;i++)fn(nodes[i]);" +
    "var all=[];try{all=root.querySelectorAll('*');}catch(e){}" +
    "for(var j=0;j<all.length;j++){if(all[j].shadowRoot)walk(all[j].shadowRoot);}}" +
    "try{walk(document);}catch(e){}}" +
    "function apply(){var prev=!!window.__jiyuHold2;var hold=passive();window.__jiyuHold2=hold;" +
    "if(hold||prev){each(function(m){try{m.muted=!!hold;if(hold)m.volume=0;}catch(e){}});}" +
    "try{for(var i=0;i<window.frames.length;i++){window.frames[i].postMessage({__jiyuAudio:1,muted:hold},'*');}}catch(e){}}" +
    "window.__jiyuRefreshRole=apply;" +
    "try{if(md&&md.get&&md.set){Object.defineProperty(HTMLMediaElement.prototype,'muted',{configurable:true," +
    "get:function(){return window.__jiyuHold2?true:md.get.call(this);}," +
    "set:function(v){md.set.call(this,window.__jiyuHold2?true:!!v);}});}" +
    "if(vd&&vd.get&&vd.set){Object.defineProperty(HTMLMediaElement.prototype,'volume',{configurable:true," +
    "get:function(){return window.__jiyuHold2?0:vd.get.call(this);}," +
    "set:function(v){vd.set.call(this,window.__jiyuHold2?0:+v);}});}" +
    "HTMLMediaElement.prototype.play=function(){if(window.__jiyuHold2){try{if(md&&md.set)md.set.call(this,true);}catch(e){}" +
    "try{if(vd&&vd.set)vd.set.call(this,0);}catch(e){}}return origPlay.apply(this,arguments);};}catch(e){}" +
    "window.addEventListener('message',function(ev){var d=ev.data;if(!d||d.__jiyuAudio!==1||typeof d.muted!=='boolean')return;" +
    "window.__jiyuRole=d.muted?'passive':'active';apply();});" +
    "setInterval(apply,200);apply();})();";

  // The page-world mute hook is not installed. It swallowed the first stream's
  // unmute, so audio stayed off until a later tile click went through MediaSession.

  if (!window.__jiyuAudioHook) {
    window.__jiyuAudioHook = 1;
    document.addEventListener(
      "volumechange",
      function (ev) {
        if (tileHold !== true) return;
        var m = ev.target;
        if (!m) return;
        var tag = m.tagName;
        if (tag !== "VIDEO" && tag !== "AUDIO") return;
        try {
          if (!m.muted || m.volume > 0) {
            m.muted = true;
            m.volume = 0;
          }
        } catch (_) {}
      },
      true,
    );
    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (!d || d.__jiyuAudio !== 1 || typeof d.muted !== "boolean") return;
      // A normal stream (no tile role yet) must keep its sound.
      if (tileHold !== true) return;
      jiyuApplyMute(true);
      jiyuForwardMute(true);
    });
  }

  var tileHold = null;

  function applyTileHold(muted) {
    window.__jiyuWantMute = muted ? 1 : 0;
    window.__jiyuTileMute = !!muted;
    try {
      window.wrappedJSObject.__jiyuTileMute = !!muted;
    } catch (_) {}
    // Do not call play(). A play() loop keeps the embed on its spinner and the
    // play button only appears after the player gives up (~20s).
    var nodes = [];
    try {
      nodes = document.querySelectorAll("video,audio");
    } catch (_) {}
    for (var i = 0; i < nodes.length; i++) {
      try {
        nodes[i].muted = !!muted;
        nodes[i].volume = muted ? 0 : 1;
      } catch (_) {}
    }
  }

  var port = browser.runtime.connectNative("jiyu");
  port.onMessage.addListener(function (msg) {
    if (msg && msg.action === "tileAudio") {
      tileHold = !!msg.muted;
      applyTileHold(tileHold);
      return;
    }
    if (msg && msg.action === "tileKick") {
      if (msg.muted) {
        tileHold = true;
        applyTileHold(true);
      }
      armKick(!!msg.muted);
      return;
    }
    if (msg && msg.action === "queryPlayButtonRect") {
      var rect = measurePlayButtonRect(msg.attempt || 0);
      if (!rect) {
        rect = { action: "playButtonRect", found: false };
      }
      rect.id = msg.id;
      try {
        port.postMessage(rect);
      } catch (_) {}
      return;
    }
    if (!msg || msg.action !== "eval") return;
    var id = msg.id;
    runCode(String(msg.code || "")).then(function (out) {
      try {
        port.postMessage({
          id: id,
          result: out.result,
          error: out.error,
          frame: window === window.top ? "top" : "child",
        });
      } catch (_) {}
    });
  });
  document.addEventListener(
    "play",
    function (ev) {
      if (tileHold !== true) return;
      var m = ev.target;
      if (!m || (m.tagName !== "VIDEO" && m.tagName !== "AUDIO")) return;
      try {
        m.muted = true;
        m.volume = 0;
      } catch (_) {}
    },
    true,
  );
  try {
    port.postMessage({ action: "tileAudioQuery" });
  } catch (_) {}

  var kickDone = false;
  var kickWatch = null;
  var kickTimer = 0;
  var PLAY_BUTTON =
    ".vjs-big-play-button, .vjs-play-control, .jw-icon-display, .jw-icon-playback," +
    " .jw-display-icon-container, .clappr-play-button, .play-wrapper," +
    " .media-control-button[data-play], .bmpui-ui-hugeplaybacktogglebutton," +
    " button[aria-label*='Play' i], button[title*='Play' i], [aria-label='Play']," +
    " [data-title='Play'], .playButton, button.play-button";

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.__jiyuPlay !== 1) return;
    var host = null;
    var frames = [];
    try {
      frames = document.querySelectorAll("iframe,frame");
    } catch (_) {}
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentWindow === ev.source) {
          host = frames[i];
          break;
        }
      } catch (_) {}
    }
    if (!host) {
      var biggest = 0;
      for (var k = 0; k < frames.length; k++) {
        var candidate;
        try {
          candidate = frames[k].getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (!candidate) continue;
        var candidateArea = candidate.width * candidate.height;
        if (candidateArea > biggest) {
          biggest = candidateArea;
          host = frames[k];
        }
      }
    }
    if (!host) return;
    var box;
    try {
      box = host.getBoundingClientRect();
    } catch (_) {
      return;
    }
    if (!box || box.width < 40 || box.height < 40) return;
    var nx = box.left + Number(d.nx) * box.width;
    var ny = box.top + Number(d.ny) * box.height;
    if (window === window.top) {
      window.__jiyuMappedPlay = {
        cx: nx,
        cy: ny,
        w: 28,
        h: 28,
        at: Date.now(),
      };
      return;
    }
    try {
      window.parent.postMessage(
        {
          __jiyuPlay: 1,
          nx: nx / (window.innerWidth || 1),
          ny: ny / (window.innerHeight || 1),
        },
        "*",
      );
    } catch (_) {}
  });

  function stopKickWatch() {
    if (kickWatch) {
      try {
        kickWatch.disconnect();
      } catch (_) {}
      kickWatch = null;
    }
    if (kickTimer) {
      clearTimeout(kickTimer);
      kickTimer = 0;
    }
  }

  function anyVideoPlaying() {
    var nodes = [];
    try {
      nodes = document.querySelectorAll("video");
    } catch (_) {}
    for (var i = 0; i < nodes.length; i++) {
      var video = nodes[i];
      if (!video || video.ended) continue;
      // Buffering on a slow connection leaves paused=true and the play glyph up.
      // Once the stream has started, that is not a reason to tap again.
      if (!video.paused) return true;
      if (video.seeking) return true;
      if (video.currentTime > 0.2) return true;
    }
    return false;
  }

  function silenceHere() {
    var nodes = [];
    try {
      nodes = document.querySelectorAll("video,audio");
    } catch (_) {}
    for (var i = 0; i < nodes.length; i++) {
      try {
        nodes[i].muted = true;
        nodes[i].volume = 0;
      } catch (_) {}
    }
  }

  function closedShadow(el) {
    if (!el) return null;
    try {
      if (el.shadowRoot) return el.shadowRoot;
    } catch (_) {}
    try {
      if (el.openOrClosedShadowRoot) return el.openOrClosedShadowRoot;
    } catch (_) {}
    try {
      if (browser.dom && browser.dom.openOrClosedShadowRoot) {
        return browser.dom.openOrClosedShadowRoot(el);
      }
    } catch (_) {}
    return null;
  }

  function walkRoots(fn) {
    function walk(root) {
      if (!root || !root.querySelectorAll) return;
      fn(root);
      var all = [];
      try {
        all = root.querySelectorAll("*");
      } catch (_) {}
      for (var i = 0; i < all.length; i++) {
        var shadow = closedShadow(all[i]);
        if (shadow) walk(shadow);
      }
    }
    try {
      walk(document);
    } catch (_) {}
  }

  function rectPayload(r) {
    if (!r || r.width < 2 || r.height < 2) return null;
    var vv = window.visualViewport;
    var offX = vv ? vv.offsetLeft : 0;
    var offY = vv ? vv.offsetTop : 0;
    var vw = (vv && vv.width) || window.innerWidth || 0;
    var vh = (vv && vv.height) || window.innerHeight || 0;
    return {
      action: "playButtonRect",
      found: true,
      cx: r.left + r.width / 2 - offX,
      cy: r.top + r.height / 2 - offY,
      w: r.width,
      h: r.height,
      dpr: window.devicePixelRatio || 1,
      vw: vw,
      vh: vh,
      frame: window === window.top ? "top" : "child",
    };
  }

  function controlPlayRect(videoRect) {
    return {
      left: videoRect.left + videoRect.width / 2 - 18,
      top: videoRect.top + videoRect.height / 2 - 18,
      width: 36,
      height: 36,
    };
  }

  function largestPlayButtonRect() {
    var best = null;
    var bestArea = 0;
    walkRoots(function (root) {
      var nodes = [];
      try {
        nodes = root.querySelectorAll(PLAY_BUTTON);
      } catch (_) {}
      for (var i = 0; i < nodes.length; i++) {
        var r;
        try {
          r = nodes[i].getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (!r || r.width < 24 || r.height < 24) continue;
        if (r.bottom < 0 || r.right < 0) continue;
        // A full-width control bar matches "play" too. Its center is the
        // bottom-middle of the page, not the play icon.
        if (r.width > r.height * 2.4 && r.width > 160) continue;
        if (r.height > r.width * 2.4 && r.height > 160) continue;
        var area = r.width * r.height;
        if (area > bestArea) {
          best = r;
          bestArea = area;
        }
      }
    });
    return best;
  }

  function publishPlayPoint(payload) {
    if (!payload || window === window.top) return;
    var vw = payload.vw || window.innerWidth || 1;
    var vh = payload.vh || window.innerHeight || 1;
    try {
      window.parent.postMessage(
        { __jiyuPlay: 1, nx: payload.cx / vw, ny: payload.cy / vh },
        "*",
      );
    } catch (_) {}
  }

  function mappedTopRect() {
    var mapped = window.__jiyuMappedPlay;
    if (!mapped || Date.now() - mapped.at > 2500) return null;
    return rectPayload({
      left: mapped.cx - 14,
      top: mapped.cy - 14,
      width: mapped.w || 28,
      height: mapped.h || 28,
    });
  }

  function measurePlayButtonRect(attempt) {
    if (window === window.top) {
      var mapped = mappedTopRect();
      if (mapped) return mapped;
    }
    var buttonRect = rectPayload(largestPlayButtonRect());
    if (buttonRect) {
      publishPlayPoint(buttonRect);
      return buttonRect;
    }
    // Only fallback if we've been looking for a few seconds. The player UI 
    // often takes a few seconds longer to attach than the raw video element.
    if ((attempt || 0) < 12) {
      return null;
    }
    // No DOM button. Portrait: middle of the picture. Landscape: bottom bar.
    var best = null;
    var bestArea = 0;
    walkRoots(function (root) {
      var nodes = [];
      try {
        nodes = root.querySelectorAll("video");
      } catch (_) {}
      for (var i = 0; i < nodes.length; i++) {
        var video = nodes[i];
        if (!video.paused || video.ended || !video.getBoundingClientRect) continue;
        var r;
        try {
          r = video.getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (!r || r.width < 80 || r.height < 80) continue;
        var area = r.width * r.height;
        if (area > bestArea) {
          best = r;
          bestArea = area;
        }
      }
    });
    var control = best ? rectPayload(controlPlayRect(best)) : null;
    if (control) {
      publishPlayPoint(control);
      return control;
    }
    if (anyVideoPlaying()) {
      return {
        action: "playButtonRect",
        found: false,
        playing: true,
        frame: window === window.top ? "top" : "child",
      };
    }
    return { action: "playButtonRect", found: false, frame: window === window.top ? "top" : "child" };
  }

  function clickPlayButton() {
    var el = null;
    try {
      el = document.querySelector(PLAY_BUTTON);
    } catch (_) {}
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function fallbackPlay(muted) {
    var nodes = [];
    try {
      nodes = document.querySelectorAll("video");
    } catch (_) {}
    if (!nodes.length) return;
    if (muted) silenceHere();
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].paused && !nodes[i].ended) continue;
      try {
        var pending = nodes[i].play();
        if (pending && pending.catch) pending.catch(function () {});
      } catch (_) {}
    }
  }

  function tryKick(muted) {
    if (kickDone) return;
    if (anyVideoPlaying()) {
      if (muted) silenceHere();
      kickDone = true;
      stopKickWatch();
      return;
    }
    if (muted) silenceHere();
    if (clickPlayButton()) {
      kickDone = true;
      stopKickWatch();
    }
  }

  function armKick(muted) {
    if (kickDone) return;
    tryKick(muted);
    if (kickDone || kickWatch) return;
    var root = document.documentElement || document;
    kickWatch = new MutationObserver(function () {
      tryKick(muted);
    });
    try {
      kickWatch.observe(root, { childList: true, subtree: true });
    } catch (_) {
      kickWatch = null;
    }
    kickTimer = setTimeout(function () {
      if (kickDone) return;
      if (!anyVideoPlaying()) fallbackPlay(muted);
      kickDone = true;
      stopKickWatch();
    }, 8000);
  }
})();
