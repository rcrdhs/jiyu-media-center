/** Shared Rivestream embed auto-hop (Direct first, then Embed hosts). */
export const RIVESTREAM_EMBED_AUTO_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    const onRive = /(^|\\.)rivestream\\.(ru|app)$/i.test(host);
    const onDirect =
      /(^|\\.)(vaplayer\\.ru|vidup\\.to|videasy\\.to|cinezo\\.live|vidzee\\.wtf|mapple\\.fun|primesrc\\.me|streamingnow\\.mov)$/i.test(host);
    if (!onRive && !onDirect) return 'skip-host';

    // Prefer path-based hosts. VAP shells nextgencloudfabric "Cloud:" ads then whites.
    const ORDER = ['VUP','VIDZ','CIN','MAP','SUP','AGGREGATOR','TORR','VAP','EASY','PRIME','SMASH','VID','ADF'];
    const LAST_KEY = 'jiyu.rive.lastGood';
    const HOP_KEY = 'jiyu.rive.hopIdx';
    const EP_KEY = 'jiyu.rive.hopEp';

    const parseTv = () => {
      try {
        const u = new URL(location.href);
        let id = u.searchParams.get('id') || u.searchParams.get('tmdb') || '';
        let season = u.searchParams.get('season') || '1';
        let episode = u.searchParams.get('episode') || '1';
        const m = u.pathname.match(/\\/(?:embed\\/)?tv\\/(\\d+)(?:\\/(\\d+)(?:\\/(\\d+))?)?/i);
        if (m) {
          id = id || m[1];
          season = m[2] || season;
          episode = m[3] || episode;
        }
        const m2 = u.pathname.match(/\\/tv\\/(\\d+)-(\\d+)-(\\d+)/i);
        if (m2) {
          id = id || m2[1];
          season = m2[2] || season;
          episode = m2[3] || episode;
        }
        if (!id) {
          try {
            id = String(sessionStorage.getItem('jiyu.rive.tmdb') || '');
            season = String(sessionStorage.getItem('jiyu.rive.season') || season);
            episode = String(sessionStorage.getItem('jiyu.rive.episode') || episode);
          } catch (_) {}
        }
        return { id: String(id || '').trim(), season: String(season || '1'), episode: String(episode || '1') };
      } catch (_) {
        return { id: '', season: '1', episode: '1' };
      }
    };

    const directFor = (code, id, season, episode) => {
      if (!id) return null;
      const s = season || '1';
      const e = episode || '1';
      switch (code) {
        case 'VAP': return 'https://vaplayer.ru/embed/tv/' + id + '/' + s + '/' + e;
        case 'VUP': return 'https://vidup.to/tv/' + id + '/' + s + '/' + e + '?autoPlay=true';
        case 'EASY': return 'https://player.videasy.to/tv/' + id + '/' + s + '/' + e;
        case 'CIN': return 'https://player.cinezo.live/embed/tv/' + id + '/' + s + '/' + e + '?autoplay=true&poster=true';
        case 'VIDZ': return 'https://player.vidzee.wtf/embed/tv/' + id + '/' + s + '/' + e;
        case 'AGGREGATOR': return 'https://rivestream.ru/embed/agg?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'MAP': return 'https://mapple.fun/watch/tv/' + id + '-' + s + '-' + e + '?nextButton=true&autoPlay=true&autoNext=true';
        case 'TORR': return 'https://rivestream.ru/embed/torrent?type=tv&id=' + id + '&season=' + s + '&episode=' + e;
        case 'PRIME': return 'https://primesrc.me/embed/tv?tmdb=' + id + '&season=' + s + '&episode=' + e;
        default: return null;
      }
    };

    const seedPrefs = (code) => {
      try {
        // Prefer Direct (Vanguard/Citadel/…) first; Embed servers are hop fallback.
        localStorage.setItem('RiveStreamWatchMode', 'direct');
        localStorage.setItem('RiveStreamEmbedMode', 'false');
        if (code) localStorage.setItem('RiveStreamLatestAgg', code);
      } catch (_) {}
    };

    const seedEmbedPrefs = (code) => {
      try {
        localStorage.setItem('RiveStreamWatchMode', 'embed');
        localStorage.setItem('RiveStreamEmbedMode', 'true');
        if (code) localStorage.setItem('RiveStreamLatestAgg', code);
      } catch (_) {}
    };

    const { id: tvId, season: tvSeason, episode: tvEpisode } = parseTv();
    if (tvId) {
      try {
        sessionStorage.setItem('jiyu.rive.tmdb', tvId);
        sessionStorage.setItem('jiyu.rive.season', tvSeason);
        sessionStorage.setItem('jiyu.rive.episode', tvEpisode);
        const ep = 'tv:' + tvId + ':' + tvSeason + ':' + tvEpisode;
        if (sessionStorage.getItem(EP_KEY) !== ep) {
          sessionStorage.setItem(EP_KEY, ep);
          sessionStorage.removeItem(HOP_KEY);
        }
      } catch (_) {}
    }

    const prefer = (() => {
      try {
        const hopRaw = sessionStorage.getItem(HOP_KEY);
        if (hopRaw != null) {
          const idx = Number(hopRaw);
          if (Number.isFinite(idx) && ORDER[idx]) return ORDER[idx];
        }
        const last = String(localStorage.getItem(LAST_KEY) || '').trim();
        if (last && ORDER.includes(last) && last !== 'ADF' && last !== 'PRIME' && last !== 'VAP') return last;
      } catch (_) {}
      return 'VUP';
    })();

    // Stay on Rivestream Direct first. Only hop to Embed hosts after Direct fails.
    const hoppingToEmbed = (() => {
      try { return sessionStorage.getItem(HOP_KEY) != null; } catch (_) { return false; }
    })();
    if (hoppingToEmbed) seedEmbedPrefs(prefer);
    else seedPrefs(prefer);

    // Click Direct mode control when still on the Rive shell.
    if (onRive && !hoppingToEmbed) {
      const clickDirect = () => {
        try {
          for (const el of Array.from(document.querySelectorAll('button, [role="button"], div, span, label, a'))) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.closest('video, audio, iframe')) continue;
            const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
              .replace(/\\s+/g, ' ').trim();
            if (!label || label.length > 48) continue;
            if (!/^direct$/i.test(label) && !/^playback\\s*mode\\s*:?\\s*direct$/i.test(label)) continue;
            el.click();
            return;
          }
        } catch (_) {}
      };
      clickDirect();
      setTimeout(clickDirect, 700);
      setTimeout(clickDirect, 1800);
    }

    // When already hopping, jump once to an Embed player URL.
    if (hoppingToEmbed && onRive && /\\/embed/i.test(String(location.pathname || '') + String(location.search || '')) && !/\\/embed\\/(agg|torrent)/i.test(location.pathname || '')) {
      const jumpKey = 'jiyu.rive.directJump:' + (tvId || '') + ':' + tvSeason + ':' + tvEpisode;
      let already = false;
      try { already = sessionStorage.getItem(jumpKey) === '1'; } catch (_) {}
      const target = directFor(prefer, tvId, tvSeason, tvEpisode);
      if (target && !already && !window.__jiyuRiveDirectJump) {
        window.__jiyuRiveDirectJump = true;
        try { sessionStorage.setItem(jumpKey, '1'); } catch (_) {}
        console.log('jiyu-rive-embed-jump:' + prefer);
        location.replace(target);
        return 'embed-jump';
      }
    }

    const isBrokenSrc = (src) => {
      const s = String(src || '');
      if (!s || s === 'about:blank') return false;
      if (/\\/undefined(?:\\/|\\?|#|$)/i.test(s)) return true;
      if (/[?&](?:tmdb|id)=undefined\\b/i.test(s)) return true;
      if (/chrome-error:|chromewebdata/i.test(s)) return true;
      try {
        const h = new URL(s, location.href).hostname.replace(/^www\\./i, '').toLowerCase();
        if (/(^|\\.)example\\.(com|net|org)$/i.test(h)) return true;
        if (/(^|\\.)invalid$/i.test(h)) return true;
        // VAP handoff that only paints Cloud: ad tips (no real stream for many titles).
        if (/(^|\\.)nextgencloudfabric\\.com$/i.test(h)) return true;
      } catch (_) {}
      return false;
    };

    const textLooksDead = () => {
      const t = String(document.body && document.body.innerText || '');
      // Loading copy is not a failure — hopping here caused white↔spinner flashes.
      if (/getting things ready|loading|buffering|please wait/i.test(t)) return false;
      return /Cloud:\\s*use AD-Blocker|Cloud:\\s*use video downloader|no working sources|access denied|http error 403|err_name_not_resolved|Firefox Can't Open This Page|will not allow Firefox to display|X-Frame-Options|to protect your security/i.test(t);
    };

    const hideServerChrome = () => {
      if (!onRive) return;
      try {
        let style = document.getElementById('jiyu-rive-hide-servers');
        if (!style) {
          style = document.createElement('style');
          style.id = 'jiyu-rive-hide-servers';
          (document.head || document.documentElement).appendChild(style);
        }
        const PROVIDER =
          /\\b(Vanguard|Citadel|FlowCast|Flowcast|Apex|Pulse|Nova|Hydra|Shadow|Astra|Zenith|Orion|Vertex|Prism|Forge|Beacon|Harbor|Summit|Cascade)\\b/i;
        style.textContent = [
          '[aria-label="Playback Mode"],',
          '[aria-label="Select Aggregator Server"],',
          '[aria-label="Select Direct Server"],',
          '[aria-label="Select Local Media Server"],',
          '[aria-label="Select Server"],',
          '[aria-label*="Server"], [aria-label*="server"],',
          '[aria-label*="Playback Mode"],',
          '[aria-label*="Controls Bar"], [aria-label*="controls bar"],',
          '[title*="Controls Bar"],',
          '[aria-label="Expand Controls Bar"], [aria-label="Shrink Controls Bar"],',
          '[title="Expand Controls Bar"], [title="Shrink Controls Bar"],',
          '[aria-label*="Quick Menu"], [aria-label*="quick menu"], [title*="Quick Menu"],',
          'button#source, button[name="source"],',
          'select#watchMode, select[name="watchMode"],',
          '[class*="watchBar"], [class*="WatchBar"],',
          '[class*="modeSelect"], [class*="serverSelect"], [class*="ServerSelect"],',
          '[class*="selectWrapper"], [class*="pillText"], [class*="pillChevron"],',
          '[class*="expandedContent"], [class*="collapsedContent"],',
          '[class*="collapsedState"], [class*="expandedState"],',
          '[class*="hideNavBtn"], [class*="sourceBar"], [class*="SourceBar"],',
          '[class*="quickMenu"], [class*="QuickMenu"]',
          '{ display: none !important; visibility: hidden !important; opacity: 0 !important;',
          '  pointer-events: none !important; height: 0 !important; max-height: 0 !important;',
          '  overflow: hidden !important; margin: 0 !important; padding: 0 !important; }',
        ].join('');
        const kill = (el) => {
          if (!(el instanceof HTMLElement)) return;
          if (el.closest('video, audio, iframe')) return;
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.style.setProperty('height', '0', 'important');
          el.style.setProperty('max-height', '0', 'important');
          el.style.setProperty('overflow', 'hidden', 'important');
        };
        const killBar = (el) => {
          kill(el);
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            if (p === document.body || p === document.documentElement) break;
            const pt = String(p.textContent || '').replace(/\\s+/g, ' ').trim();
            if (pt.length > 220) break;
            const hasMode = /\\b(Direct|Embed)\\b/i.test(pt);
            const hasServer = PROVIDER.test(pt) || /\\bServer\\s*\\d+/i.test(pt) || /\\b\\d{3,4}p\\b/i.test(pt);
            if (hasMode && hasServer) kill(p);
            p = p.parentElement;
          }
        };
        for (const el of Array.from(document.querySelectorAll(
          '[aria-label*="Controls Bar"], [aria-label*="controls bar"], [aria-label*="Server"], [aria-label*="server"],' +
          '[aria-label*="Playback Mode"], [aria-label*="Quick Menu"],' +
          '[class*="watchBar"], [class*="serverSelect"], [class*="sourceBar"], [class*="quickMenu"], [class*="QuickMenu"]',
        ))) {
          kill(el);
        }
        for (const el of Array.from(document.querySelectorAll('button, div, span, section, nav, label, a'))) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.closest('video, audio, iframe')) continue;
          const raw = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!raw || raw.length > 160) continue;
          if (/Servers\\s*&\\s*Mode/i.test(raw) || /^QUICK\\s*MENU$/i.test(raw)) {
            killBar(el);
            continue;
          }
          const looksLikeServerCapsule =
            !el.querySelector('iframe, video') &&
            (
              (/\\bDirect\\b/i.test(raw) && (PROVIDER.test(raw) || /\\b\\d{3,4}p\\b/i.test(raw))) ||
              (/\\bEmbed\\b/i.test(raw) && /\\bServer\\s*\\d+/i.test(raw))
            );
          if (looksLikeServerCapsule) killBar(el);
        }
      } catch (_) {}
    };

    const nudgePlay = () => {
      try {
        for (const v of Array.from(document.querySelectorAll('video'))) {
          try { v.muted = false; v.play?.(); } catch (_) {}
        }
        const hit = Array.from(document.querySelectorAll('button, [role="button"], div, span')).find((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const t = String(el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!t || t.length > 40) return false;
          return /^(play|watch|start)$/i.test(t) || /^play\\b/i.test(t);
        });
        if (hit) hit.click();
        else {
          const mid = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
          if (mid) mid.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      } catch (_) {}
    };

    const hasBrokenFrame = () =>
      Array.from(document.querySelectorAll('iframe[src]')).some((f) => isBrokenSrc(f.getAttribute('src')));

    const hasPlayerFrame = () => {
      const frames = Array.from(document.querySelectorAll('iframe[src]'));
      const okFrame = frames.some((f) => {
        const src = String(f.getAttribute('src') || '');
        if (!src || src === 'about:blank' || isBrokenSrc(src)) return false;
        const r = f.getBoundingClientRect();
        return r.width > 120 && r.height > 80;
      });
      if (okFrame) return true;
      return Array.from(document.querySelectorAll('video')).some((v) => {
        try {
          return v.readyState >= 2 && (v.videoWidth > 0 || v.currentTime > 0);
        } catch (_) {
          return false;
        }
      });
    };

    const hop = (reason) => {
      if (window.__jiyuRiveHopping) return 'busy';
      const now = Date.now();
      if (window.__jiyuRiveLastHopAt && now - window.__jiyuRiveLastHopAt < 12000) return 'cooldown';
      window.__jiyuRiveHopping = true;
      window.__jiyuRiveLastHopAt = now;
      let idx = 0;
      try {
        const raw = sessionStorage.getItem(HOP_KEY);
        if (raw != null) idx = Number(raw) || 0;
        else idx = -1; // first Direct→Embed hop starts at ORDER[0]
      } catch (_) {
        idx = Math.max(0, ORDER.indexOf(prefer));
      }
      for (let step = 1; step <= ORDER.length; step += 1) {
        const next = idx + step;
        if (next >= ORDER.length) break;
        const code = ORDER[next];
        const target = directFor(code, tvId, tvSeason, tvEpisode);
        if (!target && code !== 'SUP' && code !== 'SMASH' && code !== 'VID' && code !== 'ADF') continue;
        try { sessionStorage.setItem(HOP_KEY, String(next)); } catch (_) {}
        seedEmbedPrefs(code);
        try { localStorage.removeItem(LAST_KEY); } catch (_) {}
        console.log('jiyu-rive-hop:' + code + ':' + String(reason || ''));
        if (target) {
          location.replace(target);
          return true;
        }
        if (tvId) {
          location.replace(
            'https://rivestream.ru/embed?type=tv&id=' + encodeURIComponent(tvId) +
            '&season=' + encodeURIComponent(tvSeason) + '&episode=' + encodeURIComponent(tvEpisode) + '#jiyuAuto=1'
          );
          return true;
        }
      }
      window.__jiyuRiveHopping = false;
      try {
        console.log('jiyu-rive-hop-exhausted:' + String(reason || ''));
        if (!document.getElementById('jiyu-rive-no-source')) {
          const banner = document.createElement('div');
          banner.id = 'jiyu-rive-no-source';
          banner.textContent = 'No working RiveStream source for this episode.';
          banner.setAttribute('style',
            'position:fixed;inset:auto 12px 12px 12px;z-index:2147483647;padding:12px 14px;' +
            'border-radius:10px;background:rgba(12,14,18,0.92);color:#f3f6fb;font:600 14px/1.35 Segoe UI,sans-serif;' +
            'border:1px solid rgba(255,255,255,0.12);pointer-events:none;');
          (document.body || document.documentElement).appendChild(banner);
        }
      } catch (_) {}
      return false;
    };

    try {
      window.__jiyuRiveForceHop = (reason) => hop(String(reason || 'forced'));
    } catch (_) {}

    // primesrc with empty servers paints a play UI then hands off to /undefined/ — skip it.
    if (/(^|\\.)primesrc\\.me$/i.test(host)) {
      setTimeout(() => {
        try {
          if (hasBrokenFrame() || !hasPlayerFrame()) hop('primesrc-empty');
        } catch (_) {}
      }, 3500);
      setTimeout(() => {
        try { if (hasBrokenFrame()) hop('primesrc-undefined'); } catch (_) {}
      }, 7000);
    }

    const markGood = () => {
      try {
        const cur = String(localStorage.getItem('RiveStreamLatestAgg') || prefer || 'VAP');
        if (ORDER.includes(cur) && cur !== 'ADF' && cur !== 'PRIME') localStorage.setItem(LAST_KEY, cur);
        sessionStorage.removeItem(HOP_KEY);
      } catch (_) {}
      hideServerChrome();
    };

    if (window.__jiyuRiveEmbedHop) return 'seeded';
    window.__jiyuRiveEmbedHop = true;

    let startedAt = Date.now();
    let hops = 0;
    let goodAt = 0;
    const tick = () => {
      try {
        if (window.__jiyuRiveHopping) return;
        if (hasBrokenFrame() || textLooksDead()) {
          if (hops >= ORDER.length) return;
          hops += 1;
          startedAt = Date.now();
          goodAt = 0;
          hop(hasBrokenFrame() ? 'broken-src' : 'dead-text');
          return;
        }
        if (hasPlayerFrame()) {
          if (!goodAt) goodAt = Date.now();
          if (Date.now() - goodAt > 4000) markGood();
          return;
        }
        goodAt = 0;
        if (Date.now() - startedAt < 3000) return;
        if (hops >= ORDER.length) return;
        if (Date.now() - startedAt > 20000) {
          hops += 1;
          startedAt = Date.now();
          hop('no-player');
        }
      } catch (_) {}
    };

    const start = () => {
      nudgePlay();
      setTimeout(nudgePlay, 1200);
      setTimeout(nudgePlay, 3000);
      setInterval(tick, 1000);
      setTimeout(tick, 2000);
      setTimeout(tick, 5000);
      setTimeout(tick, 9000);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      setTimeout(start, 50);
    }
    return 'armed';
  } catch (_) {
    return 'error';
  }
})();`
