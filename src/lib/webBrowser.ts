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
    url: 'https://www.youtube.com/@nationwidenewsnetwork/live',
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
]

/** Map a local channel title to its live play URL */
export function liveUrlForChannelTitle(title: string): string {
  const name = title.replace(/\s*[\[(].*$/, '').trim().toLowerCase()
  if (name.startsWith('cvm')) return 'https://www.youtube.com/@cvmtvnews/live'
  if (name.startsWith('tvj')) return 'https://www.youtube.com/@TelevisionJamaica/live'
  if (name.startsWith('nationwide') || name === 'nnn') {
    return 'https://www.youtube.com/@nationwidenewsnetwork/live'
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

/** True inside the Electron shell (preload bridge or Electron UA). */
export function isDesktopApp() {
  if (window.signalDesktop?.isDesktop || window.signalDesktop?.browserNavigate) return true
  return /Electron/i.test(navigator.userAgent)
}

export function normalizeWebUrl(raw: string): string {
  let target = raw.trim()
  if (!target) return 'https://www.youtube.com/'
  if (!/^https?:\/\//i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}([/:?]|$)/i.test(target)) {
      target = `https://${target}`
    } else {
      target = `https://www.youtube.com/results?search_query=${encodeURIComponent(target)}`
    }
  }
  return target
}

export function openWebDestination(url: string) {
  if (isDesktopApp()) {
    return { mode: 'in-app' as const, url }
  }
  if (window.signalDesktop?.openExternal) {
    void window.signalDesktop.openExternal(url)
    return { mode: 'external' as const, url }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return { mode: 'external' as const, url }
}
