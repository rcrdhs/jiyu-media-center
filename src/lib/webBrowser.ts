import { isInAppBrowserAvailable } from './androidBrowser'

export interface WebPreset {
  id: string
  label: string
  detail: string
  /** Opens the live stream (or live hub) and auto-plays when possible */
  url: string
}

/**
 * Presets jump straight to live playback pages — not search results.
 * YouTube `/live` redirects to the channel’s current live video when on-air.
 */
export const WEB_PRESETS: WebPreset[] = [
  {
    id: 'cvm-live',
    label: 'CVM Live',
    detail: 'Play CVM TV News current live stream.',
    url: 'https://www.youtube.com/@cvmtvnews/live',
  },
  {
    id: 'tvj-live',
    label: 'TVJ Live',
    detail: 'Play Television Jamaica live on YouTube when on-air.',
    url: 'https://www.youtube.com/@TelevisionJamaica/live',
  },
  {
    id: 'nationwide-live',
    label: 'Nationwide Live',
    detail: 'Nationwide News Network (90FM) live on YouTube.',
    url: 'https://www.youtube.com/@nnn-RADIOLIVE/live',
  },
  {
    id: '1spot-live',
    label: '1SpotMedia Live',
    detail: 'TVJ / RJR live and on-demand player.',
    url: 'https://www.1spotmedia.com/',
  },
  {
    id: 'cvm-channel',
    label: 'CVM channel',
    detail: 'CVM TV News YouTube home.',
    url: 'https://www.youtube.com/@cvmtvnews',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    detail: 'Browse YouTube inside Jiyu.',
    url: 'https://www.youtube.com/',
  },
  {
    id: 'tnt-sports-youtube',
    label: 'TNT Sports UK (YouTube)',
    detail: 'Official free Early Kick-Off on match days — opens live when on-air.',
    url: 'https://www.youtube.com/@TNTSports/live',
  },
  {
    id: 'tnt-sports-hbomax',
    label: 'TNT Sports UK (HBO Max)',
    detail: 'Full Premier League, Champions League & FA Cup — sign in to stream.',
    url: 'https://play.hbomax.com/',
  },
]

/** Map a local channel title to its live play URL */
export function liveUrlForChannelTitle(title: string): string {
  const name = title.replace(/\s*[\[(].*$/, '').trim().toLowerCase()
  if (name.startsWith('cvm')) return 'https://www.youtube.com/@cvmtvnews/live'
  if (name.startsWith('tvj')) return 'https://www.youtube.com/@TelevisionJamaica/live'
  if (name.startsWith('nationwide') || name === 'nnn' || name === 'nnn-radiolive') {
    return 'https://www.youtube.com/@nnn-RADIOLIVE/live'
  }
  if (/^tnt\s*sports/i.test(name) || name === 'tnt') {
    return 'https://www.youtube.com/@TNTSports/live'
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} Jamaica live`)}`
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return /youtube\.com$/i.test(u.hostname) || /\.youtube\.com$/i.test(u.hostname) || /youtu\.be$/i.test(u.hostname)
  } catch {
    return /youtube\.com|youtu\.be/i.test(url)
  }
}

/** Opens in Jiyu Web browser — no native HLS/MP4 path (YouTube, HBO Max, etc.). */
export function isWebBrowserOnlyUrl(url: string): boolean {
  if (isYouTubeUrl(url)) return true
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host === 'play.hbomax.com' || host.endsWith('.hbomax.com')) return true
    if (host === 'play.max.com' || host.endsWith('.max.com')) return true
    if (host.endsWith('tntsports.co.uk')) return true
    // NetMirror / freemovies: route via ShowPage first (WatchPage); keep as
    // browser-only for direct /web links and non-show entry points.
    if (host === 'freemovies.lol' || host.endsWith('.freemovies.lol')) return true
    if (host === 'netmirror-app.pages.dev') return true
    if (/(^|\.)ww\d*\.surf$/i.test(host) && /netmirror/i.test(u.pathname)) return true
    if (/netmirror/i.test(host)) return true
    if (host === 'ww.ymovies.vip' || host.endsWith('.ymovies.vip')) return true
    if (host === 'fstream365.com' || host.endsWith('.fstream365.com')) return true
    if (host === 'vsembed.ru' || host.endsWith('.vsembed.ru')) return true
    if (host === 'vidsrc.to' || host.endsWith('.vidsrc.to')) return true
    if (host === 'vidsrc.me' || host.endsWith('.vidsrc.me')) return true
    if (host === 'cinextream.cc' || host.endsWith('.cinextream.cc')) return true
    if (host === 'streamed.pk' || host.endsWith('.streamed.pk')) return true
    if (host === 'ppv.st' || host.endsWith('.ppv.st')) return true
    if (host === 'embedindia.st' || host.endsWith('.embedindia.st')) return true
    if (host === 'embed.st' || host.endsWith('.embed.st')) return true
    if (host === 'embedhd.st' || host.endsWith('.embedhd.st')) return true
    if (host === 'rivestream.ru' || host.endsWith('.rivestream.ru')) return true
    // LiveXTV full-match replay iframes (soccerfull → nested player hosts).
    if (host === 'soccerfull.net' || host.endsWith('.soccerfull.net')) return true
    if (host === 'livextv.hybrows.workers.dev') return true
    if (host === 'livextv.com' || host.endsWith('.livextv.com')) return true
    if (host === 'livextv.pro' || host.endsWith('.livextv.pro')) return true
    if (host === 'footreplays.com' || host.endsWith('.footreplays.com')) return true
    if (host === 'ok.ru' || host.endsWith('.ok.ru')) return true
    // DoodStream-style rotating hosts: /e/{id} or /d/{id}
    if (/^\/[de]\/[a-z0-9]{6,}/i.test(u.pathname || '')) return true
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Live sports + Replay VOD embeds share one autoplay policy:
 * main-process kick owns play; renderer only hides ads (no click storms).
 */
export function isSportsOrReplayEmbedUrl(url: string): boolean {
  if (!url) return false
  if (/embed(?:india|hd)?\.st|streamed\.pk|ppv\.st/i.test(url)) return true
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 'soccerfull.net' || host.endsWith('.soccerfull.net')) return true
    if (host.includes('livextv')) return true
    if (host === 'footreplays.com' || host.endsWith('.footreplays.com')) return true
    if (/^\/[de]\/[a-z0-9]{6,}/i.test(parsed.pathname || '')) return true
  } catch {
    /* ignore */
  }
  return false
}

/** True when playback must use a WebContentsView (not the native HLS player). */
export function isWebEmbedPlaybackItem(item: {
  url?: string
  tags?: string[]
  source?: string
  streamedMatchId?: string
}): boolean {
  if (item.tags?.includes('web-embed')) return true
  if (item.tags?.includes('replay') && item.tags?.includes('livextv')) return true
  if (item.streamedMatchId) return true
  if (/^(streamed|ppv\.st|livextv)$/i.test(String(item.source || ''))) return true
  return Boolean(item.url && isWebBrowserOnlyUrl(item.url))
}

/** Cloudflare interstitial. Autoplay clicks and DOM reads restart the Verify spinner. */
export function isCloudflareChallengeTarget(url?: string, title?: string): boolean {
  const blob = `${url || ''} ${title || ''}`.toLowerCase()
  return (
    blob.includes('challenges.cloudflare.com') ||
    blob.includes('cdn-cgi/challenge') ||
    blob.includes('just a moment') ||
    blob.includes('verify you are human') ||
    blob.includes('attention required') ||
    blob.includes('checking your browser') ||
    blob.includes('cf-browser-verification') ||
    blob.includes('performing security verification') ||
    blob.includes('security verification') ||
    blob.includes('security service to protect') ||
    blob.includes('malicious bots') ||
    /__cf_chl|cf_chl_/i.test(url || '')
  )
}

/** Blank / placeholder documents must never become corner PiP (black box over Home). */
export function isBlankBrowserUrl(url: string | null | undefined): boolean {
  const raw = String(url || '').trim()
  if (!raw) return true
  if (/^about:blank$/i.test(raw)) return true
  if (/^data:text\/html/i.test(raw) && /background\s*:\s*%23000|#000|black/i.test(raw)) {
    return true
  }
  if (/^data:text\/html/i.test(raw) && raw.length < 120) return true
  return false
}

/** Embed hosts that draw in-app (fstream, vsembed, streamed / embed.st, …). */
export function isEmbedPlayerHost(url: string): boolean {
  if (isWebBrowserOnlyUrl(url)) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
      const path = new URL(url).pathname || ''
      if (
        host === 'fstream365.com' ||
        host.endsWith('.fstream365.com') ||
        host === 'vsembed.ru' ||
        host.endsWith('.vsembed.ru') ||
        host === 'vidsrc.to' ||
        host.endsWith('.vidsrc.to') ||
        host === 'vidsrc.me' ||
        host.endsWith('.vidsrc.me') ||
        host === 'embed.st' ||
        host.endsWith('.embed.st') ||
        host === 'embedhd.st' ||
        host.endsWith('.embedhd.st') ||
        host === 'embedindia.st' ||
        host.endsWith('.embedindia.st') ||
        host === 'rivestream.ru' ||
        host.endsWith('.rivestream.ru') ||
        host === 'zenox.lol' ||
        host.endsWith('.zenox.lol') ||
        host === 'vaplayer.ru' ||
        host.endsWith('.vaplayer.ru') ||
        host === 'vidup.to' ||
        host.endsWith('.vidup.to') ||
        host === 'primesrc.me' ||
        host.endsWith('.primesrc.me') ||
        host === 'player.videasy.to' ||
        host.endsWith('.videasy.to') ||
        host === 'player.cinezo.live' ||
        host.endsWith('.cinezo.live') ||
        host === 'player.vidzee.wtf' ||
        host.endsWith('.vidzee.wtf') ||
        host === 'mapple.fun' ||
        host.endsWith('.mapple.fun') ||
        host === 'cinextream.cc' ||
        host.endsWith('.cinextream.cc') ||
        host === 'soccerfull.net' ||
        host.endsWith('.soccerfull.net') ||
        host === 'livextv.hybrows.workers.dev' ||
        host.includes('netmirror') ||
        host.includes('mcloud') ||
        // Local Nationwide / YouTube live embeds opened as player tiles.
        ((host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') &&
          (/^\/embed\//i.test(path) || /^\/live\/?/i.test(path) || path === '/watch'))
      ) {
        return true
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return (
      host === 'embed.st' ||
      host.endsWith('.embed.st') ||
      host === 'embedhd.st' ||
      host.endsWith('.embedhd.st')
    )
  } catch {
    return false
  }
}

/** True when two in-app browser targets are the same page (skip redundant reload). */
export function sameBrowserPageUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    if (left.hostname.replace(/^www\./, '') !== right.hostname.replace(/^www\./, '')) return false
    if (left.pathname === '/watch' && right.pathname === '/watch') {
      return left.searchParams.get('v') === right.searchParams.get('v')
    }
    return left.href.split('#')[0] === right.href.split('#')[0]
  } catch {
    return a === b
  }
}

const RIVE_DIRECT_PLAYER_HOST =
  /(^|\.)(vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov)$/i

function rivestreamTmdbFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'rivestream.ru' || host.endsWith('.rivestream.ru')) {
      return String(u.searchParams.get('id') || u.searchParams.get('tmdb') || '').trim()
    }
    const m =
      u.pathname.match(/\/(?:embed\/)?tv\/(\d+)(?:\/|$)/i) ||
      u.pathname.match(/\/tv\/(\d+)-\d+-\d+/i)
    if (m) return m[1]
    return String(u.searchParams.get('tmdb') || u.searchParams.get('id') || '').trim()
  } catch {
    return ''
  }
}

/**
 * Guest hopped off the Rive shell to a direct player for the same title —
 * do not yank back to rivestream.ru/embed (causes white↔loading flash loops).
 */
export function shouldKeepRiveGuestHop(currentUrl: string, requestedUrl: string): boolean {
  try {
    const current = String(currentUrl || '')
    const requested = String(requestedUrl || '')
    if (!current || !requested) return false
    if (sameBrowserPageUrl(current, requested)) return true
    const curHost = new URL(current).hostname.replace(/^www\./, '').toLowerCase()
    const reqHost = new URL(requested).hostname.replace(/^www\./, '').toLowerCase()
    const reqIsRive = reqHost === 'rivestream.ru' || reqHost.endsWith('.rivestream.ru')
    if (!reqIsRive || !RIVE_DIRECT_PLAYER_HOST.test(curHost)) return false
    const reqId = rivestreamTmdbFromUrl(requested)
    const curId = rivestreamTmdbFromUrl(current)
    return Boolean(reqId && curId && reqId === curId)
  } catch {
    return false
  }
}

/** Prefer /live pages so the current stream opens and can autoplay */
export function toAutoplayUrl(raw: string): string {
  let target = normalizeWebUrl(raw)
  try {
    const u = new URL(target)
    if (!/youtube\.com$/i.test(u.hostname) && !/\.youtube\.com$/i.test(u.hostname)) {
      return target
    }
    // @handle or /channel/ID → /live
    if (/^\/@[^/]+\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, '/live')
      return u.toString()
    }
    if (/^\/channel\/[^/]+\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, '/live')
      return u.toString()
    }
    // watch URLs: ensure autoplay query for embeds / some clients
    if (u.pathname === '/watch' && u.searchParams.has('v')) {
      u.searchParams.set('autoplay', '1')
      return u.toString()
    }
  } catch {
    /* ignore */
  }
  return target
}

/**
 * Prefer Rivestream Direct watch mode (Vanguard/Citadel/…) before Embed servers.
 * Seeds localStorage and clicks the Direct control when Embed is active.
 */
export const RIVESTREAM_PREFER_DIRECT_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    if (!/(^|\\.)rivestream\\.(ru|app)$/i.test(host)) return 'skip-host';
    try {
      localStorage.setItem('RiveStreamWatchMode', 'direct');
      localStorage.setItem('RiveStreamEmbedMode', 'false');
    } catch (_) {}

    const clickDirect = () => {
      try {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span, label, a'));
        for (const el of nodes) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.closest('video, audio, iframe')) continue;
          const label = String(
            el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '',
          ).replace(/\\s+/g, ' ').trim();
          if (!label || label.length > 48) continue;
          if (!/^(direct|playback\\s*mode\\s*:?\\s*direct)$/i.test(label) && !/^direct$/i.test(label)) {
            continue;
          }
          const selected =
            el.getAttribute('aria-pressed') === 'true' ||
            el.getAttribute('aria-selected') === 'true' ||
            /\\bis-(active|selected|checked)\\b/i.test(el.className || '');
          if (selected) return 'already';
          el.click();
          return 'clicked';
        }
        // Mode select / listbox option
        for (const el of Array.from(document.querySelectorAll('[role="option"], option, li'))) {
          if (!(el instanceof HTMLElement)) continue;
          const t = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!/^direct$/i.test(t)) continue;
          el.click();
          return 'option';
        }
      } catch (_) {}
      return 'none';
    };

    const once = clickDirect();
    if (!window.__jiyuRivePreferDirect) {
      window.__jiyuRivePreferDirect = true;
      window.setTimeout(clickDirect, 600);
      window.setTimeout(clickDirect, 1600);
      window.setTimeout(clickDirect, 3200);
    }
    return once;
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})();`

/**
 * Hide Rivestream Direct/Embed server picker chrome in the embed.
 * Covers the white Direct + Vanguard bar (and Embed + Server N).
 */
export const RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT = `(() => {
  try {
    const host = String(location.hostname || '').replace(/^www\\./i, '').toLowerCase();
    if (!/(^|\\.)rivestream\\.(ru|app)$/i.test(host)) return 'skip-host';

    const STYLE_ID = 'jiyu-rive-hide-servers';
    const PROVIDER =
      /\\b(Vanguard|Citadel|FlowCast|Flowcast|Apex|Pulse|Nova|Hydra|Shadow|Astra|Zenith|Orion|Vertex|Prism|Forge|Beacon|Harbor|Summit|Cascade)\\b/i;

    const hide = () => {
      try {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = [
          'html, body, #__next, #root, main {',
          '  background: #000 !important; color: #fff !important;',
          '  min-height: 100% !important; height: 100% !important;',
          '  overflow: hidden !important; margin: 0 !important; padding: 0 !important; }',
          'body > div, #__next > div, #root > div { background: transparent !important; }',
          'video, iframe { background: #000 !important; }',
          '[aria-label="Playback Mode"],',
          '[aria-label="Select Aggregator Server"],',
          '[aria-label="Select Direct Server"],',
          '[aria-label="Select Local Media Server"],',
          '[aria-label="Select Server"],',
          '[aria-label*="Server"],',
          '[aria-label*="server"],',
          '[aria-label*="Playback Mode"],',
          '[aria-label*="Controls Bar"],',
          '[aria-label*="controls bar"],',
          '[title*="Controls Bar"],',
          '[aria-label="Expand Controls Bar"],',
          '[aria-label="Shrink Controls Bar"],',
          '[title="Expand Controls Bar"],',
          '[title="Shrink Controls Bar"],',
          '[aria-label*="Quick Menu"],',
          '[aria-label*="quick menu"],',
          '[title*="Quick Menu"],',
          'button#source, button[name="source"],',
          'select#watchMode, select[name="watchMode"],',
          '[class*="watchBar"], [class*="WatchBar"],',
          '[class*="modeSelect"], [class*="serverSelect"], [class*="ServerSelect"],',
          '[class*="selectWrapper"], [class*="pillText"], [class*="pillChevron"],',
          '[class*="expandedContent"], [class*="collapsedContent"],',
          '[class*="collapsedState"], [class*="expandedState"],',
          '[class*="hideNavBtn"], [class*="sourceBar"], [class*="SourceBar"],',
          '[class*="aggregator"], [class*="quickMenu"], [class*="QuickMenu"],',
          '[data-testid*="server"], [data-testid*="watch-bar"]',
          '{ display: none !important; visibility: hidden !important; opacity: 0 !important;',
          '  pointer-events: none !important; height: 0 !important; max-height: 0 !important;',
          '  overflow: hidden !important; margin: 0 !important; padding: 0 !important;',
          '  background: transparent !important; border: 0 !important; }',
        ].join('');

        // Reclaim white bars left after hiding Direct/Vanguard / Servers & Mode.
        try {
          document.documentElement.style.setProperty('background', '#000', 'important');
          document.body && document.body.style.setProperty('background', '#000', 'important');
        } catch (_) {}
        for (const el of Array.from(document.querySelectorAll('div, section, main, header, footer'))) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.closest('video, audio, iframe')) continue;
          const cs = window.getComputedStyle(el);
          const bg = String(cs.backgroundColor || '');
          const r = el.getBoundingClientRect();
          const looksWhiteBar =
            r.width > window.innerWidth * 0.5 &&
            r.height > 28 &&
            r.height < 120 &&
            (r.top < 8 || r.bottom > window.innerHeight - 140) &&
            /rgb\\(\\s*2(?:5[0-5]|4\\d)\\s*,\\s*2(?:5[0-5]|4\\d)\\s*,\\s*2(?:5[0-5]|4\\d)/i.test(bg);
          if (looksWhiteBar) {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('height', '0', 'important');
            el.style.setProperty('background', 'transparent', 'important');
          }
        }

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
          el.setAttribute('data-jiyu-rive-hidden', '1');
        };

        const killBar = (el) => {
          kill(el);
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            if (p === document.body || p === document.documentElement) break;
            const pt = String(p.textContent || '').replace(/\\s+/g, ' ').trim();
            if (pt.length > 220) break;
            const hasMode = /\\b(Direct|Embed)\\b/i.test(pt);
            const hasServer =
              PROVIDER.test(pt) || /\\bServer\\s*\\d+/i.test(pt) || /\\b\\d{3,4}p\\b/i.test(pt);
            if (hasMode && hasServer) kill(p);
            p = p.parentElement;
          }
        };

        for (const el of Array.from(document.querySelectorAll(
          '[aria-label*="Controls Bar"], [aria-label*="controls bar"],' +
          '[aria-label*="Server"], [aria-label*="server"],' +
          '[aria-label*="Playback Mode"], [aria-label*="Quick Menu"],' +
          '[class*="watchBar"], [class*="WatchBar"], [class*="serverSelect"], [class*="ServerSelect"],' +
          '[class*="sourceBar"], [class*="SourceBar"], [class*="quickMenu"], [class*="QuickMenu"]',
        ))) {
          kill(el);
        }

        for (const el of Array.from(document.querySelectorAll('button, div, span, section, nav, label, a'))) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.getAttribute('data-jiyu-rive-hidden') === '1') continue;
          if (el.closest('video, audio, iframe')) continue;
          const raw = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!raw || raw.length > 160) continue;
          if (/Servers\\s*&\\s*Mode/i.test(raw) || /^QUICK\\s*MENU$/i.test(raw)) {
            killBar(el);
            continue;
          }
          // Direct + Vanguard (480p) bar, or Embed + Server N
          const looksLikeServerCapsule =
            !el.querySelector('iframe, video') &&
            (
              (/\\bDirect\\b/i.test(raw) && (PROVIDER.test(raw) || /\\b\\d{3,4}p\\b/i.test(raw))) ||
              (/\\bEmbed\\b/i.test(raw) && /\\bServer\\s*\\d+/i.test(raw)) ||
              (/^(Direct|Embed)$/i.test(raw) && PROVIDER.test(String(el.parentElement && el.parentElement.textContent || '')))
            );
          if (looksLikeServerCapsule) killBar(el);
        }
      } catch (_) {}
    };

    hide();
    if (!window.__jiyuRiveHideObs) {
      window.__jiyuRiveHideObs = true;
      try {
        const mo = new MutationObserver(() => hide());
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
      window.setInterval(hide, 700);
    }
    return 'ok';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})();`

/** Prefer English audio tracks in Rivestream embeds (default for non-anime). */
export const RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT = `(() => {
  try {
    const NON_EN =
      /hindi|\\bhin\\b|arabic|spanish|español|french|german|portuguese|russian|turkish|indonesian|vietnamese|tamil|telugu|urdu|korean|chinese|mandarin|japanese|\\bjp\\b|\\bja\\b/i;
    const pickEnglish = (video) => {
      if (!(video instanceof HTMLVideoElement)) return;
      const tracks = video.audioTracks;
      if (!tracks || tracks.length < 2) return;
      let enIdx = -1;
      let fallbackIdx = -1;
      for (let i = 0; i < tracks.length; i++) {
        const label = String(tracks[i].label || tracks[i].language || '').toLowerCase();
        if (/english|\\beng\\b|\\ben\\b|en-?us|en-?gb/.test(label)) {
          enIdx = i;
          break;
        }
        if (fallbackIdx < 0 && !NON_EN.test(label)) fallbackIdx = i;
      }
      const pick = enIdx >= 0 ? enIdx : fallbackIdx;
      if (pick < 0) return;
      for (let j = 0; j < tracks.length; j++) tracks[j].enabled = j === pick;
    };
    for (const v of document.querySelectorAll('video')) pickEnglish(v);
    if (!window.__jiyuRiveEnglishObs) {
      window.__jiyuRiveEnglishObs = true;
      try {
        const mo = new MutationObserver(() => {
          for (const v of document.querySelectorAll('video')) pickEnglish(v);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
      window.setInterval(() => {
        for (const v of document.querySelectorAll('video')) pickEnglish(v);
      }, 1200);
    }
    return 'ok';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})();`

/**
 * Sports embeds often refuse to play when nested in a sandboxed iframe
 * ("Remove sandbox attributes on the iframe tag"). Android WebView hosts
 * sometimes inherit sandbox from wrappers — strip and reload once.
 */
export const EMBED_STRIP_SANDBOX_SCRIPT = `(() => {
  try {
    const allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';
    const fixOne = (frame) => {
      if (!frame || frame.dataset.jiyuUnsandboxed === '1') return false;
      const hadSandbox = frame.hasAttribute('sandbox');
      if (!hadSandbox) {
        if (!frame.getAttribute('allow')) frame.setAttribute('allow', allow);
        if (!frame.hasAttribute('allowfullscreen')) frame.setAttribute('allowfullscreen', '');
        return false;
      }
      frame.dataset.jiyuUnsandboxed = '1';
      const src = frame.getAttribute('src') || frame.src || '';
      frame.removeAttribute('sandbox');
      frame.setAttribute('allow', allow);
      frame.setAttribute('allowfullscreen', '');
      if (src) {
        try { frame.src = src; } catch (_) {}
      }
      return true;
    };
    let n = 0;
    document.querySelectorAll('iframe').forEach((f) => {
      if (fixOne(f)) n += 1;
    });
    if (!window.__jiyuSandboxObserver) {
      window.__jiyuSandboxObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'sandbox' && m.target && m.target.tagName === 'IFRAME') {
            fixOne(m.target);
          }
          m.addedNodes && m.addedNodes.forEach((node) => {
            if (!node || node.nodeType !== 1) return;
            if (node.tagName === 'IFRAME') fixOne(node);
            else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(fixOne);
          });
        }
      });
      try {
        window.__jiyuSandboxObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['sandbox'],
        });
      } catch (_) {}
    }
    return n ? 'unsandboxed:' + n : 'ok';
  } catch (e) {
    return 'error';
  }
})();`

export const EMBED_AD_HIDE_SCRIPT = `(() => {
  try {
    const cssId = 'jiyu-adhide-style';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('style');
      css.id = cssId;
      css.textContent = \`
        #ol-ads, #ol-iframe, #timer-close, #remove-tag,
        iframe#close, iframe[src*="/ad.html"],
        iframe[src*="/banner/static/"],
        iframe[src*="tsyndicate"], iframe[src*="exoclick"], iframe[src*="juicyads"],
        iframe[src*="trafficjunky"], iframe[src*="adsterra"], iframe[src*="popads"],
        iframe[src*="propeller"], iframe[src*="doubleclick"], iframe[src*="adaround"],
        iframe[id*="google_ads"],
        iframe[src*="nextgencloudfabric"],
        [data-jiyu-ad-hide="1"] {
          display: none !important; visibility: hidden !important; pointer-events: none !important;
          width: 0 !important; height: 0 !important; max-height: 0 !important; opacity: 0 !important;
        }
        video, video * {
          visibility: visible !important; opacity: 1 !important;
        }
      \`;
      (document.head || document.documentElement).appendChild(css);
    }

    // Fake notification popups on Rivestream / embeds ("You received a message!", OK).
    const looksFake = (text) => {
      if (!text) return false;
      if (/You received a message!?/i.test(text)) return true;
      if (/You have (?:a |received a )?message!?/i.test(text)) return true;
      if (/New message!?/i.test(text) && /\\bOK\\b/i.test(text)) return true;
      if (/A Surprise Is Waiting/i.test(text) && /OPEN\\s*NOW/i.test(text)) return true;
      if (
        /(?:push|browser)\\s+notification/i.test(text) &&
        /\\b(?:OK|Allow|Accept|Open)\\b/i.test(text) &&
        text.length < 280
      ) {
        return true;
      }
      return false;
    };
    const hideFakePushAds = () => {
      try {
        const nodes = document.querySelectorAll('div,section,aside,article');
        for (const el of nodes) {
          if (!el || el.getAttribute('data-jiyu-ad-hide') === '1') continue;
          let text = '';
          try { text = String(el.innerText || el.textContent || ''); } catch (_) { continue; }
          text = text.replace(/\\s+/g, ' ').trim();
          if (!text || text.length > 360) continue;
          if (!looksFake(text)) continue;
          let target = el;
          try {
            for (let i = 0; i < 6 && target.parentElement; i += 1) {
              const parent = target.parentElement;
              if (!parent || parent === document.body || parent === document.documentElement) break;
              const st = window.getComputedStyle(parent);
              const pos = st ? String(st.position || '') : '';
              if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
                target = parent;
                break;
              }
              let parentText = '';
              try { parentText = String(parent.innerText || '').replace(/\\s+/g, ' ').trim(); } catch (_) {}
              if (parentText && parentText.length <= text.length + 64 && looksFake(parentText)) {
                target = parent;
                continue;
              }
              break;
            }
          } catch (_) {}
          try {
            target.setAttribute('data-jiyu-ad-hide', '1');
            target.style.setProperty('display', 'none', 'important');
            target.style.setProperty('visibility', 'hidden', 'important');
            target.style.setProperty('pointer-events', 'none', 'important');
            target.style.setProperty('opacity', '0', 'important');
            try { target.remove(); } catch (_) {}
          } catch (_) {}
        }
      } catch (_) {}
    };
    hideFakePushAds();
    if (!window.__jiyuFakePushObs) {
      window.__jiyuFakePushObs = true;
      try {
        let scheduled = 0;
        const kick = () => {
          if (scheduled) return;
          scheduled = window.setTimeout(() => {
            scheduled = 0;
            hideFakePushAds();
          }, 200);
        };
        new MutationObserver(kick).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        window.setInterval(hideFakePushAds, 1500);
      } catch (_) {}
    }

    // Neutralize fstream's vc_invideo ad injector when present.
    try {
      const noop = function () {};
      window.vc_invideo = window.vc_invideo || {};
      window.vc_invideo.addTag = noop;
      window.vc_invideo.removeTag = function () {
        try { document.querySelectorAll('#ol-ads').forEach((n) => n.remove()); } catch (_) {}
      };
      window.vc_invideo.countDown = noop;
      window.vc_invideo.adType = function () { return 0; };
      window.vc_invideo.adStatus = function () { return false; };
    } catch (_) {}

    const kill = () => {
      try {
        document.querySelectorAll(
          '#ol-ads, #ol-iframe, iframe#close, iframe[src*="/ad.html"], iframe[src*="/banner/static/"]',
        ).forEach((n) => {
          try { n.remove(); } catch (_) {
            n.style.setProperty('display', 'none', 'important');
          }
        });
        // Text-match residual countdown banners (in case markup changes).
        for (const el of Array.from(document.querySelectorAll('div, section, aside'))) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.querySelector('video, canvas')) continue;
          const t = (el.innerText || '').slice(0, 180);
          if (/This will be closed after\\s*\\d+\\s*seconds/i.test(t)) {
            el.remove();
          } else if (/Cloud:\\s*use (?:AD-Blocker|video downloader)/i.test(t)) {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
            if (el.parentElement && /Cloud:\\s*use/i.test(el.parentElement.innerText || '')) {
              el.parentElement.style.setProperty('display', 'none', 'important');
            }
          }
        }
      } catch (_) {}
    };

    kill();
    if (!window.__jiyuAdHideObs) {
      window.__jiyuAdHideObs = new MutationObserver(() => kill());
      window.__jiyuAdHideObs.observe(document.documentElement, { childList: true, subtree: true });
      window.setInterval(kill, 1000);
    }
    return 'ok';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})();`

/**
 * Hide embed.st / maestro "CLICK UNMUTE STREAM" overlays on the video.
 * Jiyu exposes its own Unmute control in the player chrome and PiP bar.
 */
export const EMBED_UNMUTE_OVERLAY_SCRIPT = `(() => {
  try {
    const styleId = 'jiyu-unmute-overlay-style';
    if (!document.getElementById(styleId)) {
      const css = document.createElement('style');
      css.id = styleId;
      css.textContent = \`
        .jiyu-unmute-hidden,
        [data-jiyu-unmute-hidden="1"] {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
          opacity: 0 !important;
        }
      \`;
      (document.head || document.documentElement).appendChild(css);
    }

    const hideOverlays = () => {
      for (const el of document.querySelectorAll('button, a, div, span, p, label, h1, h2, h3')) {
        if (!(el instanceof HTMLElement)) continue;
        const t = (el.textContent || '').trim();
        if (!/unmute/i.test(t) || t.length > 100) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 10) continue;
        if (el.querySelector('video')) continue;
        el.setAttribute('data-jiyu-unmute-hidden', '1');
        el.classList.add('jiyu-unmute-hidden');
      }
    };

    hideOverlays();
    if (!window.__jiyuUnmuteHideObs) {
      window.__jiyuUnmuteHideObs = new MutationObserver(hideOverlays);
      window.__jiyuUnmuteHideObs.observe(document.documentElement, { childList: true, subtree: true });
      window.setInterval(hideOverlays, 700);
    }
    return 'ok';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})();`

/**
 * Stop sites (YouTube) from calling the Fullscreen API inside the in-app browser.
 * Jiyu’s own Full button fullscreens the outer tile, not the guest page.
 */
export const BLOCK_GUEST_FULLSCREEN_SCRIPT = `(() => {
  try {
    const reject = () => Promise.reject(new DOMException('Fullscreen blocked in Jiyu', 'NotAllowedError'));
    const patch = (proto, key) => {
      try {
        if (proto && typeof proto[key] === 'function') proto[key] = reject;
      } catch (_) {}
    };
    patch(Element.prototype, 'requestFullscreen');
    patch(Element.prototype, 'webkitRequestFullscreen');
    patch(Element.prototype, 'webkitRequestFullScreen');
    patch(HTMLElement.prototype, 'webkitRequestFullScreen');
    // Exit if something already went fullscreen before the patch.
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch (_) {}
    return 'blocked';
  } catch (_) {
    return 'error';
  }
})();`

/** Only start playback if paused — never click controls that toggle pause */
export const AUTOPLAY_SCRIPT = `(() => {
  try {
    const videos = Array.from(document.querySelectorAll('video'));
    const active = videos.find((v) => !v.paused && !v.ended && v.readyState > 1);
    if (active) return 'already-playing';

    const video = videos[0];
    if (video && video.paused) {
      // Muted play satisfies autoplay policies; leave volume to the user
      video.muted = true;
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return 'play-called';
    }

    // Only the large center play button (not the toolbar toggle)
    const large = document.querySelector('button.ytp-large-play-button');
    if (large && large.getAttribute('aria-hidden') !== 'true') {
      large.click();
      return 'large-play-click';
    }
    return 'noop';
  } catch (_) {
    return 'error';
  }
})();`

/**
 * PiP is opened from an explicit user click — play with sound when possible.
 * Falls back to muted play, then unmutes after playback starts.
 * Also kicks Clappr / JW / generic center-play overlays (embed.st sports).
 */
export const AUTOPLAY_WITH_SOUND_SCRIPT = `(() => {
  try {
    const level =
      typeof window.__jiyuVolLevel === 'number' && Number.isFinite(window.__jiyuVolLevel)
        ? Math.max(0, Math.min(1, window.__jiyuVolLevel))
        : 1;
    const wantSound = level > 0.001;
    const unmute = (video) => {
      try {
        video.muted = !wantSound;
        video.volume = wantSound ? level : 0;
        if (!wantSound) return;
        const muteBtn = document.querySelector('.ytp-mute-button[aria-pressed="true"], .ytp-mute-button[title*="Unmute"]');
        if (muteBtn) muteBtn.click();
      } catch (_) {}
    };

    const clickUnmuteOverlay = () => {
      if (!wantSound) return null;
      const nodes = Array.from(document.querySelectorAll('button, a, div, span, p, label, h1, h2, h3'));
      for (const el of nodes) {
        const t = (el.textContent || '').trim();
        if (!/unmute/i.test(t) || t.length > 100) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 10) continue;
        try { el.click(); return 'unmute-overlay-click'; } catch (_) {}
      }
      return null;
    };

    const tryPlayVideo = (video) => {
      if (!video) return false;
      if (!video.paused && !video.ended) {
        unmute(video);
        return true;
      }
      video.muted = true;
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => unmute(video)).catch(() => {});
      } else {
        unmute(video);
      }
      return true;
    };

    const videosEarly = Array.from(document.querySelectorAll('video'));
    const alreadyPlaying = videosEarly.find((v) => !v.paused && !v.ended);
    if (alreadyPlaying) {
      unmute(alreadyPlaying);
      clickUnmuteOverlay();
      return wantSound ? 'already-playing' : 'already-muted';
    }

    // Sports embeds (embed.st / Clappr / VJS): prefer video.play() — UI clicks toggle pause.
    const videos = Array.from(document.querySelectorAll('video'));
    let started = false;
    for (const video of videos) {
      if (tryPlayVideo(video)) started = true;
    }
    if (started) {
      clickUnmuteOverlay();
      return wantSound ? 'play-with-sound' : 'play-kept-muted';
    }

    const playUi = document.querySelector(
      '.media-control-button[data-play], .play-wrapper, .clappr-play-button,' +
      ' button[aria-label*="Play" i], button[title*="Play" i],' +
      ' .vjs-big-play-button, .jw-icon-display, .jw-display-icon-container,' +
      ' .jw-display, .jwplayer .jw-display-icon-container, .vjs-poster'
    );
    if (playUi) {
      try { playUi.click(); } catch (_) {}
    }

    if (typeof jwplayer === 'function') {
      try {
        const p = jwplayer();
        p.setMute(true);
        if (p.getState && p.getState() !== 'playing') p.play();
        p.setMute(!wantSound);
        p.setVolume(wantSound ? Math.round(level * 100) : 0);
      } catch (_) {}
    }

    const afterPlay = Array.from(document.querySelectorAll('video'));
    for (const video of afterPlay) {
      if (tryPlayVideo(video)) started = true;
    }
    if (started) {
      clickUnmuteOverlay();
      return wantSound ? 'play-with-sound' : 'play-kept-muted';
    }

    const overlay = clickUnmuteOverlay();
    if (overlay) return overlay;

    if (playUi) {
      const after = document.querySelector('video');
      if (after) unmute(after);
      return 'play-ui-click';
    }

    return 'no-video';
  } catch (_) {
    return 'error';
  }
})();`

/** True inside the Electron shell (preload bridge or Electron UA). */
export function isDesktopApp() {
  if (window.signalDesktop?.isDesktop || window.signalDesktop?.browserNavigate) return true
  return /Electron/i.test(navigator.userAgent)
}

export type WebSearchKind = 'youtube' | 'web'

/** Build a YouTube results URL or a general web search URL. */
export function buildSearchUrl(query: string, kind: WebSearchKind): string {
  const q = query.trim()
  if (!q) {
    return kind === 'youtube' ? 'https://www.youtube.com/' : 'https://duckduckgo.com/'
  }
  if (kind === 'youtube') {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`
}

export function normalizeWebUrl(raw: string): string {
  let target = raw.trim()
  if (!target) return 'https://www.youtube.com/'
  if (!/^https?:\/\//i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}([/:?]|$)/i.test(target)) {
      target = `https://${target}`
    } else {
      target = buildSearchUrl(target, 'web')
    }
  }
  return target
}

export function openWebDestination(url: string) {
  if (isDesktopApp() || isInAppBrowserAvailable()) {
    return { mode: 'in-app' as const, url }
  }
  if (window.signalDesktop?.openExternal) {
    void window.signalDesktop.openExternal(url)
    return { mode: 'external' as const, url }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return { mode: 'external' as const, url }
}
