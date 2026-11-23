import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AUTOPLAY_WITH_SOUND_SCRIPT,
  BLOCK_GUEST_FULLSCREEN_SCRIPT,
  EMBED_AD_HIDE_SCRIPT,
  EMBED_STRIP_SANDBOX_SCRIPT,
  EMBED_UNMUTE_OVERLAY_SCRIPT,
  GUEST_ACTIVITY_SCRIPT,
  RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT,
  RIVESTREAM_PREFER_DIRECT_SCRIPT,
  RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT,
  STREAMFREE_EMBED_PLAY_SCRIPT,
  PLAYMOGO_CLEANUP_SCRIPT,
  YOUTUBE_BUFFER_FEEDBACK_SCRIPT,
  isDesktopApp,
  isCloudflareChallengeTarget,
  isBlankBrowserUrl,
  isEmbedPlayerHost,
  isPlaceholderBrowserTitle,
  isPlaymogoEmbedUrl,
  isSportsOrReplayEmbedUrl,
  isStreamFreeEmbedUrl,
  isYouTubeUrl,
  toAutoplayUrl,
  WEB_GUEST_ACTIVITY_EVENT,
} from '../lib/webBrowser'
import { takePromotedEmbed } from '../lib/multiviewCollapse'
import { RIVESTREAM_EMBED_AUTO_SCRIPT } from '../lib/rivestreamEmbedAuto'
import { cinetaroPlaybackUrl, isCinetaroCatalogPageUrl } from '../lib/cinetaro'
import {
  androidBrowserExecute,
  androidBrowserTapPlay,
  androidBrowserGoBack,
  androidBrowserGoForward,
  androidBrowserHide,
  androidBrowserNavigate,
  androidBrowserOnNav,
  androidBrowserReload,
  androidBrowserSetBounds,
  androidBrowserShow,
  androidBrowserTvPointer,
  isAndroidInAppBrowser,
  isInAppBrowserAvailable,
} from '../lib/androidBrowser'
import {
  enterOsFullscreen,
  exitOsFullscreen,
  getFullscreenOwner,
  syncFullscreenOwnerFromOs,
} from '../lib/fullscreenSession'
import type { BrowserBounds, BrowserNavState } from '../types'

export type WebBrowserMode = 'off' | 'page' | 'pip'

const PIP_WIDTH = 380
const PIP_HEIGHT = 180
const PIP_CHROME = 44
const PIP_MARGIN = 12

/** Live streams: keep "Unwrapping stream…" over the page until a video is really playing. */
const UNWRAP_COVER_TICK_MS = 300
const UNWRAP_COVER_MAX_MS = 30_000
/** PPV mirrors reload JW a few times before the first frame — give them room. */
const UNWRAP_COVER_SPORTS_MAX_MS = 50_000
const UNWRAP_COVER_MIN_MS = 800
/** After the cover gives up: keep checking (slowly) so a late start clears the notice. */
const STALL_WATCH_TICK_MS = 2_500
const STALL_WATCH_MAX_MS = 3 * 3600_000
const STALL_MESSAGE =
  'This stream is offline, or it never started. Tap Retry, or go Back and pick another listing.'
const STREAM_OFFLINE_MESSAGE =
  'This stream is offline. Tap Retry, or go Back and pick another listing.'
const LEGAL_BLOCK_MESSAGE =
  'This site refused the page for legal reasons (Error 451). Nothing will play here. Go Back and pick another listing.'

/** Live embeds (sports / replays / YouTube) get the unwrap cover — not Nationwide. */
function wantsUnwrapCover(url: string): boolean {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return false
  // Nationwide Worker HLS or its YouTube /live fallback — never "Unwrapping stream…".
  if (/jiyu-nnn\.free-river\.workers\.dev|jiyu\.free-river\.workers\.dev\/(?:nnn|nationwide)/i.test(u)) {
    return false
  }
  if (/youtube\.com\/@(?:nnn-RADIOLIVE|nationwidenewsnetwork)/i.test(u)) return false
  if (isSportsOrReplayEmbedUrl(u)) return true
  return /^https?:\/\/(www\.|m\.)?youtube(-nocookie)?\.com\/(embed\/|watch\?|live\/)/i.test(u)
}

function unwrapCoverBudgetMs(url: string): number {
  if (isSportsOrReplayEmbedUrl(url) || /embed(?:india|hd)?\.st|ppv\.st|streamed\.pk|streamfree|strmfree/i.test(url)) {
    return UNWRAP_COVER_SPORTS_MAX_MS
  }
  return UNWRAP_COVER_MAX_MS
}

/**
 * Runs in every frame. Any frame whose <video> is really MOVING reports playing (and the
 * top frame drops its cover). "Moving" = visible, not paused, readyState >= 2, and
 * currentTime or decoded frames advanced on two consecutive checks - a 'playing' state
 * alone is not enough (live HLS sits !paused on a black/buffering frame for seconds).
 * Ads are ignored: YouTube '.ad-showing' players always, and short (< 75s) finite non-MSE
 * clips for the first 12s of this frame's cover. MSE (blob:) streams are never skipped -
 * hls.js live reports a small, growing finite duration. The top frame otherwise keeps a black pointer-events:none cover
 * so native taps / center clicks still reach the player underneath.
 * Results avoid words the Android bridge ranks above "playing" (installed/ready/placed).
 */
const UNWRAP_COVER_TICK_SCRIPT = `(function(){try{
var d=document,ID='__jiyu_unwrap_cover',now=Date.now();
var legal=(d.title||'');
try{legal+=' '+((d.body&&d.body.innerText)||'').slice(0,800);}catch(e){}
if(/error\\s*451|unavailable for legal reasons/i.test(legal)){
  var cL=d.getElementById(ID);if(cL&&cL.parentNode)cL.parentNode.removeChild(cL);
  return 'jiyu-live-legal';
}
if(!window.__jiyuSegHook){
  window.__jiyuSegHook=1;window.__jiyuSeg403=0;
  var hit=function(u,s){if(s===403&&/tiktokcdn|servehttp|m3u8|\\.image(\\?|$)/i.test(String(u||'')))window.__jiyuSeg403++;};
  try{var of=window.fetch;if(of){window.fetch=function(){return of.apply(this,arguments).then(function(r){try{hit(r.url,r.status)}catch(e){}return r})}}}catch(e){}
  try{var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this.__jiyuU=u;return XO.apply(this,arguments)};
  XMLHttpRequest.prototype.send=function(){var x=this;try{x.addEventListener('loadend',function(){try{hit(x.__jiyuU||x.responseURL,x.status)}catch(e){}})}catch(e){}return XS.apply(this,arguments)};}catch(e){}
}
if(!window.__jiyuCoverT0)window.__jiyuCoverT0=now;
var S=window.__jiyuMoveState||(window.__jiyuMoveState=new WeakMap());
var vids=d.getElementsByTagName('video'),live=false,mediaErr=false,mimeFatal=false;
for(var i=0;i<vids.length;i++){var v=vids[i];var r=v.getBoundingClientRect();
var er=v.error&&v.error.code;var src0=String(v.currentSrc||v.src||'');
var isM3u8=/\\.m3u8(\\?|$)/i.test(src0)||/mpegurl|x-mpegURL/i.test(src0);
if(er===2||er===4){
  // Gecko cannot play bare HLS — load()/play() just re-shows the MIME dialog.
  // Prefer hls.js (JW often leaves Hls on window); else signal host to hop HD/SD.
  if(er===4&&isM3u8){
    try{
      if(window.Hls&&Hls.isSupported&&Hls.isSupported()&&!v.__jiyuHlsFix){
        v.__jiyuHlsFix=1;
        var hh=new Hls({enableWorker:true,lowLatencyMode:true});
        hh.loadSource(src0);hh.attachMedia(v);
        hh.on(Hls.Events.MANIFEST_PARSED,function(){try{var p2=v.play();if(p2&&p2.catch)p2.catch(function(){});}catch(e){}});
        mediaErr=true;S.delete(v);continue;
      }
    }catch(e){}
    mimeFatal=true;mediaErr=true;S.delete(v);continue;
  }
  var R=window.__jiyuMediaErr||(window.__jiyuMediaErr={n:0,at:0});
  if(R.n<3&&now-R.at>4000){R.n++;R.at=now;try{v.load();var pp=v.play();if(pp&&pp.catch)pp.catch(function(){});}catch(e){}}
  mediaErr=true;S.delete(v);continue;
}
if(v.paused||v.ended||v.readyState<2||r.width<120||r.height<68){S.delete(v);continue;}
var dur=v.duration,src=src0;
if(v.closest&&v.closest('.ad-showing,.ad-interrupting'))continue;
if(src.indexOf('blob:')!==0&&isFinite(dur)&&dur>0&&dur<75&&now-window.__jiyuCoverT0<12000)continue;
var fr=0;try{var q=v.getVideoPlaybackQuality&&v.getVideoPlaybackQuality();fr=q?(q.totalVideoFrames||0):0;}catch(e){}
if(!fr&&typeof v.webkitDecodedFrameCount==='number')fr=v.webkitDecodedFrameCount;
var t=v.currentTime||0,p=S.get(v);
if(!p){S.set(v,{t:t,f:fr,at:now,n:0});continue;}
if(now-p.at<150)continue;
var adv=(t-p.t>0.08&&t-p.t<30)||(fr-p.f>=2);
p.n=adv?p.n+1:0;p.t=t;p.f=fr;p.at=now;
if(p.n>=2){live=true;break;}}
if(live){window.__jiyuUnwrapDone=true;var c0=d.getElementById(ID);if(c0&&c0.parentNode)c0.parentNode.removeChild(c0);return 'jiyu-live-playing';}
if(!live&&(window.__jiyuSeg403||0)>=5){try{var cF=d.getElementById(ID);if(cF&&cF.parentNode)cF.parentNode.removeChild(cF);var root=d.body||d.documentElement;if(root){var cN=d.createElement('div');cN.id=ID;cN.setAttribute('style','position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;color:#fff;font:600 18px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;pointer-events:auto');var mN=d.createElement('div');mN.textContent='This stream is offline. Tap Retry, or go Back and pick another listing.';mN.setAttribute('style','max-width:28rem');cN.appendChild(mN);root.appendChild(cN);}}catch(e){}return 'jiyu-live-offline';}
var idle=mimeFatal?'jiyu-live-mime':(mediaErr?'jiyu-live-mediaerr':'jiyu-live-idle');
if(window.top!==window||window.__jiyuUnwrapDone)return idle;
if(!d.getElementById(ID)){var root=d.body||d.documentElement;if(!root)return 'jiyu-live-idle';
var c=d.createElement('div');c.id=ID;
c.setAttribute('style','position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#000;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#fff;font:600 16px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.2px');
var st=d.createElement('style');st.textContent='@keyframes __jiyuUnwrapSpin{to{transform:rotate(360deg)}}';
var sp=d.createElement('div');sp.setAttribute('style','width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fff;animation:__jiyuUnwrapSpin .8s linear infinite');
var t=d.createElement('div');t.textContent='Unwrapping stream\\u2026';
c.appendChild(st);c.appendChild(sp);c.appendChild(t);root.appendChild(c);}
return idle;}catch(e){return 'jiyu-live-idle';}})()`

/** Same detection / media-error recovery, never adds the cover (post-cover watch). */
const LIVE_WATCH_SCRIPT = UNWRAP_COVER_TICK_SCRIPT.replace(
  'if(window.top!==window||window.__jiyuUnwrapDone)return idle;',
  'return idle;',
)

function execResultSaysOffline(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as { result?: unknown; frameResults?: Array<{ result?: unknown }> }
  if (String(r.result ?? '').includes('jiyu-live-offline')) return true
  return Array.isArray(r.frameResults)
    ? r.frameResults.some((f) => String(f?.result ?? '').includes('jiyu-live-offline'))
    : false
}

function execResultSaysLegalBlock(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as { result?: unknown; frameResults?: Array<{ result?: unknown }> }
  if (String(r.result ?? '').includes('jiyu-live-legal')) return true
  return Array.isArray(r.frameResults)
    ? r.frameResults.some((f) => String(f?.result ?? '').includes('jiyu-live-legal'))
    : false
}

function execResultSaysMediaError(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as { result?: unknown; frameResults?: Array<{ result?: unknown }> }
  if (String(r.result ?? '').includes('jiyu-live-mediaerr')) return true
  if (String(r.result ?? '').includes('jiyu-live-mime')) return true
  return Array.isArray(r.frameResults)
    ? r.frameResults.some(
        (f) =>
          String(f?.result ?? '').includes('jiyu-live-mediaerr') ||
          String(f?.result ?? '').includes('jiyu-live-mime'),
      )
    : false
}

/** Bare HLS on Gecko ("No video with supported format and MIME type found"). */
function execResultSaysMimeUnsupported(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as { result?: unknown; frameResults?: Array<{ result?: unknown }> }
  if (String(r.result ?? '').includes('jiyu-live-mime')) return true
  return Array.isArray(r.frameResults)
    ? r.frameResults.some((f) => String(f?.result ?? '').includes('jiyu-live-mime'))
    : false
}

const UNWRAP_COVER_REMOVE_SCRIPT = `(function(){try{window.__jiyuUnwrapDone=true;var c=document.getElementById('__jiyu_unwrap_cover');if(c&&c.parentNode)c.parentNode.removeChild(c);}catch(e){}return 'noop';})()`

const STREAM_OFFLINE_COVER_SCRIPT = `(function(){try{
var d=document,ID='__jiyu_unwrap_cover',root=d.body||d.documentElement;if(!root)return 'noop';
var c=d.getElementById(ID);if(c&&c.parentNode)c.parentNode.removeChild(c);
c=d.createElement('div');c.id=ID;
c.setAttribute('style','position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;color:#fff;font:600 18px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;pointer-events:auto');
var m=d.createElement('div');m.textContent='This stream is offline. Tap Retry, or go Back and pick another listing.';
m.setAttribute('style','max-width:28rem');
c.appendChild(m);root.appendChild(c);
return 'jiyu-live-offline';
}catch(e){return 'noop';}})()`

function execResultSaysPlaying(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as { result?: unknown; frameResults?: Array<{ result?: unknown }> }
  if (String(r.result ?? '').includes('jiyu-live-playing')) return true
  return Array.isArray(r.frameResults)
    ? r.frameResults.some((f) => String(f?.result ?? '').includes('jiyu-live-playing'))
    : false
}

function readSafeBottom(): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)'
  document.body.appendChild(probe)
  const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0
  probe.remove()
  return px
}
const FULLSCREEN_CHROME = 48

type WebBrowserContextValue = {
  desktop: boolean
  mode: WebBrowserMode
  nav: BrowserNavState
  /**
   * Catalog title of what the embed is playing (match / movie / show + episode).
   * Survives native nav updates (which report page titles or "Web browser") and
   * PiP -> Expand, so player chrome never falls back to the Jiyu location.
   */
  contentTitle: string
  setContentTitle: (title: string) => void
  address: string
  setAddress: (value: string) => void
  status: string | null
  setStatus: (value: string | null) => void
  fullscreen: boolean
  /** Bind the native browser to the page tile (no reload if already on a URL). */
  attachFrame: (frame: HTMLElement) => void
  detachFrame: () => void
  /** `unwrapCover: false` skips a second "Unwrapping stream…" after Media3 already sniffed. */
  openUrl: (raw: string, options?: { unwrapCover?: boolean }) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  /** Live embed never started playing (cover timed out): show Retry. */
  stalled: boolean
  /** Reopen the current live embed after a stall (fresh Gecko session if it died). */
  retryStalled: () => void
  openInPip: (url?: string, title?: string, options?: { navigateTo?: string }) => void
  /** When true, leaving /web for another route keeps the embed in web PiP. */
  setPipOnLeave: (enabled: boolean) => void
  /** Move an active embed watch session into PiP without changing routes. */
  minimizeActiveEmbedToPip: () => boolean
  expandFromPip: () => void
  closeBrowser: () => void
  /** Hide single-player web view without blanking — multi-view tiles take over. */
  parkForMultiview: () => void
  toggleFullscreen: () => void
  /** Exit-only — never re-enter (Esc / force-exit). */
  exitFullscreen: () => void
  /** Re-fit the native browser view to the page tile or fullscreen. */
  syncBrowserView: () => void
  /** Unmute / kick embed playback (Streamed, fstream, vsembed, …). */
  unmuteEmbed: () => void
}

const WebBrowserContext = createContext<WebBrowserContextValue | null>(null)

/** True when an Android chrome surface is painted and should reserve space. */
function isPaintedChrome(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false
  try {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 8 && rect.height > 8
  } catch {
    return false
  }
}

/** CSS→native overlay bounds; on Android, clamp away from sidebar / web chrome. */
export function boundsFromElement(el: HTMLElement): BrowserBounds {
  const rect = el.getBoundingClientRect()
  let x = Math.round(rect.left)
  let y = Math.round(rect.top)
  let width = Math.max(1, Math.round(rect.width))
  let height = Math.max(1, Math.round(rect.height))

  // Android: native Gecko sits above Capacitor — never cover the control strip
  // (Back / Mute / Full) or the app rail when it is visible. Multi-view owns
  // the whole window, so tiles must use the full stage.
  try {
    if (document.documentElement.classList.contains('multiview-open')) {
      return { x, y, width, height }
    }
    let minY = 0
    let minX = 0
    const chrome = document.querySelector(
      '.web-browser-page .web-chrome',
    ) as HTMLElement | null
    if (isPaintedChrome(chrome)) {
      minY = Math.max(minY, Math.ceil(chrome.getBoundingClientRect().bottom))
    }
    const sidebar = document.querySelector('.sidebar.sidebar-android') as HTMLElement | null
    if (isPaintedChrome(sidebar)) {
      const sr = sidebar.getBoundingClientRect()
      const landscape = window.matchMedia('(orientation: landscape)').matches
      if (landscape) {
        minX = Math.max(minX, Math.ceil(sr.right))
      } else {
        minY = Math.max(minY, Math.ceil(sr.bottom))
      }
    }
    if (minY > 0 && y < minY) {
      height = Math.max(1, height - (minY - y))
      y = minY
    }
    if (minX > 0 && x < minX) {
      width = Math.max(1, width - (minX - x))
      x = minX
    }
  } catch {
    /* ignore */
  }

  return { x, y, width, height }
}

/** True when the HTML tile is large enough to host the native overlay. */
function isUsableOverlayBounds(bounds: BrowserBounds): boolean {
  return bounds.width >= 32 && bounds.height >= 32
}

/**
 * Page-mode overlay bounds from the React tile. If the tile has not laid out yet
 * (common on Android embed flex — 0×0 black stage), fall back to the visible
 * viewport under chrome so Gecko/Electron is never parked at 1–2px.
 */
function pageOverlayBounds(frame: HTMLElement | null): BrowserBounds {
  if (frame) {
    const bounds = boundsFromElement(frame)
    if (isUsableOverlayBounds(bounds)) return bounds
  }
  return fullscreenBounds({ fullBleed: false })
}

/** Shared geometry for native stage + HTML chrome so they stay pixel-aligned. */
export function getPipLayout() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = Math.max(PIP_MARGIN, Math.round(readSafeBottom()) + 8)
  // Android: one standard corner size so PiP never fills half the screen.
  const android =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('is-android')
  const width = android
    ? Math.round(Math.min(280, Math.max(200, vw - margin * 2 - 24)))
    : vw < 720
      ? Math.round(Math.min(vw - 24, 420))
      : Math.round(Math.min(PIP_WIDTH, vw * 0.42))
  const stageHeight = android
    ? Math.round(width * (9 / 16))
    : PIP_HEIGHT
  const chromeHeight = PIP_CHROME
  const x = Math.round(vw - width - margin)
  const stageY = Math.round(vh - stageHeight - margin)
  return {
    width,
    margin,
    stageHeight,
    chromeHeight,
    x,
    stageY,
    chromeY: stageY - chromeHeight,
  }
}

function pipStageBounds(): BrowserBounds {
  const { x, stageY, width, stageHeight } = getPipLayout()
  return { x, y: stageY, width, height: stageHeight }
}

/** PiP fullscreen — never full-bleed; native view must not cover HTML chrome. */
function pipFullscreenBounds(): BrowserBounds {
  return fullscreenBounds({ fullBleed: false })
}

function topChromeClearance(): number {
  try {
    let top = FULLSCREEN_CHROME
    const chrome = document.querySelector('.web-browser-page .web-chrome') as HTMLElement | null
    if (isPaintedChrome(chrome)) {
      top = Math.max(top, Math.ceil(chrome.getBoundingClientRect().bottom))
    }
    const sidebar = document.querySelector('.sidebar.sidebar-android') as HTMLElement | null
    if (isPaintedChrome(sidebar)) {
      const landscape = window.matchMedia('(orientation: landscape)').matches
      if (!landscape) {
        top = Math.max(top, Math.ceil(sidebar.getBoundingClientRect().bottom))
      }
    }
    return top
  } catch {
    return FULLSCREEN_CHROME
  }
}

function fullscreenBounds(opts?: { fullBleed?: boolean }): BrowserBounds {
  const top = opts?.fullBleed ? 0 : topChromeClearance()
  return {
    x: 0,
    y: top,
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight - top)),
  }
}

/**
 * Page Full always keeps a top chrome strip. Toggling full-bleed when the bar
 * auto-hides used to resize the BrowserView every few seconds — JW/Clappr PPV
 * embeds remount on that resize (looks like a stream reload) and often re-request
 * HTML fullscreen, which fought Jiyu's Full toggle.
 */
function pageFullscreenBounds(): BrowserBounds {
  return fullscreenBounds({ fullBleed: false })
}

/** Fit a stream inside the screen so Full doesn't crop a 16:9 picture on a phone. */
function letterboxedFullscreenBounds(aspect: number): BrowserBounds {
  const ratio = aspect > 0.4 && aspect < 3.5 ? aspect : 16 / 9
  const vw = Math.max(1, window.innerWidth)
  const vh = Math.max(1, window.innerHeight)
  const top = topChromeClearance()
  const availH = Math.max(1, vh - top)
  let width = vw
  let height = width / ratio
  if (height > availH) {
    height = availH
    width = height * ratio
  }
  return {
    x: Math.max(0, Math.round((vw - width) / 2)),
    y: Math.max(0, Math.round(top + (availH - height) / 2)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

/** Ask the embed for its real frame size and stop it covering/cropping the picture. */
const GUEST_VIDEO_ASPECT_SCRIPT = `(() => {
  try {
    const seen = new Set();
    const walk = (doc, depth) => {
      if (!doc || depth > 4 || seen.has(doc)) return null;
      seen.add(doc);
      const vids = doc.querySelectorAll('video');
      let found = null;
      for (const v of vids) {
        v.style.setProperty('object-fit', 'contain', 'important');
        v.style.setProperty('object-position', 'center center', 'important');
        if (!found && v.videoWidth > 8 && v.videoHeight > 8) found = v;
      }
      if (found) return found.videoWidth + 'x' + found.videoHeight;
      const frames = doc.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const hit = walk(frame.contentDocument, depth + 1);
          if (hit) return hit;
        } catch (e) {}
      }
      return null;
    };
    return walk(document, 0);
  } catch (e) {
    return null;
  }
})()`

export function WebBrowserProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  /** Electron or Android overlay — UI treats either as a working in-app browser. */
  const desktop = isInAppBrowserAvailable()
  const electron = isDesktopApp()
  const android = isAndroidInAppBrowser()
  const modeRef = useRef<WebBrowserMode>('off')
  const frameRef = useRef<HTMLElement | null>(null)
  const autoplayTimers = useRef<number[]>([])
  /** Cancels a pending detach when React Strict Mode remounts or Expand re-attaches. */
  const detachGeneration = useRef(0)
  /** Intentional close — do not resurrect a blanked session as last-chance PiP. */
  const suppressLastChancePipRef = useRef(false)
  const pipOnLeaveRef = useRef(false)
  /** Latest embed URL for detachFrame last-chance PiP (nav state can lag unmount). */
  const navUrlRef = useRef('')
  const [mode, setMode] = useState<WebBrowserMode>('off')
  const [contentTitle, setContentTitleState] = useState('')
  const setContentTitle = useCallback((title: string) => {
    const next = String(title || '').trim()
    if (isPlaceholderBrowserTitle(next)) return
    setContentTitleState((prev) => (prev === next ? prev : next))
  }, [])
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenRef = useRef(false)
  /** After an explicit Exit, ignore guest Full clicks briefly so embeds can't yank Full back on. */
  const guestFsCooldownUntilRef = useRef(0)
  const embedAspectRef = useRef(16 / 9)
  const [address, setAddress] = useState('https://www.youtube.com/')
  const [status, setStatus] = useState<string | null>(
    desktop ? null : 'In-app browser unavailable on this platform',
  )
  const [nav, setNav] = useState<BrowserNavState>({
    url: '',
    title: 'Web browser',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  })

  modeRef.current = mode
  fullscreenRef.current = fullscreen
  navUrlRef.current = nav.url || address

  const clearAutoplayTimers = useCallback(() => {
    for (const id of autoplayTimers.current) window.clearTimeout(id)
    autoplayTimers.current = []
  }, [])

  const lastNudgeUrlRef = useRef('')
  const lastNudgeAtRef = useRef(0)
  /** Last nudge was the pre-load one: the page-stop nudge must still run. */
  const lastNudgeEarlyRef = useRef(false)
  const cinetaroRewriteRef = useRef('')
  const navUrlForNudgeRef = useRef(nav.url || address)
  navUrlForNudgeRef.current = nav.url || address
  /** Last real player URL — ads can replace nav.url and must not drop PiP. */
  const lastEmbedUrlRef = useRef('')
  /** Generation token for the "Unwrapping stream…" cover loop (bumped to cancel). */
  const unwrapGenRef = useRef(0)
  const unwrapTickRef = useRef<() => void>(() => {})

  const execInGuest = useCallback(
    async (script: string): Promise<unknown> => {
      try {
        if (electron) return await window.signalDesktop?.browserExecute?.(script)
        if (android) return await androidBrowserExecute(script)
      } catch {
        /* ignore */
      }
      return null
    },
    [android, electron],
  )

  const stopUnwrapCover = useCallback(
    (removeFromPage = true) => {
      unwrapGenRef.current += 1
      unwrapTickRef.current = () => {}
      if (removeFromPage) void execInGuest(UNWRAP_COVER_REMOVE_SCRIPT)
    },
    [execInGuest],
  )

  /**
   * Stall watchdog: the guest cover is removed after UNWRAP_COVER_MAX_MS even when no
   * video ever moved (blank embed, dead Gecko content process, offline feed), which used
   * to leave a silent black player. Surface a Retry notice instead and keep a slow
   * check running so a feed that starts later clears it.
   */
  const [stalled, setStalled] = useState(false)
  const stallGenRef = useRef(0)
  const clearStall = useCallback(() => {
    stallGenRef.current += 1
    setStalled((was) => {
      if (was) {
        setStatus((cur) => (cur === STALL_MESSAGE || cur === STREAM_OFFLINE_MESSAGE ? null : cur))
        void execInGuest(UNWRAP_COVER_REMOVE_SCRIPT)
      }
      return false
    })
  }, [execInGuest])
  const beginStallWatch = useCallback(
    (notice = true) => {
      const gen = ++stallGenRef.current
      const startedAt = Date.now()
      let errTicks = 0
      let reloads = 0
      let lastReloadAt = 0
      /** Once the feed has moved frames, mid-stream rebuffers must not reload. */
      let everPlayed = false
      if (notice) {
        setStalled(true)
        setStatus(STALL_MESSAGE)
      }
      const hide = () => {
        setStalled((was) => {
          if (was) setStatus((cur) => (cur === STALL_MESSAGE || cur === STREAM_OFFLINE_MESSAGE ? null : cur))
          return false
        })
      }
      const tick = () => {
        if (gen !== stallGenRef.current) return
        if (modeRef.current !== 'page' || Date.now() - startedAt > STALL_WATCH_MAX_MS) {
          clearStall()
          return
        }
        void execInGuest(LIVE_WATCH_SCRIPT).then((res) => {
          if (gen !== stallGenRef.current) return
          if (execResultSaysLegalBlock(res)) {
            setStalled(true)
            setStatus(LEGAL_BLOCK_MESSAGE)
            void androidBrowserTvPointer('off')
            return
          }
          if (execResultSaysOffline(res)) {
            if (!everPlayed) {
              void execInGuest(STREAM_OFFLINE_COVER_SCRIPT)
              setStalled(true)
              setStatus(STREAM_OFFLINE_MESSAGE)
            }
            window.setTimeout(tick, STALL_WATCH_TICK_MS)
            return
          }
          if (execResultSaysPlaying(res)) {
            everPlayed = true
            errTicks = 0
            hide()
          } else if (execResultSaysMediaError(res)) {
            // Bare .m3u8 on Gecko → MIME dialog; surface Retry. After a real start,
            // network/buffer blips are normal — do not reload (black spinner again).
            errTicks += 1
            if (execResultSaysMimeUnsupported(res)) {
              setStalled(true)
              setStatus(STALL_MESSAGE)
              window.setTimeout(tick, STALL_WATCH_TICK_MS)
              return
            }
            if (everPlayed) {
              errTicks = 0
              window.setTimeout(tick, STALL_WATCH_TICK_MS)
              return
            }
            const pageUrl = navUrlForNudgeRef.current || ''
            const playmogo = isPlaymogoEmbedUrl(pageUrl)
            const maxReloads = playmogo ? 1 : 3
            if (errTicks >= 6 && reloads < maxReloads && Date.now() - lastReloadAt > 45_000) {
              reloads += 1
              lastReloadAt = Date.now()
              errTicks = 0
              if (electron) void window.signalDesktop?.browserReload?.()
              else if (android) void androidBrowserReload()
            } else if (reloads >= maxReloads && errTicks >= 6) {
              setStalled(true)
              setStatus(STALL_MESSAGE)
            }
          }
          window.setTimeout(tick, STALL_WATCH_TICK_MS)
        })
      }
      window.setTimeout(tick, STALL_WATCH_TICK_MS)
    },
    [android, clearStall, electron, execInGuest],
  )

  /** Keep "Unwrapping stream…" up until a <video> is really playing (≈30–50s cap). */
  const startUnwrapCover = useCallback(() => {
    const gen = ++unwrapGenRef.current
    const startedAt = Date.now()
    const budgetMs = unwrapCoverBudgetMs(navUrlForNudgeRef.current || '')
    let busy = false
    let timer = 0
    void execInGuest('try{window.__jiyuSeg403=0}catch(e){}')
    const tick = () => {
      if (gen !== unwrapGenRef.current || busy) return
      if (modeRef.current === 'off') {
        stopUnwrapCover(false)
        return
      }
      // Corner PiP must never keep (or re-paint) the unwrap cover — Back→PiP was
      // leaving "Unwrapping stream…" over a stream that was already playing.
      if (modeRef.current === 'pip') {
        stopUnwrapCover(true)
        return
      }
      // Re-check URL — sports navigate can land after cover start.
      const maxMs = Math.max(budgetMs, unwrapCoverBudgetMs(navUrlForNudgeRef.current || ''))
      if (Date.now() - startedAt > maxMs) {
        stopUnwrapCover(false)
        void execInGuest(STREAM_OFFLINE_COVER_SCRIPT)
        if (modeRef.current === 'page') {
          setStalled(true)
          setStatus(STREAM_OFFLINE_MESSAGE)
          beginStallWatch(false)
        }
        return
      }
      busy = true
      window.clearTimeout(timer)
      void execInGuest(UNWRAP_COVER_TICK_SCRIPT).then((res) => {
        busy = false
        if (gen !== unwrapGenRef.current) return
        if (execResultSaysLegalBlock(res)) {
          stopUnwrapCover(true)
          setStalled(true)
          setStatus(LEGAL_BLOCK_MESSAGE)
          void androidBrowserTvPointer('off')
          return
        }
        if (
          execResultSaysOffline(res) &&
          Date.now() - startedAt >= UNWRAP_COVER_MIN_MS
        ) {
          stopUnwrapCover(false)
          void execInGuest(STREAM_OFFLINE_COVER_SCRIPT)
          setStalled(true)
          setStatus(STREAM_OFFLINE_MESSAGE)
          if (modeRef.current === 'page') beginStallWatch(false)
          return
        }
        // Bare HLS MIME error — drop cover and stall/hop right away (don't burn the
        // full sports unwrap budget staring at Firefox's sad-face dialog).
        if (execResultSaysMimeUnsupported(res) && Date.now() - startedAt >= UNWRAP_COVER_MIN_MS) {
          stopUnwrapCover(true)
          if (modeRef.current === 'page') beginStallWatch(true)
          return
        }
        // Ignore "playing" in the first moments: the previous document can still be
        // alive until navigate commits.
        if (execResultSaysPlaying(res) && Date.now() - startedAt >= UNWRAP_COVER_MIN_MS) {
          stopUnwrapCover(true)
          // Keep a quiet watch so a later network error is retried / reloaded.
          if (modeRef.current === 'page') beginStallWatch(false)
          return
        }
        timer = window.setTimeout(tick, UNWRAP_COVER_TICK_MS)
      })
    }
    // First tick runs after navigate (openUrl) or on the next nav event, never on the old page.
    unwrapTickRef.current = tick
  }, [beginStallWatch, execInGuest, stopUnwrapCover])

  /**
   * StreamFree: keep pressing JW play while its player is idle (see
   * STREAMFREE_EMBED_PLAY_SCRIPT). Runs until the page leaves StreamFree, the browser
   * closes, or 3h pass, so a "starting soon" feed that goes live later still starts.
   */
  const streamFreeLoopRef = useRef<{ url: string; timer: number }>({ url: '', timer: 0 })
  const stopStreamFreeLoop = useCallback(() => {
    window.clearInterval(streamFreeLoopRef.current.timer)
    streamFreeLoopRef.current = { url: '', timer: 0 }
  }, [])
  const startStreamFreeLoop = useCallback(
    (url: string) => {
      if (!isStreamFreeEmbedUrl(url)) return
      if (streamFreeLoopRef.current.url === url && streamFreeLoopRef.current.timer) return
      stopStreamFreeLoop()
      const startedAt = Date.now()
      let busy = false
      let kicked = false
      let restored = false
      const tick = () => {
        if (busy) return
        const page = navUrlForNudgeRef.current || ''
        if (modeRef.current === 'off' || Date.now() - startedAt > 3 * 3600_000 || (page && !isStreamFreeEmbedUrl(page))) {
          stopStreamFreeLoop()
          return
        }
        busy = true
        void execInGuest(STREAMFREE_EMBED_PLAY_SCRIPT).then(async (res) => {
          busy = false
          const text = (() => { try { return JSON.stringify(res) || '' } catch { return '' } })()
          if (text.includes('sf-kick')) kicked = true
          if (text.includes('sf-on') && kicked && !restored && electron) {
            // Main-process sports kick mutes the view and only unmutes inside its ~27s
            // window; a late StreamFree start would stay silent. Re-apply the user level.
            restored = true
            try {
              const pct = Number((await window.signalDesktop?.browserGetVolume?.())?.percent)
              await window.signalDesktop?.browserSetVolume?.(Number.isFinite(pct) ? pct : 100)
            } catch {
              /* ignore */
            }
          }
          if (text.includes('sf-kick')) restored = false
        })
      }
      streamFreeLoopRef.current = { url, timer: window.setInterval(tick, 2000) }
      window.setTimeout(tick, 600)
    },
    [electron, execInGuest, stopStreamFreeLoop],
  )
  useEffect(() => () => stopStreamFreeLoop(), [stopStreamFreeLoop])

  /** Playmogo: strip DoodStream interstitials + network-error banners while soft ads stay. */
  const playmogoLoopRef = useRef<{ url: string; timer: number }>({ url: '', timer: 0 })
  const stopPlaymogoLoop = useCallback(() => {
    window.clearInterval(playmogoLoopRef.current.timer)
    playmogoLoopRef.current = { url: '', timer: 0 }
  }, [])
  const startPlaymogoLoop = useCallback(
    (url: string) => {
      if (!isPlaymogoEmbedUrl(url)) return
      if (playmogoLoopRef.current.url === url && playmogoLoopRef.current.timer) return
      stopPlaymogoLoop()
      const startedAt = Date.now()
      let busy = false
      const tick = () => {
        if (busy) return
        const page = navUrlForNudgeRef.current || ''
        if (
          modeRef.current === 'off' ||
          Date.now() - startedAt > 30 * 60_000 ||
          (page && !isPlaymogoEmbedUrl(page))
        ) {
          stopPlaymogoLoop()
          return
        }
        busy = true
        void execInGuest(PLAYMOGO_CLEANUP_SCRIPT).then(() => {
          busy = false
        })
      }
      playmogoLoopRef.current = { url, timer: window.setInterval(tick, 700) }
      window.setTimeout(tick, 200)
      window.setTimeout(tick, 600)
    },
    [execInGuest, stopPlaymogoLoop],
  )
  useEffect(() => () => stopPlaymogoLoop(), [stopPlaymogoLoop])

  /** YouTube live: auto-dismiss the "Noticed some buffering" feedback survey. */
  const youtubeFbLoopRef = useRef<{ url: string; timer: number }>({ url: '', timer: 0 })
  const stopYouTubeFbLoop = useCallback(() => {
    window.clearInterval(youtubeFbLoopRef.current.timer)
    youtubeFbLoopRef.current = { url: '', timer: 0 }
  }, [])
  const startYouTubeFbLoop = useCallback(
    (url: string) => {
      if (!isYouTubeUrl(url)) return
      if (youtubeFbLoopRef.current.url === url && youtubeFbLoopRef.current.timer) return
      stopYouTubeFbLoop()
      const startedAt = Date.now()
      let busy = false
      const tick = () => {
        if (busy) return
        const page = navUrlForNudgeRef.current || ''
        if (
          modeRef.current === 'off' ||
          Date.now() - startedAt > 6 * 3600_000 ||
          (page && !isYouTubeUrl(page))
        ) {
          stopYouTubeFbLoop()
          return
        }
        busy = true
        void execInGuest(YOUTUBE_BUFFER_FEEDBACK_SCRIPT).then(() => {
          busy = false
        })
      }
      youtubeFbLoopRef.current = { url, timer: window.setInterval(tick, 2500) }
      window.setTimeout(tick, 800)
    },
    [execInGuest, stopYouTubeFbLoop],
  )
  useEffect(() => () => stopYouTubeFbLoop(), [stopYouTubeFbLoop])

  const nudgePlayback = useCallback((urlOverride?: string, opts?: { early?: boolean }) => {
    if (!desktop) return
    const runScript = (script: string) => {
      if (electron) void window.signalDesktop?.browserExecute?.(script)
      else if (android) void androidBrowserExecute(script)
    }
    const url = (urlOverride || navUrlForNudgeRef.current || '').trim()
    if (isCinetaroCatalogPageUrl(url) || isCloudflareChallengeTarget(url, nav.title)) return
    // StreamFree mounts JW idle outside its own site: own play loop (idempotent per URL).
    startStreamFreeLoop(url)
    // Playmogo: keep clearing DoodStream interstitials / network-error banners.
    startPlaymogoLoop(url)
    // YouTube live: dismiss the rebuffer "Send feedback" survey.
    startYouTubeFbLoop(url)
    const now = Date.now()
    // Always re-hide Rive server chrome — autoplay throttle must not skip this.
    if (/rivestream\.(ru|app)/i.test(url) || /vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(url)) {
      if (/rivestream\.(ru|app)/i.test(url)) {
        runScript(RIVESTREAM_PREFER_DIRECT_SCRIPT)
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
        runScript(RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT)
      }
      // Auto-pick Direct then rotate Embed hosts (Electron main also installs this).
      runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
    }
    // Sports pages fire did-stop-loading constantly for ads — don't re-arm a
    // 12s execute storm on every subframe finish. Android: shorter gate so a
    // failed early kick can retry when the player finally mounts.
    const gateMs = android ? 2500 : 8000
    // The pre-load nudge (opts.early) must not swallow the page-stop nudge: kicks that
    // ran before the player existed are exactly the ones that need a re-run.
    const afterEarly = lastNudgeEarlyRef.current && !opts?.early
    if (
      url &&
      url === lastNudgeUrlRef.current &&
      now - lastNudgeAtRef.current < gateMs &&
      !afterEarly
    ) {
      return
    }
    lastNudgeUrlRef.current = url
    lastNudgeAtRef.current = now
    lastNudgeEarlyRef.current = Boolean(opts?.early)
    clearAutoplayTimers()
    // Live sports + Replay VODs:
    // Electron: main-process owns muted→play + one center click.
    // Android: mirror that here (no main process).
    const isSportsOrReplay = isSportsOrReplayEmbedUrl(url)
    const runCore = () => {
      runScript(BLOCK_GUEST_FULLSCREEN_SCRIPT)
      if (!isSportsOrReplay || android) {
        runScript(AUTOPLAY_WITH_SOUND_SCRIPT)
      }
    }
    const runAds = () => {
      runScript(EMBED_STRIP_SANDBOX_SCRIPT)
      runScript(EMBED_AD_HIDE_SCRIPT)
      if (isPlaymogoEmbedUrl(url)) runScript(PLAYMOGO_CLEANUP_SCRIPT)
      if (isYouTubeUrl(url)) runScript(YOUTUBE_BUFFER_FEEDBACK_SCRIPT)
      // Desktop hides site "CLICK UNMUTE" in favor of Jiyu chrome. On Android the
      // overlay Gecko view used to bury that chrome — keep the site CTA as backup.
      if (!android) runScript(EMBED_UNMUTE_OVERLAY_SCRIPT)
      if (/rivestream\.(ru|app)/i.test(url)) {
        runScript(RIVESTREAM_PREFER_DIRECT_SCRIPT)
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
        runScript(RIVESTREAM_PREFER_ENGLISH_AUDIO_SCRIPT)
        runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
      } else if (/vaplayer\.ru|vidup\.to|videasy\.to|cinezo\.live|vidzee\.wtf|mapple\.fun|primesrc\.me|streamingnow\.mov/i.test(url)) {
        runScript(RIVESTREAM_EMBED_AUTO_SCRIPT)
      } else {
        runScript(RIVESTREAM_HIDE_SERVER_CHROME_SCRIPT)
      }
    }
    const runClick = () => {
      if (isSportsOrReplay && electron) return
      // ifPaused: never click a stream that already started (the click pauses it).
      if (electron) void window.signalDesktop?.browserClickCenter?.({ ifPaused: true })
      else if (android) void androidBrowserTapPlay()
    }
    const sportsKick = (aggressive = false) => {
      if (!android || !isSportsOrReplay) return
      void (async () => {
        await androidBrowserExecute(EMBED_STRIP_SANDBOX_SCRIPT)
        await androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
        const check = await androidBrowserExecute(`(() => {
          try {
            const v = Array.from(document.querySelectorAll('video')).find(
              (m) => !m.paused && !m.ended
            );
            return v ? 'playing' : 'idle';
          } catch (_) { return 'idle'; }
        })();`)
        if (check?.result === 'playing') return
        // Paused after a prior start (ads / stall) — play() only; no toggle click.
        await androidBrowserExecute(`(() => {
          try {
            const videos = Array.from(document.querySelectorAll('video'));
            for (const video of videos) {
              if (!video || video.ended || !video.paused) continue;
              video.muted = true;
              const p = video.play();
              if (p && typeof p.then === 'function') {
                p.then(() => { try { video.muted = false; } catch (_) {} }).catch(() => {});
              }
            }
            return 'resume';
          } catch (_) { return 'error'; }
        })();`)
        const again = await androidBrowserExecute(`(() => {
          try {
            const v = Array.from(document.querySelectorAll('video')).find(
              (m) => !m.paused && !m.ended
            );
            return v ? 'playing' : 'idle';
          } catch (_) { return 'idle'; }
        })();`)
        if (again?.result === 'playing') return
        // play() from the page is not a user gesture, so the play glyph stays up.
        // tapPlay sends the two taps these embeds need, and skips a live stream.
        if (aggressive) await androidBrowserTapPlay()
      })()
    }
    // Strip sandbox before any play kick — hosts block sandboxed iframes.
    runScript(EMBED_STRIP_SANDBOX_SCRIPT)
    runCore()
    if (!isSportsOrReplay) runClick()
    runAds()
    if (isSportsOrReplay) {
      if (android) {
        // Match Electron sports poll window — slow Clappr/JW mounts miss early kicks.
        sportsKick(false)
        for (const [ms, aggressive] of [
          [500, false],
          [1100, false],
          [1800, false],
          [2600, true],
          [4200, true],
          [7000, false],
          // Slow embeds: keep trying until the 30s unwrap cap. Each kick checks
          // for a playing video first and is a no-op once the stream runs.
          [10000, false],
          [13500, true],
          [17000, false],
          [21000, true],
          [25000, false],
        ] as const) {
          autoplayTimers.current.push(window.setTimeout(() => sportsKick(aggressive), ms))
        }
        // Native tap waits for page stop itself, then watches (400ms) until the paused
        // play control is on screen and taps it once. No fixed 3s wait.
        // Native keeps one watch per page (repeat calls join it) and taps only while
        // every frame reports paused, so the backstops cannot toggle a live stream.
        for (const ms of [600, 3000, 8000]) {
          autoplayTimers.current.push(
            window.setTimeout(() => {
              void androidBrowserTapPlay()
            }, ms),
          )
        }
      }
      autoplayTimers.current.push(window.setTimeout(runAds, 400))
      autoplayTimers.current.push(window.setTimeout(runAds, 800))
      autoplayTimers.current.push(window.setTimeout(runAds, 2800))
      return
    }
    autoplayTimers.current.push(window.setTimeout(runCore, 600))
    autoplayTimers.current.push(window.setTimeout(runClick, 900))
    autoplayTimers.current.push(window.setTimeout(runAds, 800))
    autoplayTimers.current.push(window.setTimeout(runCore, 1600))
    autoplayTimers.current.push(window.setTimeout(runClick, 2000))
    autoplayTimers.current.push(window.setTimeout(runAds, 2800))
    autoplayTimers.current.push(window.setTimeout(runClick, 4000))
    autoplayTimers.current.push(window.setTimeout(runCore, 5500))
    autoplayTimers.current.push(window.setTimeout(runAds, 7000))
  }, [android, clearAutoplayTimers, desktop, electron, startPlaymogoLoop, startStreamFreeLoop, startYouTubeFbLoop])

  /**
   * Resize into the corner pauses Gecko. Call play() on a paused video.
   * Do not center-tap: that toggles a stream that is already running.
   */
  const resumePipPlayback = useCallback(() => {
    if (!android || !desktop) return
    const page = navUrlForNudgeRef.current || ''
    if (isCinetaroCatalogPageUrl(page) || isCloudflareChallengeTarget(page, nav.title)) return
    window.setTimeout(() => {
      void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
    }, 400)
    window.setTimeout(() => {
      void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
    }, 1400)
  }, [android, desktop, nav.title])

  /** Soft-resume after PiP→page / resize — video.play() only; avoid toggle-clicks. */
  const softResumePlayback = useCallback(() => {
    if (!android || !desktop) return
    const page = navUrlForNudgeRef.current || ''
    if (isCinetaroCatalogPageUrl(page) || isCloudflareChallengeTarget(page, nav.title)) return
    void (async () => {
      const play = await androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
      const playResult = String(play?.result ?? '')
      const check = await androidBrowserExecute(`(() => {
        try {
          const v = Array.from(document.querySelectorAll('video')).find(
            (m) => !m.paused && !m.ended && m.readyState > 1
          );
          return v ? 'playing' : 'idle';
        } catch (_) { return 'idle'; }
      })();`)
      if (check?.result === 'playing') return
      if (
        playResult.includes('play-with-sound') ||
        playResult.includes('play-kept-muted') ||
        playResult.includes('already')
      ) {
        window.setTimeout(() => {
          void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
        }, 350)
        return
      }
      await androidBrowserTapPlay()
      window.setTimeout(() => {
        void androidBrowserExecute(AUTOPLAY_WITH_SOUND_SCRIPT)
      }, 350)
    })()
  }, [android, desktop, nav.title])

  const showAt = useCallback(
    async (bounds: BrowserBounds) => {
      if (!desktop) return
      // Never apply a collapsed rect — that leaves a black stage with an
      // off-screen sports / YouTube surface (Nationwide + football).
      const next = isUsableOverlayBounds(bounds)
        ? bounds
        : fullscreenBounds({ fullBleed: false })
      if (electron) await window.signalDesktop?.browserShow?.(next)
      else if (android) await androidBrowserShow(next)
    },
    [android, desktop, electron],
  )

  const syncPageBounds = useCallback(async () => {
    if (!desktop || modeRef.current !== 'page' || fullscreen) return
    const frame = frameRef.current
    if (!frame) return
    const bounds = pageOverlayBounds(frame)
    if (electron) await window.signalDesktop?.browserSetBounds?.(bounds)
    else if (android) await androidBrowserSetBounds(bounds)
  }, [android, desktop, electron, fullscreen])

  const hostNavigate = useCallback(
    async (url: string) => {
      if (electron) return window.signalDesktop?.browserNavigate?.(url)
      if (android) return androidBrowserNavigate(url)
      return { ok: false, error: 'No in-app browser' }
    },
    [android, electron],
  )

  const hostHide = useCallback(
    async (options?: { blank?: boolean; pause?: boolean }) => {
      // Always pass an explicit pause flag — Android used to default pause:true
      // and that killed PPV PiP when detachFrame called bare hide().
      const opts = {
        blank: Boolean(options?.blank),
        pause: Boolean(options?.pause),
      }
      if (electron) await window.signalDesktop?.browserHide?.(opts)
      else if (android) await androidBrowserHide(opts)
    },
    [android, electron],
  )

  const placeWebFullscreen = useCallback(async () => {
    if (android) {
      try {
        const probed = await androidBrowserExecute(GUEST_VIDEO_ASPECT_SCRIPT)
        const raw = String(probed.result ?? '')
        const match = raw.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/)
        if (match) {
          const w = Number(match[1])
          const h = Number(match[2])
          if (w > 8 && h > 8) embedAspectRef.current = w / h
        }
      } catch {
        /* keep the last known aspect */
      }
      await showAt(letterboxedFullscreenBounds(embedAspectRef.current))
      return
    }
    if (modeRef.current === 'pip') {
      await showAt(pipFullscreenBounds())
      return
    }
    await showAt(pageFullscreenBounds())
  }, [android, showAt])

  const attachFrame = useCallback(
    (frame: HTMLElement) => {
      // Cancel any pending hide from a Strict Mode / effect cleanup.
      detachGeneration.current += 1
      frameRef.current = frame
      setMode('page')
      modeRef.current = 'page'
      // Remount/Strict Mode must not yank fullscreen mid-watch (pauses embeds).
      frame.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const place = () => {
        if (fullscreenRef.current) {
          if (android) {
            void showAt(letterboxedFullscreenBounds(embedAspectRef.current))
          } else {
            void showAt(modeRef.current === 'pip' ? pipFullscreenBounds() : pageFullscreenBounds())
          }
          return
        }
        void showAt(pageOverlayBounds(frame))
      }
      place()
      requestAnimationFrame(() => {
        place()
        requestAnimationFrame(place)
      })
      // Expanding from PiP / remount: Gecko often pauses on resize. Soft resume
      // uses video.play() first; only taps if still idle (avoids pause-toggle).
      if (android) {
        window.setTimeout(() => softResumePlayback(), 400)
        window.setTimeout(() => softResumePlayback(), 1400)
      }
    },
    [android, showAt, softResumePlayback],
  )

  const detachFrame = useCallback(() => {
    frameRef.current = null
    if (modeRef.current === 'pip') return
    const token = ++detachGeneration.current
    // Defer hide so Expand / Strict Mode remount / leave→PiP can win first.
    window.setTimeout(() => {
      if (token !== detachGeneration.current) return
      if (modeRef.current === 'pip') return
      if (frameRef.current) return
      // Intentional close (Android Back used to blank then resurrect a black PiP).
      if (suppressLastChancePipRef.current || modeRef.current === 'off') {
        setMode('off')
        modeRef.current = 'off'
        setFullscreen(false)
        void hostHide({ pause: true })
        return
      }
      // Last-chance PiP: /web unmounted before openInPip / NavigationPiPBridge ran.
      const current = navUrlRef.current
      const embed =
        current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
      if (embed && isEmbedPlayerHost(embed) && !isBlankBrowserUrl(embed)) {
        detachGeneration.current += 1
        setFullscreen(false)
        setMode('pip')
        modeRef.current = 'pip'
        void exitOsFullscreen({ force: true })
        void window.signalDesktop?.browserAdDockClose?.()
        if (!current || !isEmbedPlayerHost(current)) {
          void hostNavigate(embed)
        }
        void showAt(pipStageBounds())
        if (android) {
          softResumePlayback()
          window.setTimeout(() => softResumePlayback(), 700)
        } else {
          resumePipPlayback()
        }
        return
      }
      setMode('off')
      modeRef.current = 'off'
      setFullscreen(false)
      // Pause + hide only — do not blank (keeps the YouTube session alive).
      void hostHide({ pause: true })
    }, 32)
  }, [android, hostHide, hostNavigate, resumePipPlayback, softResumePlayback, showAt])

  const openUrl = useCallback(
    async (raw: string, options?: { unwrapCover?: boolean }) => {
      const target = toAutoplayUrl(cinetaroPlaybackUrl(raw))
      if (isEmbedPlayerHost(target)) lastEmbedUrlRef.current = target
      if (!desktop) {
        setAddress(target)
        setNav((current) => ({ ...current, url: target, loading: true }))
        setStatus('In-app browser unavailable on this platform')
        return
      }
      clearStall()
      // Allow a fresh autoplay cycle when retrying the same embed after PiP/hide.
      lastNudgeUrlRef.current = ''
      lastNudgeAtRef.current = 0
      lastNudgeEarlyRef.current = false
      // Always promote to full page — leftover PiP mode would open sports in the corner.
      setMode('page')
      modeRef.current = 'page'
      setFullscreen(false)
      // Cancel a pending detachFrame hide from Strict Mode / prior /web unmount
      // so it cannot blank the surface after we navigate.
      detachGeneration.current += 1
      suppressLastChancePipRef.current = false
      // Multi-view just handed this live tile to the single view: no cover, no kicks.
      const promoted = takePromotedEmbed(target)
      // Explicit false after Media3 sniff / hop — never paint "Unwrapping" twice for one play.
      const unwrap =
        options?.unwrapCover !== false && !promoted && wantsUnwrapCover(target)
      // The cover lives in the guest page (web-status is a red inline error row).
      if (unwrap) {
        startUnwrapCover()
      } else {
        stopUnwrapCover(false)
        if (!promoted && wantsUnwrapCover(target)) beginStallWatch(false)
      }
      await showAt(pageOverlayBounds(frameRef.current))
      const result = await hostNavigate(target)
      // After Media3 unwrap, frame may mount a tick later — re-apply bounds so
      // Gecko is not left at the probe's 2×2 parking size.
      const placeAgain = () => {
        if (modeRef.current === 'page') {
          void showAt(pageOverlayBounds(frameRef.current))
        }
      }
      placeAgain()
      requestAnimationFrame(() => {
        placeAgain()
        requestAnimationFrame(placeAgain)
      })
      window.setTimeout(placeAgain, 120)
      window.setTimeout(placeAgain, 400)
      if (result && !result.ok) {
        stopUnwrapCover(true)
        setStatus(result.error || 'Failed to open')
        setNav((current) => ({ ...current, loading: false, title: 'Failed' }))
        return
      }
      // Prefer the live guest URL when main kept a Rive direct-player hop.
      const live = String(result?.url || target)
      setAddress(live)
      if (promoted && result && 'kept' in result && result.kept) {
        // Already playing (continued from Multi-view) - clicking it again would pause LIVE.
        lastNudgeUrlRef.current = live
        lastNudgeAtRef.current = Date.now()
        setNav((current) => ({ ...current, url: live, loading: false, external: false }))
        setStatus(null)
        return
      }
      setNav((current) => ({
        ...current,
        url: live,
        loading: true,
        external: false,
      }))
      setStatus(null)
      unwrapTickRef.current()
      // Embeds: wait for did-stop-loading (onBrowserNav + main-process sports kick).
      // Immediate center-clicks often land before <video> exists, then later clicks pause LIVE.
      if (!isEmbedPlayerHost(live)) {
        // Early (pre-load) kick; the page-stop event re-kicks once (see onNav).
        nudgePlayback(live, { early: true })
      } else if (android) {
        // Ad-heavy sports pages can take many seconds to report page stop. Start the
        // (play-state-checked) kicks early; the stop-event nudge still runs after the gate.
        window.setTimeout(() => {
          if (modeRef.current === 'page') nudgePlayback(live, { early: true })
        }, 1200)
      }
    },
    [android, beginStallWatch, clearStall, desktop, hostNavigate, nudgePlayback, showAt, startUnwrapCover, stopUnwrapCover],
  )

  const openInPip = useCallback(
    (url?: string, title?: string, options?: { navigateTo?: string }) => {
      if (!desktop) return
      suppressLastChancePipRef.current = false
      const current = nav.url || address
      // Live guest first — never replace a playing sports mirror with the seed URL.
      const preferred =
        (current && isEmbedPlayerHost(current) ? current : '') ||
        (url && isEmbedPlayerHost(url) ? url : '') ||
        (lastEmbedUrlRef.current && isEmbedPlayerHost(lastEmbedUrlRef.current)
          ? lastEmbedUrlRef.current
          : '') ||
        ''
      const target = toAutoplayUrl(preferred || '')
      // Never PiP a blank/black placeholder — that leaves a black box over Sports/Home.
      if (!target || isBlankBrowserUrl(target) || !isEmbedPlayerHost(target)) {
        void hostHide({ blank: true, pause: true })
        setMode('off')
        modeRef.current = 'off'
        if (options?.navigateTo) navigate(options.navigateTo)
        return
      }
      lastEmbedUrlRef.current = target
      // Cancel any pending detachFrame → browserHide (pause/mute) from /web unmount.
      detachGeneration.current += 1
      // Drop the unwrap cover before resize — PiP must not re-show Unwrapping.
      stopUnwrapCover(true)
      clearStall()
      setFullscreen(false)
      setMode('pip')
      modeRef.current = 'pip'
      frameRef.current = null
      setAddress(target)
      navUrlRef.current = target
      if (title && !isPlaceholderBrowserTitle(title)) setContentTitleState(title.trim())
      setNav((currentNav) => ({
        ...currentNav,
        url: target,
        title: title || currentNav.title || 'Now playing',
      }))
      setStatus(null)
      // Exit OS fullscreen before sizing PiP — otherwise PiP inherits full-screen bounds.
      void exitOsFullscreen({ force: true })
      setFullscreen(false)
      // Ad dock is a native view over the HTML PiP bar — close it first.
      void window.signalDesktop?.browserAdDockClose?.()
      const placePip = () => {
        void showAt(pipStageBounds())
      }
      placePip()
      // Beat any competing showAt from a prior fullscreen exit.
      requestAnimationFrame(() => {
        placePip()
        requestAnimationFrame(placePip)
      })
      if (android) {
        softResumePlayback()
        window.setTimeout(() => softResumePlayback(), 700)
        window.setTimeout(() => softResumePlayback(), 1600)
      } else {
        resumePipPlayback()
      }
      // Already have a live embed document — resize only. Reloading sports restarts
      // unwrap / mid-roll ads. Only navigate when the guest is blank or non-embed.
      const liveEmbed = Boolean(current && isEmbedPlayerHost(current) && !isBlankBrowserUrl(current))
      if (!liveEmbed) {
        void hostNavigate(target)
        if (!isEmbedPlayerHost(target)) nudgePlayback(target)
      }
      navigate(options?.navigateTo || '/')
    },
    [
      address,
      android,
      clearStall,
      desktop,
      hostHide,
      hostNavigate,
      nav.url,
      navigate,
      nudgePlayback,
      resumePipPlayback,
      softResumePlayback,
      showAt,
      stopUnwrapCover,
    ],
  )

  const setPipOnLeave = useCallback((enabled: boolean) => {
    pipOnLeaveRef.current = enabled
  }, [])

  const minimizeActiveEmbedToPip = useCallback(() => {
    if (modeRef.current === 'pip') return true
    if (modeRef.current !== 'page') return false

    if (android) {
      suppressLastChancePipRef.current = false
      detachGeneration.current += 1
      stopUnwrapCover(true)
      clearStall()
      const current = nav.url || address
      const embed =
        current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
      if (embed && isEmbedPlayerHost(embed)) {
        lastEmbedUrlRef.current = embed
        setFullscreen(false)
        setMode('pip')
        modeRef.current = 'pip'
        frameRef.current = null
        setAddress(embed)
        navUrlRef.current = embed
        setNav((currentNav) => ({
          ...currentNav,
          url: embed,
          title: currentNav.title || 'Now playing',
        }))
        setStatus(null)
        // Keep the stream visible in the corner — don't hide/pause (resume needs a double-tap).
        // Never reload a live embed; that restarts unwrap on sports.
        if (!current || !isEmbedPlayerHost(current) || isBlankBrowserUrl(current)) {
          void hostNavigate(embed)
        }
        const placePip = () => {
          void showAt(pipStageBounds())
        }
        placePip()
        requestAnimationFrame(() => {
          placePip()
          requestAnimationFrame(placePip)
        })
        // Soft resume (play + tap if still idle) — PPV JW/Clappr often pauses on
        // the corner resize and top-frame play() cannot reach the player iframe.
        softResumePlayback()
        window.setTimeout(() => softResumePlayback(), 700)
        window.setTimeout(() => softResumePlayback(), 1600)
        return true
      }
      return false
    }

    if (!desktop) return false
    const current = nav.url || address
    const embed =
      current && isEmbedPlayerHost(current) ? current : lastEmbedUrlRef.current
    if (!embed || !isEmbedPlayerHost(embed)) return false
    lastEmbedUrlRef.current = embed

    // Cancel pending detachFrame → browserHide from the unmounting /web page.
    detachGeneration.current += 1
    stopUnwrapCover(true)
    clearStall()
    setFullscreen(false)
    setMode('pip')
    modeRef.current = 'pip'
    frameRef.current = null
    setStatus(null)
    void exitOsFullscreen({ force: true })
    void window.signalDesktop?.browserAdDockClose?.()
    // Guest left the player (ad hop). Put the embed back, then size PiP.
    // Never reload while the live guest is already an embed.
    if (!current || !isEmbedPlayerHost(current) || isBlankBrowserUrl(current)) {
      void hostNavigate(embed)
    }
    // Resize only — never click/nudge an already-playing sports embed into PiP.
    const placePip = () => {
      void showAt(pipStageBounds())
    }
    placePip()
    requestAnimationFrame(() => {
      placePip()
      requestAnimationFrame(placePip)
    })
    return true
  }, [
    address,
    android,
    clearStall,
    desktop,
    hostNavigate,
    nav.url,
    softResumePlayback,
    showAt,
    stopUnwrapCover,
  ])

  const expandFromPip = useCallback(() => {
    setFullscreen(false)
    setMode('page')
    modeRef.current = 'page'
    suppressLastChancePipRef.current = false
    const current = (nav.url || address || '').trim()
    const url = (
      (current && isEmbedPlayerHost(current) ? current : '') ||
      lastEmbedUrlRef.current ||
      current
    ).trim()
    if (url && isEmbedPlayerHost(url)) {
      lastEmbedUrlRef.current = url
      // Same live document — expand without reloading (no re-unwrap).
      if (!current || !isEmbedPlayerHost(current) || isBlankBrowserUrl(current)) {
        void hostNavigate(url)
      }
      navigate(`/web?url=${encodeURIComponent(url)}`, {
        state: {
          playerMode: 'embed',
          pipOnBack: true,
          from: '/section/sports',
        },
      })
      return
    }
    navigate(url ? `/web?url=${encodeURIComponent(url)}` : '/web')
  }, [address, hostNavigate, nav.url, navigate])

  const closeBrowser = useCallback(() => {
    clearAutoplayTimers()
    stopUnwrapCover(false)
    suppressLastChancePipRef.current = true
    detachGeneration.current += 1
    frameRef.current = null
    setMode('off')
    modeRef.current = 'off'
    setFullscreen(false)
    setStatus(null)
    setContentTitleState('')
    void hostHide({ blank: true, pause: true })
    // Drop web Full only — leave a native stream's claim intact.
    if (getFullscreenOwner() === 'web') {
      void exitOsFullscreen({ force: true })
    }
  }, [clearAutoplayTimers, hostHide, stopUnwrapCover])

  // WatchPage / new stream: park leftover PiP/audio so the next embed opens full-frame.
  // Do NOT blank the session here — blanking raced navigate() and left Nationwide /
  // football on a permanent black Gecko/Electron stage.
  useEffect(() => {
    const onClear = () => {
      clearAutoplayTimers()
      stopUnwrapCover(false)
      detachGeneration.current += 1
      frameRef.current = null
      pipOnLeaveRef.current = false
      suppressLastChancePipRef.current = false
      setMode('off')
      modeRef.current = 'off'
      setFullscreen(false)
      setStatus(null)
      void hostHide({ blank: false, pause: true })
      if (getFullscreenOwner() === 'web') {
        void exitOsFullscreen({ force: true })
      }
    }
    window.addEventListener('jiyu:clear-web-surfaces', onClear)
    return () => window.removeEventListener('jiyu:clear-web-surfaces', onClear)
  }, [clearAutoplayTimers, hostHide, stopUnwrapCover])

  const parkForMultiview = useCallback(() => {
    clearAutoplayTimers()
    stopUnwrapCover(false)
    detachGeneration.current += 1
    frameRef.current = null
    pipOnLeaveRef.current = false
    setMode('off')
    modeRef.current = 'off'
    setFullscreen(false)
    // Blank + pause kills Gecko media — otherwise the first stream keeps playing under tiles.
    void hostHide({ blank: true, pause: true })
    void exitOsFullscreen({ onlyIfOwner: 'web', force: false })
    void exitOsFullscreen({ onlyIfOwner: 'native', force: false })
  }, [clearAutoplayTimers, hostHide, stopUnwrapCover])

  const exitFullscreen = useCallback(() => {
    if (!desktop) return
    guestFsCooldownUntilRef.current = Date.now() + 2500
    setFullscreen(false)
    void exitOsFullscreen({ force: true })
    if (modeRef.current === 'pip') void showAt(pipStageBounds())
    else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
    else if (modeRef.current === 'page') void showAt(pageFullscreenBounds())
  }, [desktop, showAt])

  const enterWebFullscreen = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    if (fullscreenRef.current) {
      void placeWebFullscreen()
      return
    }
    setFullscreen(true)
    void enterOsFullscreen('web')
    void placeWebFullscreen()
  }, [desktop, placeWebFullscreen])

  const toggleFullscreen = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    if (fullscreenRef.current) {
      exitFullscreen()
      return
    }
    enterWebFullscreen()
  }, [desktop, enterWebFullscreen, exitFullscreen])

  const syncBrowserView = useCallback(() => {
    if (!desktop || modeRef.current === 'off') return
    if (fullscreen) {
      if (android) {
        void showAt(letterboxedFullscreenBounds(embedAspectRef.current))
        return
      }
      if (modeRef.current === 'pip') {
        void showAt(pipFullscreenBounds())
        return
      }
      void showAt(pageFullscreenBounds())
      return
    }
    if (modeRef.current === 'pip') {
      void showAt(pipStageBounds())
      // Sports/Home remounts often leave Gecko paused or GONE under the HTML
      // Mute/Full/Expand chrome — re-show then soft-resume the player iframe.
      if (android) {
        window.setTimeout(() => softResumePlayback(), 120)
        window.setTimeout(() => softResumePlayback(), 600)
      }
      return
    }
    if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
  }, [android, desktop, fullscreen, showAt, softResumePlayback])

  const enterWebFullscreenRef = useRef(enterWebFullscreen)
  enterWebFullscreenRef.current = enterWebFullscreen

  // Desktop: mouse / keys over the native view never reach the HTML top bar, and the
  // embed's own Full button is blocked. Poll counters kept inside the guest frames:
  // input reveals the bar; a fullscreen request enters Jiyu's Full (never toggles off).
  useEffect(() => {
    if (!electron || mode !== 'page') return
    let stopped = false
    let busy = false
    let seeded = false
    let prev = new Map<string, { act: number; fs: number }>()
    const tick = async () => {
      if (stopped || busy) return
      busy = true
      try {
        const res = (await execInGuest(GUEST_ACTIVITY_SCRIPT)) as {
          frameResults?: Array<{ ok?: boolean; url?: string; result?: unknown }>
        } | null
        if (stopped || !res || !Array.isArray(res.frameResults)) return
        const next = new Map<string, { act: number; fs: number }>()
        let activity = false
        let fsRequest = false
        for (const entry of res.frameResults) {
          const m = entry?.ok ? String(entry.result ?? '').match(/^jiyu-act:(\d+):(\d+)$/) : null
          if (!m) continue
          let key = String(entry.url || '')
          while (next.has(key)) key += '#'
          const cur = { act: Number(m[1]), fs: Number(m[2]) }
          next.set(key, cur)
          const before = prev.get(key)
          if (!seeded || !before) continue
          if (cur.act > before.act) activity = true
          if (cur.fs > before.fs) fsRequest = true
        }
        // A frame that timed out this round keeps its last counts (no false trigger later).
        for (const [key, value] of prev) if (!next.has(key)) next.set(key, value)
        prev = next
        seeded = true
        if (activity) window.dispatchEvent(new Event(WEB_GUEST_ACTIVITY_EVENT))
        // Guest Full → enter only. Toggle used to flip out of OS Full when JW
        // re-requested HTML fullscreen after a BrowserView resize.
        if (
          fsRequest &&
          modeRef.current === 'page' &&
          !fullscreenRef.current &&
          Date.now() >= guestFsCooldownUntilRef.current
        ) {
          enterWebFullscreenRef.current()
        }
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), fullscreen ? 450 : 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [electron, mode, fullscreen, execInGuest])

  // Immersive Full toggles sidebar/safe-area after the first showAt — re-fit so
  // Gecko stays under the compact control strip instead of covering it.
  useEffect(() => {
    if (!android || !desktop || mode === 'off') return
    const timers = [50, 160, 400].map((ms) =>
      window.setTimeout(() => {
        if (modeRef.current === 'off') return
        if (fullscreenRef.current) {
          void showAt(letterboxedFullscreenBounds(embedAspectRef.current))
        } else if (modeRef.current === 'pip') {
          void showAt(pipStageBounds())
        } else if (frameRef.current) {
          void showAt(boundsFromElement(frameRef.current))
        }
      }, ms),
    )
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [android, desktop, mode, fullscreen, showAt])

  useEffect(() => {
    if (!desktop) return
    if (electron && window.signalDesktop?.onBrowserNav) {
      return window.signalDesktop.onBrowserNav((next) => {
        if (modeRef.current === 'off') return
        setNav(next)
        if (next.url) {
          setAddress(next.url)
          if (isEmbedPlayerHost(next.url)) lastEmbedUrlRef.current = next.url
        }
        unwrapTickRef.current()
        if (!next.loading) {
          setStatus(null)
          const playbackUrl = cinetaroPlaybackUrl(next.url || '')
          if (
            playbackUrl &&
            playbackUrl !== next.url &&
            cinetaroRewriteRef.current !== playbackUrl
          ) {
            cinetaroRewriteRef.current = playbackUrl
            void hostNavigate(playbackUrl)
            return
          }
          if (
            isCinetaroCatalogPageUrl(next.url) ||
            isCloudflareChallengeTarget(next.url, next.title)
          ) {
            return
          }
          if (next.url && isEmbedPlayerHost(next.url)) {
            if (modeRef.current === 'page') nudgePlayback(next.url)
            return
          }
          // Stream page opened via openUrl (e.g. YouTube live): its kicks ran before the
          // page finished loading. Re-kick once now (play-state-checked, no toggling).
          if (
            modeRef.current === 'page' &&
            lastNudgeEarlyRef.current &&
            next.url &&
            next.url === lastNudgeUrlRef.current
          ) {
            nudgePlayback(next.url)
            return
          }
          if (modeRef.current === 'pip') nudgePlayback(next.url)
        }
      })
    }
    if (android) {
      return androidBrowserOnNav((next) => {
        if (modeRef.current === 'off') return
        setNav(next)
        if (next.url) {
          setAddress(next.url)
          if (isEmbedPlayerHost(next.url) && !isCloudflareChallengeTarget(next.url, next.title)) {
            lastEmbedUrlRef.current = next.url
          }
        }
        unwrapTickRef.current()
        if (!next.loading) {
          setStatus(null)
          const playbackUrl = cinetaroPlaybackUrl(next.url || '')
          if (
            playbackUrl &&
            playbackUrl !== next.url &&
            cinetaroRewriteRef.current !== playbackUrl
          ) {
            cinetaroRewriteRef.current = playbackUrl
            void hostNavigate(playbackUrl)
            return
          }
          if (
            isCinetaroCatalogPageUrl(next.url) ||
            isCloudflareChallengeTarget(next.url, next.title)
          ) {
            return
          }
          if (next.url && isEmbedPlayerHost(next.url)) {
            if (modeRef.current === 'page') nudgePlayback(next.url)
            return
          }
          // Stream page opened via openUrl (e.g. YouTube live): its kicks ran before the
          // page finished loading. Re-kick once now (play-state-checked, no toggling).
          if (
            modeRef.current === 'page' &&
            lastNudgeEarlyRef.current &&
            next.url &&
            next.url === lastNudgeUrlRef.current
          ) {
            nudgePlayback(next.url)
            return
          }
          if (modeRef.current === 'pip') nudgePlayback(next.url)
        }
      })
    }
  }, [android, desktop, electron, hostNavigate, nudgePlayback])

  useEffect(() => {
    if (!desktop || mode !== 'page' || !frameRef.current || fullscreen) return
    const frame = frameRef.current
    const stage = frame.closest('.main-stage') as HTMLElement | null
    const observer = new ResizeObserver(() => {
      void syncPageBounds()
    })
    observer.observe(frame)
    const onLayout = () => {
      void syncPageBounds()
    }
    // Orientation changes often fire before layout settles — resync a few times.
    // Also re-show (not only setBounds) so Gecko doesn't keep a stale portrait rect.
    const orientTimers: number[] = []
    const onOrient = () => {
      const resync = () => {
        void syncPageBounds()
        if (frameRef.current && modeRef.current === 'page' && !fullscreen) {
          void showAt(boundsFromElement(frameRef.current))
        }
      }
      resync()
      for (const ms of [80, 280, 600, 1000]) {
        orientTimers.push(window.setTimeout(resync, ms))
      }
      if (android) {
        orientTimers.push(window.setTimeout(() => softResumePlayback(), 700))
      }
    }
    stage?.addEventListener('scroll', onLayout, { passive: true })
    window.addEventListener('resize', onLayout)
    window.addEventListener('orientationchange', onOrient)
    window.addEventListener('scroll', onLayout, { passive: true, capture: true })
    window.visualViewport?.addEventListener('resize', onLayout)
    void syncPageBounds()
    return () => {
      observer.disconnect()
      stage?.removeEventListener('scroll', onLayout)
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('orientationchange', onOrient)
      window.removeEventListener('scroll', onLayout, true)
      window.visualViewport?.removeEventListener('resize', onLayout)
      for (const id of orientTimers) window.clearTimeout(id)
    }
  }, [android, desktop, mode, fullscreen, syncPageBounds, softResumePlayback, showAt])

  useEffect(() => {
    if (!desktop || mode !== 'pip' || !fullscreen) return
    const place = () => {
      void showAt(
        android ? letterboxedFullscreenBounds(embedAspectRef.current) : pipFullscreenBounds(),
      )
    }
    window.addEventListener('resize', place)
    place()
    return () => window.removeEventListener('resize', place)
  }, [android, desktop, mode, fullscreen, showAt])

  useEffect(() => {
    if (!desktop || mode !== 'pip' || fullscreen) return
    const onWin = () => {
      void showAt(pipStageBounds())
    }
    const onOrient = () => {
      onWin()
      window.setTimeout(onWin, 80)
      window.setTimeout(onWin, 280)
      window.setTimeout(onWin, 600)
    }
    window.addEventListener('resize', onWin)
    window.addEventListener('orientationchange', onOrient)
    void showAt(pipStageBounds())
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('orientationchange', onOrient)
    }
  }, [desktop, mode, fullscreen, showAt])

  useEffect(() => () => clearAutoplayTimers(), [clearAutoplayTimers])

  useEffect(() => {
    if (!desktop || mode === 'off') return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'F11') return
      // Idle web PiP beside a native player must not steal F11 — only when
      // the browser is the active watch surface (page, or PiP that already owns Full).
      if (modeRef.current === 'pip' && getFullscreenOwner() !== 'web' && !fullscreenRef.current) {
        return
      }
      event.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktop, mode, toggleFullscreen])

  useEffect(() => {
    if (!fullscreen) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      exitFullscreen()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fullscreen, exitFullscreen])

  // Escape pressed inside the native WebContentsView never hits window — main forwards it.
  // Main has already left OS fullscreen before it sends this, so only reset this
  // surface's own view here. Calling exitOsFullscreen again bounced back to main,
  // which sent force-exit again: an endless loop that undid every later Full.
  useEffect(() => {
    const stop = window.signalDesktop?.onForceExitFullscreen?.(() => {
      if (!desktop) return
      guestFsCooldownUntilRef.current = Date.now() + 2500
      setFullscreen(false)
      if (modeRef.current === 'pip') void showAt(pipStageBounds())
      else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
      else if (modeRef.current === 'page') void showAt(pageFullscreenBounds())
    })
    return () => stop?.()
  }, [desktop, showAt])

  // Keep owner in sync when OS fullscreen changes outside our toggle.
  // Only prefer 'web' while the in-app browser is actually active.
  useEffect(() => {
    const stop = window.signalDesktop?.onFullScreenChange?.((state) => {
      const next = Boolean(state?.fullScreen)
      const prefer =
        modeRef.current !== 'off' && (fullscreenRef.current || getFullscreenOwner() === 'web')
          ? 'web'
          : undefined
      syncFullscreenOwnerFromOs(next, prefer)
      if (!next && fullscreenRef.current) {
        guestFsCooldownUntilRef.current = Date.now() + 2500
        setFullscreen(false)
        if (modeRef.current === 'pip') void showAt(pipStageBounds())
        else if (frameRef.current) void showAt(boundsFromElement(frameRef.current))
      }
    })
    return () => stop?.()
  }, [showAt])

  const value = useMemo<WebBrowserContextValue>(
    () => ({
      desktop,
      mode,
      nav,
      contentTitle,
      setContentTitle,
      address,
      setAddress,
      status,
      setStatus,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      goBack: () => {
        if (electron) void window.signalDesktop?.browserGoBack?.()
        else if (android) void androidBrowserGoBack()
      },
      goForward: () => {
        if (electron) void window.signalDesktop?.browserGoForward?.()
        else if (android) void androidBrowserGoForward()
      },
      reload: () => {
        if (electron) void window.signalDesktop?.browserReload?.()
        else if (android) void androidBrowserReload()
      },
      stalled,
      retryStalled: () => {
        const again = lastEmbedUrlRef.current || navUrlForNudgeRef.current
        if (again) void openUrl(again)
      },
      openInPip,
      setPipOnLeave,
      minimizeActiveEmbedToPip,
      expandFromPip,
      closeBrowser,
      parkForMultiview,
      toggleFullscreen,
      exitFullscreen,
      syncBrowserView,
      unmuteEmbed: nudgePlayback,
    }),
    [
      desktop,
      mode,
      nav,
      contentTitle,
      setContentTitle,
      address,
      status,
      stalled,
      fullscreen,
      attachFrame,
      detachFrame,
      openUrl,
      openInPip,
      setPipOnLeave,
      minimizeActiveEmbedToPip,
      expandFromPip,
      closeBrowser,
      parkForMultiview,
      toggleFullscreen,
      exitFullscreen,
      syncBrowserView,
      nudgePlayback,
    ],
  )

  return <WebBrowserContext.Provider value={value}>{children}</WebBrowserContext.Provider>
}

export function useWebBrowser() {
  const ctx = useContext(WebBrowserContext)
  if (!ctx) throw new Error('useWebBrowser must be used within WebBrowserProvider')
  return ctx
}

export function pipChromeMetrics() {
  if (typeof window === 'undefined') {
    return {
      width: PIP_WIDTH,
      stageHeight: PIP_HEIGHT,
      chromeHeight: PIP_CHROME,
      margin: PIP_MARGIN,
    }
  }
  const layout = getPipLayout()
  return {
    width: layout.width,
    stageHeight: layout.stageHeight,
    chromeHeight: layout.chromeHeight,
    margin: layout.margin,
  }
}
