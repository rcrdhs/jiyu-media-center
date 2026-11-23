package app.jiyu.mediacenter.browser;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;
import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * INVARIANT — Multiview tiles are System WebView (Chromium) only. Never GeckoSession.
 *
 * Why: GeckoView allows one active media session per runtime; sibling Gecko tiles
 * pause each other. Electron Multiview uses Chromium WebContentsView with
 * sandbox:false + backgroundThrottling:false — Android WebView is that engine family.
 *
 * Single-stream /web sports stays on GeckoOverlayController. Catalog CF Verify uses
 * the shared CookieManager jar so clearance cookies apply to these tiles.
 *
 * Nested player iframe {@code sandbox} attributes are blocked at document-start
 * (same product intent as Electron view sandbox:false).
 */
final class MultiWebHost {
  static final class BoundsCss {
    final float x;
    final float y;
    final float width;
    final float height;

    BoundsCss(float x, float y, float width, float height) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  }

  private static final String DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  private static final String DESKTOP_CHROME_FULL = "131.0.6778.69";

  /**
   * Spoof desktop Chrome before embed scripts run. Sports hosts (embed.st) inject a
   * fake "Remove sandbox attributes…" scare when they smell Android WebView /
   * missing window.chrome — validated by scripts/sandbox-multiview-harness.cjs.
   */
  private static final String EMBED_STEALTH_JS =
    "(function(){try{"
      + "Object.defineProperty(Navigator.prototype,'webdriver',{get:function(){return undefined;},configurable:true});"
      + "}catch(e){}"
      + "try{if(!window.chrome)window.chrome={};if(!window.chrome.runtime)window.chrome.runtime={};}catch(e){}"
      + "try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 0;},configurable:true});}catch(e){}"
      + "try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';},configurable:true});}catch(e){}"
      + "try{Object.defineProperty(navigator,'vendor',{get:function(){return 'Google Inc.';},configurable:true});}catch(e){}"
      + "try{Object.defineProperty(Document.prototype,'referrer',{get:function(){return '';},configurable:true});}catch(e){}"
      + "try{"
      + "Object.defineProperty(navigator,'userAgentData',{get:function(){return{"
      + "brands:[{brand:'Not_A Brand',version:'24'},{brand:'Chromium',version:'131'},{brand:'Google Chrome',version:'131'}],"
      + "mobile:false,platform:'Windows',"
      + "getHighEntropyValues:async function(){return{"
      + "architecture:'x86',bitness:'64',mobile:false,model:'',platform:'Windows',platformVersion:'15.0.0',"
      + "uaFullVersion:'" + DESKTOP_CHROME_FULL + "',"
      + "fullVersionList:[{brand:'Not_A Brand',version:'10.0.2.4'},{brand:'Chromium',version:'"
      + DESKTOP_CHROME_FULL + "'},{brand:'Google Chrome',version:'" + DESKTOP_CHROME_FULL + "'}]"
      + "};}"
      + "};},configurable:true});"
      + "}catch(e){}"
      + "})();";

  /**
   * Document-start: block iframe sandbox before page scripts (Electron sandbox:false parity).
   * Covers setAttribute, property setter, and innerHTML/insertAdjacentHTML injection.
   */
  private static final String BLOCK_SANDBOX_AT_START_JS =
    "(function(){try{"
      + "var allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';"
      + "if(window.__jiyuSandboxBlocked)return;window.__jiyuSandboxBlocked=1;"
      + "var setAttr=Element.prototype.setAttribute;"
      + "Element.prototype.setAttribute=function(n,v){"
      + "if(this.tagName==='IFRAME'&&String(n).toLowerCase()==='sandbox'){"
      + "this.removeAttribute('sandbox');"
      + "if(!this.getAttribute('allow'))this.setAttribute('allow',allow);"
      + "if(!this.hasAttribute('allowfullscreen'))this.setAttribute('allowfullscreen','');"
      + "return;}"
      + "return setAttr.apply(this,arguments);};"
      + "if(Element.prototype.setAttributeNS){"
      + "var setNS=Element.prototype.setAttributeNS;"
      + "Element.prototype.setAttributeNS=function(ns,n,v){"
      + "if(this.tagName==='IFRAME'&&String(n).toLowerCase()==='sandbox')return;"
      + "return setNS.apply(this,arguments);};}"
      + "var desc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'sandbox');"
      + "if(desc&&desc.configurable){"
      + "Object.defineProperty(HTMLIFrameElement.prototype,'sandbox',{"
      + "configurable:true,enumerable:true,"
      + "get:function(){return '';},"
      + "set:function(){try{this.removeAttribute('sandbox');}catch(e){}}"
      + "});}"
      + "function stripSandboxHtml(html){"
      + "return String(html||'').replace(/\\ssandbox(\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]*))?/ig,'');}"
      + "try{var ih=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');"
      + "if(ih&&ih.set&&ih.configurable){Object.defineProperty(Element.prototype,'innerHTML',{"
      + "configurable:true,enumerable:true,get:ih.get,"
      + "set:function(v){return ih.set.call(this,stripSandboxHtml(v));}});}}catch(e){}"
      + "try{var oia=Element.prototype.insertAdjacentHTML;"
      + "Element.prototype.insertAdjacentHTML=function(pos,html){"
      + "return oia.call(this,pos,stripSandboxHtml(html));};}catch(e){}"
      + "function scrub(root){try{"
      + "(root||document).querySelectorAll('iframe').forEach(function(f){"
      + "if(f.hasAttribute('sandbox')){"
      + "var src=f.getAttribute('src')||f.src||'';"
      + "f.removeAttribute('sandbox');"
      + "f.setAttribute('allow',allow);f.setAttribute('allowfullscreen','');"
      + "if(src&&!f.dataset.jiyuScrubReloaded){f.dataset.jiyuScrubReloaded='1';try{f.src=src;}catch(e){}}"
      + "}else{"
      + "if(!f.getAttribute('allow'))f.setAttribute('allow',allow);"
      + "if(!f.hasAttribute('allowfullscreen'))f.setAttribute('allowfullscreen','');"
      + "}});"
      + "}catch(e){}}"
      + "scrub(document);"
      + "if(document.documentElement&&!window.__jiyuSandboxObs){"
      + "window.__jiyuSandboxObs=1;"
      + "new MutationObserver(function(){scrub(document);}).observe(document.documentElement,"
      + "{childList:true,subtree:true,attributes:true,attributeFilter:['sandbox']});}"
      + "if(!window.__jiyuSandboxPoll){window.__jiyuSandboxPoll=1;"
      + "var n=0;var t=setInterval(function(){scrub(document);if(++n>40)clearInterval(t);},250);}"
      + "}catch(e){}})();";

  private static final String HIDE_SANDBOX_COMPLAINT_JS =
    "(function(){try{"
      + "function hideComplaints(root){try{"
      + "(root||document).querySelectorAll('body,body *').forEach(function(el){"
      + "try{var t=(el.textContent||'').trim();"
      + "if(t.length>6&&t.length<400&&/sandbox/i.test(t)"
      + "&&(/remove sandbox|sandbox attributes|sandbox attribute|iframe tag|unsandbox/i.test(t))"
      + "&&(!el.children||el.children.length<12)){"
      + "el.style.setProperty('display','none','important');"
      + "el.style.setProperty('visibility','hidden','important');"
      + "el.setAttribute('hidden','');"
      + "var p=el.parentElement;"
      + "if(p&&(p.textContent||'').trim().length<450){"
      + "p.style.setProperty('display','none','important');}}"
      + "}catch(e){}});}catch(e){}}"
      + "hideComplaints(document);"
      + "if(!window.__jiyuComplaintObs&&document.documentElement){"
      + "window.__jiyuComplaintObs=1;"
      + "new MutationObserver(function(){hideComplaints(document);})"
      + ".observe(document.documentElement,{childList:true,subtree:true,characterData:true});}"
      + "if(!window.__jiyuComplaintPoll){window.__jiyuComplaintPoll=1;"
      + "var n=0;var t=setInterval(function(){hideComplaints(document);if(++n>40)clearInterval(t);},300);}"
      + "}catch(e){}})();";

  /**
   * Aggressive iframe unsandbox: strip attribute, force allow, reload src once.
   */
  private static final String HARD_UNSANDBOX_JS =
    "(function(){try{"
      + "var allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';"
      + "function fix(f){if(!f||!f.tagName||f.tagName!=='IFRAME')return;"
      + "var had=f.hasAttribute('sandbox');"
      + "f.removeAttribute('sandbox');"
      + "f.setAttribute('allow',allow);f.setAttribute('allowfullscreen','');"
      + "if(had){var src=f.getAttribute('src')||f.src||'';"
      + "if(src&&f.dataset.jiyuHardReload!=='1'){f.dataset.jiyuHardReload='1';try{f.src=src;}catch(e){}}}"
      + "}"
      + "document.querySelectorAll('iframe').forEach(fix);"
      + "return 'ok';}catch(e){return 'error';}})();";

  /**
   * StreamCorner watch pages: auto-pick first source and hide chat so the tile
   * shows the player instead of streamcorner-chat.pages.dev.
   */
  private static final String STREAMCORNER_BOOT_JS =
    "(function(){try{"
      + "var host=String(location.hostname||'').replace(/^www\\./i,'').toLowerCase();"
      + "if(!/(^|\\.)(streamcorner|strmcrnr|streamninja)\\.(st|foo|cloud|fun|top)$/i.test(host))return 'skip';"
      + "if(window!==window.top)return 'skip-frame';"
      + "if(typeof window.__jiyuCornerSrcIdx!=='number')window.__jiyuCornerSrcIdx=0;"
      + "function clearBlockers(){try{"
      + "var style=document.getElementById('jiyu-corner-clear-blockers');"
      + "if(!style){style=document.createElement('style');style.id='jiyu-corner-clear-blockers';"
      + "style.textContent='#dontfoid,[id*=\"dontfo\"],[class*=\"dontfo\"]{display:none!important;visibility:hidden!important;pointer-events:none!important;opacity:0!important;}';"
      + "(document.documentElement||document.head||document.body).appendChild(style);}"
      + "var nodes=document.querySelectorAll('#dontfoid,[id*=\"dontfo\"],[class*=\"dontfo\"]');"
      + "for(var i=0;i<nodes.length;i++){try{nodes[i].remove();}catch(e){}}"
      + "}catch(e){}}"
      + "function hideChat(){try{"
      + "var btns=document.querySelectorAll('button,a,[role=button]');"
      + "for(var i=0;i<btns.length;i++){"
      + "var t=String(btns[i].innerText||btns[i].textContent||'').replace(/\\s+/g,' ').trim();"
      + "if(/^Hide Chat$/i.test(t)){btns[i].click();break;}}"
      + "var style=document.getElementById('jiyu-corner-hide-chat');"
      + "if(!style){style=document.createElement('style');style.id='jiyu-corner-hide-chat';"
      + "style.textContent='#player-chat,#player-chat-content,iframe[src*=\"streamcorner-chat\"],iframe[src*=\"chatroom=\"]"
      + ",[id*=\"chat-room\"],[class*=\"chat-room\"],[class*=\"streamcorner-chat\"]"
      + "{display:none!important;width:0!important;max-width:0!important;height:0!important;max-height:0!important;"
      + "overflow:hidden!important;opacity:0!important;pointer-events:none!important;}"
      + "(document.documentElement||document.head||document.body).appendChild(style);}"
      + "var chat=document.getElementById('player-chat');"
      + "if(chat){chat.style.setProperty('display','none','important');}"
      + "var frames=document.querySelectorAll('iframe');"
      + "for(var f=0;f<frames.length;f++){"
      + "var src=String(frames[f].src||frames[f].getAttribute('src')||'');"
      + "if(/streamcorner-chat|chatroom=/i.test(src)){"
      + "frames[f].style.setProperty('display','none','important');"
      + "frames[f].setAttribute('data-jiyu-hide-chat','1');}}"
      + "}catch(e){}}"
      + "function findPlayer(){try{"
      + "var fs=document.querySelectorAll('iframe');"
      + "for(var i=0;i<fs.length;i++){var src=String(fs[i].src||fs[i].getAttribute('src')||'');"
      + "if(!/^https?:\\/\\//i.test(src)||/streamcorner-chat|chatroom=/i.test(src))continue;"
      + "var r=fs[i].getBoundingClientRect();if(r.width>120&&r.height>80)return fs[i];}"
      + "var bm=document.querySelector('[id*=\"bitmovin\"],[class*=\"bitmovin\"],.bmpui-container,[class*=\"bmpui-\"]');"
      + "if(bm){var shell=bm.closest('[id*=\"player\"],[class*=\"player\"]')||bm;"
      + "var br=shell.getBoundingClientRect();if(br.width>80&&br.height>60)return shell;}"
      + "var vids=document.querySelectorAll('video');"
      + "for(var v=0;v<vids.length;v++){var vr=vids[v].getBoundingClientRect();"
      + "if(vr.width>80&&vr.height>60)return vids[v].closest('[id*=\"player\"],[class*=\"player\"]')||vids[v];}"
      + "return null;}catch(e){return null;}}"
      + "function focusPlayer(){try{var player=findPlayer();if(!player)return false;"
      + "var tbs=document.querySelectorAll('button,a,[role=button]');"
      + "for(var i=0;i<tbs.length;i++){if(/^\\s*Theater Mode\\s*$/i.test(String(tbs[i].innerText||''))){tbs[i].click();break;}}"
      + "var style=document.getElementById('jiyu-corner-player-only');"
      + "if(!style){style=document.createElement('style');style.id='jiyu-corner-player-only';"
      + "style.textContent='html.jiyu-corner-only,html.jiyu-corner-only body{margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important;width:100%!important;height:100%!important;}"
      + "html.jiyu-corner-only .stream-navbar,html.jiyu-corner-only header,html.jiyu-corner-only nav,html.jiyu-corner-only footer,"
      + "html.jiyu-corner-only #player-chat,html.jiyu-corner-only #player-chat-content,html.jiyu-corner-only .night-page-backdrop,"
      + "html.jiyu-corner-only [class*=\"reminder\"],html.jiyu-corner-only aside,"
      + "html.jiyu-corner-only iframe[src*=\"streamcorner-chat\"],html.jiyu-corner-only iframe[src*=\"chatroom=\"]{display:none!important;}"
      + "html.jiyu-corner-only .jiyu-corner-player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;"
      + "max-width:none!important;max-height:none!important;border:0!important;z-index:2147483000!important;background:#000!important;}';"
      + "(document.documentElement||document.head||document.body).appendChild(style);}"
      + "document.documentElement.classList.add('jiyu-corner-only');"
      + "player.classList.add('jiyu-corner-player');"
      + "player.style.setProperty('position','fixed','important');"
      + "player.style.setProperty('inset','0','important');"
      + "player.style.setProperty('width','100vw','important');"
      + "player.style.setProperty('height','100vh','important');"
      + "player.style.setProperty('z-index','2147483000','important');"
      + "var node=player.parentElement;"
      + "while(node&&node!==document.documentElement){"
      + "node.style.setProperty('margin','0','important');node.style.setProperty('padding','0','important');"
      + "node.style.setProperty('width','100%','important');node.style.setProperty('height','100%','important');"
      + "node.style.setProperty('overflow','hidden','important');node.style.setProperty('background','#000','important');"
      + "if(node.parentElement){var kids=node.parentElement.children;"
      + "for(var s=0;s<kids.length;s++){var sib=kids[s];if(sib===node)continue;"
      + "if(/^(SCRIPT|STYLE|LINK|META)$/i.test(sib.tagName||''))continue;"
      + "if(sib.id&&/^jiyu-corner-/i.test(sib.id))continue;"
      + "sib.style.setProperty('display','none','important');}}"
      + "node=node.parentElement;}return true;}catch(e){return false;}}"
      + "function reactClick(el){try{if(!el)return false;var keys=Object.keys(el);"
      + "for(var i=0;i<keys.length;i++){"
      + "if(keys[i].indexOf('__reactProps')!==0&&keys[i].indexOf('__reactEventHandlers')!==0)continue;"
      + "var p=el[keys[i]];if(!p)continue;"
      + "var fn=p.onClick||(p.onPointerUp)||(p.onMouseDown);"
      + "if(typeof fn==='function'){fn.call(el,{bubbles:true,cancelable:true,target:el,currentTarget:el,"
      + "preventDefault:function(){},stopPropagation:function(){},nativeEvent:{}});return true;}}"
      + "return false;}catch(e){return false;}}"
      + "function hardClick(el){try{if(!el)return false;"
      + "try{el.scrollIntoView({block:'center',inline:'nearest'});}catch(e){}"
      + "reactClick(el);"
      + "var r=el.getBoundingClientRect();"
      + "var x=Math.max(2,Math.min((r.left+r.width/2)||1,window.innerWidth-2));"
      + "var y=Math.max(2,Math.min((r.top+r.height/2)||1,window.innerHeight-2));"
      + "var t=document.elementFromPoint(x,y)||el;"
      + "reactClick(t);"
      + "var opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,buttons:1};"
      + "['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(type){"
      + "try{var Ev=type.indexOf('pointer')===0?PointerEvent:MouseEvent;t.dispatchEvent(new Ev(type,opts));}catch(e){}});"
      + "try{t.click();}catch(e){}try{el.click();}catch(e){}return true;}catch(e){return false;}}"
      + "function listSources(){try{var out=[],seen=new Set();"
      + "function add(el){if(!el)return;var card=el;"
      + "for(var u=0;u<8&&card;u++){"
      + "var rr=card.getBoundingClientRect();"
      + "var t=String(card.innerText||'').replace(/\\s+/g,' ').trim();"
      + "if(rr.width>140&&rr.height>40&&rr.height<220&&t.length>2&&t.length<180"
      + "&&!/AVAILABLE SOURCES|CONTROLS|Hide Chat|Float Chat|Reload|BITMOVIN|STREAMCORNER CHAT/i.test(t))break;"
      + "card=card.parentElement;}"
      + "if(!card||seen.has(card))return;seen.add(card);out.push(card);}"
      + "var root=document.body;var hs=document.querySelectorAll('h1,h2,h3,h4,div,span,p,section');"
      + "for(var h=0;h<hs.length;h++){"
      + "if(/^AVAILABLE SOURCES$/i.test(String(hs[h].textContent||'').replace(/\\s+/g,' ').trim())){"
      + "root=hs[h].parentElement||hs[h];break;}}"
      + "var nodes=root.querySelectorAll('button,a,[role=button],div,li,label');"
      + "for(var j=0;j<nodes.length;j++){"
      + "var t=String(nodes[j].innerText||'').replace(/\\s+/g,' ').trim();"
      + "if(t.length<3||t.length>160)continue;"
      + "if(/AVAILABLE SOURCES|CONTROLS|Hide Chat|Float Chat|Reload Player|BITMOVIN|Loading up|SELECT A SOURCE|STREAMCORNER CHAT|Keep it friendly/i.test(t))continue;"
      + "if(/^(HD|SD|FHD|UHD|4K)\\b/i.test(t)||/\\b(BEIN|ESPN|DAZN|SKY|SPORTS?|LIGUE|PREMIER|ESPA.?OL)\\b/i.test(t))"
      + "add(nodes[j]);}"
      + "var btns=document.querySelectorAll('button.stream-source-btn,[class*=\"stream-source\"],[class*=\"source-card\"]');"
      + "for(var i=0;i<btns.length;i++)add(btns[i]);"
      + "return out;}catch(e){return[];}}"
      + "function clickPlay(){try{"
      + "var bs=document.querySelectorAll('button,a,[role=button],div');"
      + "for(var i=0;i<bs.length;i++){"
      + "var el=bs[i];var t=String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();"
      + "var al=String(el.getAttribute('aria-label')||el.title||'');"
      + "if(/^PLAY$/i.test(t)||/^play$/i.test(al)){hardClick(el);return true;}}"
      + "var nodes=document.querySelectorAll('div,section,button,a');"
      + "for(var k=0;k<nodes.length;k++){"
      + "var nt=String(nodes[k].innerText||'').replace(/\\s+/g,' ').trim();"
      + "if(!/SELECT A SOURCE TO START PLAYBACK/i.test(nt)||nt.length>180)continue;"
      + "hardClick(nodes[k].querySelector('button,a,[role=button]')||nodes[k]);return true;}"
      + "var vids=document.querySelectorAll('video');"
      + "for(var v=0;v<vids.length;v++){try{vids[v].muted=true;var p=vids[v].play();if(p&&p.catch)p.catch(function(){});}catch(e){}}"
      + "return false;}catch(e){return false;}}"
      + "function needsSource(){try{"
      + "return /SELECT A SOURCE TO START PLAYBACK/i.test(String((document.body&&document.body.innerText)||''));"
      + "}catch(e){return false;}}"
      + "function hasPlayingVideo(){try{"
      + "var vids=document.querySelectorAll('video');"
      + "for(var i=0;i<vids.length;i++){var v=vids[i];if((v.currentSrc||v.src)&&!v.paused&&v.readyState>=2)return true;}"
      + "return false;}catch(e){return false;}}"
      + "function kick(){try{hideChat();"
      + "var sources=listSources();"
      + "if(sources.length){hardClick(sources[(window.__jiyuCornerSrcIdx||0)%sources.length]);}"
      + "clickPlay();"
      + "var bs=document.querySelectorAll('button,a,[role=button]');"
      + "for(var i=0;i<bs.length;i++){"
      + "if(/^Reload Player$/i.test(String(bs[i].innerText||'').replace(/\\s+/g,' ').trim()))hardClick(bs[i]);}"
      + "var vids=document.querySelectorAll('video');"
      + "for(var v=0;v<vids.length;v++){try{vids[v].muted=true;var p=vids[v].play();if(p&&p.catch)p.catch(function(){});}catch(e){}}"
      + "if(hasPlayingVideo()){focusPlayer();return 'has-player';}"
      + "if(needsSource())return 'need-source';"
      + "return sources.length?'source':'wait';}catch(e){return 'error';}}"
      + "if(window.__jiyuCornerBoot){clearBlockers();return kick();}"
      + "window.__jiyuCornerBoot=1;clearBlockers();hideChat();kick();var n=0;"
      + "var tick=setInterval(function(){n++;clearBlockers();var st=kick();"
      + "if(st==='has-player'){if(n>=20)clearInterval(tick);return;}"
      + "if(n%3===0)window.__jiyuCornerSrcIdx=(window.__jiyuCornerSrcIdx||0)+1;"
      + "if(n>=70)clearInterval(tick);},600);"
      + "return 'ok';}catch(e){return 'error'}})();";
  /** Compact Electron scheduleBrowserAdShield / EMBED_AD_HIDE + fake notification popups. */
  private static final String AD_HIDE_JS =
    "(function(){try{"
      + "var id='jiyu-adhide-style';"
      + "if(!document.getElementById(id)){"
      + "var css=document.createElement('style');css.id=id;"
      + "css.textContent='#ol-ads,#ol-iframe,#timer-close,#remove-tag,"
      + "iframe#close,iframe[src*=\"/ad.html\"],iframe[src*=\"/banner/static/\"],"
      + "iframe[src*=\"tsyndicate\"],iframe[src*=\"exoclick\"],iframe[src*=\"juicyads\"],"
      + "iframe[src*=\"doubleclick\"],iframe[src*=\"googlesyndication\"],iframe[id*=\"google_ads\"],"
      + "ins.adsbygoogle,[data-jiyu-ad-hide=\"1\"]{"
      + "display:none!important;visibility:hidden!important;pointer-events:none!important;"
      + "width:0!important;height:0!important;opacity:0!important;}';"
      + "(document.head||document.documentElement).appendChild(css);}"
      + "document.querySelectorAll('#ol-ads,#ol-iframe,iframe#close,iframe[src*=\"/ad.html\"]')"
      + ".forEach(function(n){try{n.remove();}catch(e){}});"
      // Playmogo soft-ad tiles: strip network-error + large image interstitials.
      + "(function scrubPm(){try{"
      + "var h=String(location.hostname||'').replace(/^www\\./i,'').toLowerCase();"
      + "var path=String(location.pathname||'');"
      + "if(!(h==='playmogo.com'||h.indexOf('.playmogo.com')>=0||(/^\\/e\\/[a-z0-9]{6,}/i.test(path)&&/(playmogo|dood)/i.test(h))))return;"
      + "var nodes=document.querySelectorAll('div,section,aside,a,button,ins,iframe');"
      + "for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!el||el.getAttribute('data-jiyu-pm')==='1')continue;"
      + "var txt=String(el.innerText||'').replace(/\\s+/g,' ').trim();"
      + "var idc=(String(el.id||'')+' '+String(el.className||'')).toLowerCase();"
      + "var kill=/Network error!?\\s*Please reload/i.test(txt)&&txt.length<220;"
      + "kill=kill||/getlink|ol-ads|adsbygoogle|google_ads/.test(idc);"
      + "kill=kill||/going viral|simple trick|thousands of people/i.test(txt);"
      + "try{var st=window.getComputedStyle(el);var pos=st?String(st.position||''):'';"
      + "var r=el.getBoundingClientRect();"
      + "if(!kill&&(pos==='fixed'||pos==='absolute')&&r.width>180&&r.height>160"
      + "&&el.querySelector&&el.querySelector('img,canvas')&&!el.querySelector('video')&&txt.length<80)kill=true;}"
      + "catch(e){}"
      + "if(!kill)continue;el.setAttribute('data-jiyu-pm','1');"
      + "el.style.setProperty('display','none','important');el.style.setProperty('pointer-events','none','important');"
      + "try{el.remove();}catch(e){}}"
      + "document.querySelectorAll('video').forEach(function(v){try{if(v.paused){var p=v.play();if(p&&p.catch)p.catch(function(){});}}catch(e){}});"
      + "}catch(e){}})();"
      + "function looksFake(t){"
      + "if(!t)return false;"
      + "if(/You received a message!?/i.test(t))return true;"
      + "if(/You have (?:a |received a )?message!?/i.test(t))return true;"
      + "if(/New message!?/i.test(t)&&/\\bOK\\b/i.test(t))return true;"
      + "if(/A Surprise Is Waiting/i.test(t)&&/OPEN\\\\s*NOW/i.test(t))return true;"
      + "if(/going viral|simple trick|thousands of people|why thousands|is going viral/i.test(t)&&t.length<280)return true;"
      + "return false;}"
      + "function hideFake(){try{"
      + "var nodes=document.querySelectorAll('div,section,aside,article');"
      + "for(var i=0;i<nodes.length;i++){var el=nodes[i];"
      + "if(!el||el.getAttribute('data-jiyu-ad-hide')==='1')continue;"
      + "var text='';try{text=String(el.innerText||el.textContent||'');}catch(e){continue;}"
      + "text=text.replace(/\\\\s+/g,' ').trim();"
      + "if(!text||text.length>360||!looksFake(text))continue;"
      + "var target=el;"
      + "for(var d=0;d<6&&target.parentElement;d++){"
      + "var p=target.parentElement;"
      + "if(!p||p===document.body||p===document.documentElement)break;"
      + "var st=window.getComputedStyle(p);var pos=st?String(st.position||''):'';"
      + "if(pos==='fixed'||pos==='absolute'||pos==='sticky'){target=p;break;}"
      + "var pt='';try{pt=String(p.innerText||'').replace(/\\\\s+/g,' ').trim();}catch(e){}"
      + "if(pt&&pt.length<=text.length+64&&looksFake(pt)){target=p;continue;}break;}"
      + "try{target.setAttribute('data-jiyu-ad-hide','1');"
      + "target.style.setProperty('display','none','important');"
      + "target.style.setProperty('visibility','hidden','important');"
      + "target.style.setProperty('pointer-events','none','important');"
      + "target.style.setProperty('opacity','0','important');"
      + "try{target.remove();}catch(e){}}catch(e){}}}"
      + "}catch(e){}}hideFake();"
      + "if(!window.__jiyuFakePushObs){window.__jiyuFakePushObs=1;"
      + "try{new MutationObserver(function(){hideFake();})"
      + ".observe(document.documentElement,{childList:true,subtree:true});"
      + "setInterval(hideFake,1500);}catch(e){}}"
      + "}catch(e){}})();";

  private static String autoplayScript(boolean forceMute) {
    return "(function(){try{"
      + "var fm=" + forceMute + ";"
      + "var lv=1;"
      + "if(typeof window.__jiyuVolLevel==='number'&&window.__jiyuVolLevel>=0)lv=window.__jiyuVolLevel;"
      + "function vidsIn(doc,out){try{"
      + "doc.querySelectorAll('video').forEach(function(v){out.push(v);});"
      + "doc.querySelectorAll('iframe').forEach(function(f){"
      + "try{if(f.contentDocument)vidsIn(f.contentDocument,out);}catch(e){}"
      + "});}catch(e){}}"
      + "var vids=[];vidsIn(document,vids);"
      + "for(var i=0;i<vids.length;i++){"
      + "vids[i].muted=fm;vids[i].volume=fm?0:lv;"
      + "try{vids[i].playsInline=true;vids[i].setAttribute('playsinline','');"
      + "vids[i].setAttribute('autoplay','');}catch(e){}"
      + "}"
      + "for(var a=0;a<vids.length;a++){"
      + "if(!vids[a].paused&&!vids[a].ended)return 'already';}"
      + "for(var j=0;j<vids.length;j++){"
      + "try{if(vids[j].paused){var p=vids[j].play();if(p&&p.catch)p.catch(function(){});}}catch(e){}"
      + "}"
      + "if(vids.length)return 'play';"
      + "var s=['.ytp-large-play-button','.vjs-big-play-button','.jw-icon-display',"
      + "'.plyr__control--overlaid','button[aria-label*=\"Play\" i]','button[class*=\"play\" i]'];"
      + "for(var k=0;k<s.length;k++){var el=document.querySelector(s[k]);"
      + "if(el){try{el.click();return 'ui';}catch(e){}}}"
      + "return 'noop';}catch(e){return 'error';}})()";
  }

  private static final String IS_PLAYING_SCRIPT =
    "(function(){try{var v=document.querySelectorAll('video');"
      + "for(var i=0;i<v.length;i++){"
      + "if(!v[i].paused&&!v[i].ended&&v[i].readyState>1)return 'playing';}"
      + "return 'idle';}catch(e){return 'idle';}})()";

  private final Context appContext;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, WebView> tiles = new HashMap<>();
  private final Map<String, FrameLayout.LayoutParams> layoutById = new HashMap<>();
  private final Map<String, String> urlsById = new HashMap<>();
  private final Map<String, ArrayList<Runnable>> nudgeTimers = new HashMap<>();
  private final Set<WebView> docStartInstalled = Collections.newSetFromMap(new HashMap<>());
  private String audioPrimaryId = "";

  MultiWebHost(Context context) {
    this.appContext = context.getApplicationContext();
  }

  String getAudioPrimaryId() {
    return audioPrimaryId;
  }

  void show(
    String id,
    String url,
    @Nullable BoundsCss boundsCss,
    boolean primary,
    float density,
    FrameLayout parent,
    @Nullable Runnable hideSingle
  ) {
    if (id == null || id.isEmpty() || url == null || url.isEmpty() || parent == null) return;
    // Always park single Gecko so it cannot steal audio under Chromium tiles.
    if (hideSingle != null) hideSingle.run();
    if (primary) audioPrimaryId = id;
    else if (audioPrimaryId == null || audioPrimaryId.isEmpty()) audioPrimaryId = id;

    WebView view = tiles.get(id);
    if (view == null) {
      view = createTile(parent);
      tiles.put(id, view);
    }
    applyBounds(id, view, boundsCss, density);

    String prev = urlsById.get(id);
    boolean urlChanged = prev == null || !prev.equals(url);
    if (urlChanged) {
      loadTileUrl(view, url);
      urlsById.put(id, url);
    }

    // Electron backgroundThrottling:false — visible tiles stay resumed.
    view.setVisibility(View.VISIBLE);
    view.onResume();
    resumeAllVisible();
    boolean isPrimary = id.equals(audioPrimaryId);
    setPageMuted(view, !isPrimary);
    // Always nudge on show (new URL or re-attach after Add-stream pick).
    scheduleNudge(id);
  }

  void setBounds(String id, @Nullable BoundsCss boundsCss, float density) {
    WebView view = tiles.get(id);
    if (view == null) return;
    applyBounds(id, view, boundsCss, density);
    if (view.getVisibility() == View.VISIBLE) {
      view.onResume();
      resumeAllVisible();
    }
  }

  void setAudio(String id, boolean muted) {
    WebView view = tiles.get(id);
    if (view == null) return;
    setPageMuted(view, muted);
    injectHelpers(view);
    // Keep decoding when muted — never tear down the tile.
    view.evaluateJavascript(autoplayScript(muted), null);
    if (view.getVisibility() == View.VISIBLE) view.onResume();
  }

  void spotlight(String id) {
    if (id == null || id.isEmpty()) return;
    audioPrimaryId = id;
    resumeAllVisible();
    for (Map.Entry<String, WebView> e : tiles.entrySet()) {
      boolean mute = !id.equals(e.getKey());
      WebView v = e.getValue();
      if (v.getVisibility() == View.VISIBLE) v.onResume();
      setPageMuted(v, mute);
      injectHelpers(v);
      // JS mute only — do not destroy / reload siblings.
      v.evaluateJavascript(autoplayScript(mute), null);
    }
    main.postDelayed(() -> reassertSpotlight(id), 120);
    main.postDelayed(() -> reassertSpotlight(id), 700);
  }

  void nudge(String id) {
    if (id == null || id.isEmpty()) return;
    scheduleNudge(id);
  }

  void hide(String id, boolean blank, boolean destroy) {
    if (id == null || id.isEmpty()) return;
    cancelNudge(id);
    WebView view = tiles.get(id);
    if (view == null) return;
    view.setVisibility(View.GONE);
    // Pause only when leaving the grid (hidden/destroyed) — never while visible.
    view.onPause();
    if (blank) {
      // about:blank is white — black document matches the player stage.
      view.loadUrl("data:text/html,<html><body style='background:%23000'></body></html>");
      urlsById.remove(id);
    }
    if (destroy) {
      destroyTile(view);
      tiles.remove(id);
      layoutById.remove(id);
      urlsById.remove(id);
      docStartInstalled.remove(view);
      if (id.equals(audioPrimaryId)) audioPrimaryId = "";
    }
  }

  void hideAll(boolean blank, boolean destroy) {
    for (String tid : new ArrayList<>(tiles.keySet())) {
      hide(tid, blank, destroy);
    }
    if (destroy) audioPrimaryId = "";
  }

  void destroyAll() {
    hideAll(true, true);
  }

  /** Resume visible embed tiles after the host activity enters picture-in-picture. */
  void resumeVisible() {
    resumeAllVisible();
  }

  /** Pause embed tiles when the user closes the app out of picture-in-picture. */
  void pauseVisible() {
    for (WebView v : tiles.values()) {
      if (v == null) continue;
      try {
        v.onPause();
      } catch (Throwable ignored) {}
    }
  }

  /** Keep every visible tile resumed (Electron backgroundThrottling:false). */
  private void resumeAllVisible() {
    for (WebView v : tiles.values()) {
      if (v != null && v.getVisibility() == View.VISIBLE) {
        try {
          v.onResume();
        } catch (Throwable ignored) {}
      }
    }
  }

  private void reassertSpotlight(String id) {
    resumeAllVisible();
    for (Map.Entry<String, WebView> e : tiles.entrySet()) {
      boolean mute = !id.equals(e.getKey());
      setPageMuted(e.getValue(), mute);
      injectHelpers(e.getValue());
      if (mute) e.getValue().evaluateJavascript(autoplayScript(true), null);
    }
  }

  private void injectHelpers(WebView view) {
    if (view == null) return;
    view.evaluateJavascript(EMBED_STEALTH_JS, null);
    view.evaluateJavascript(BLOCK_SANDBOX_AT_START_JS, null);
    view.evaluateJavascript(HARD_UNSANDBOX_JS, null);
    view.evaluateJavascript(HIDE_SANDBOX_COMPLAINT_JS, null);
    view.evaluateJavascript(AD_HIDE_JS, null);
    try {
      String u = view.getUrl();
      if (u != null && (u.contains("streamcorner") || u.contains("strmcrnr") || u.contains("streamninja"))) {
        view.evaluateJavascript(STREAMCORNER_BOOT_JS, null);
      }
    } catch (Throwable ignored) {}
  }

  private static final Pattern SANDBOX_ATTR =
    Pattern.compile("(?i)\\s+sandbox(\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]*))?");

  @SuppressLint("SetJavaScriptEnabled")
  private WebView createTile(FrameLayout parent) {
    WebView view = new WebView(parent.getContext());
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    settings.setLoadWithOverviewMode(true);
    settings.setUseWideViewPort(true);
    try {
      settings.setJavaScriptCanOpenWindowsAutomatically(true);
    } catch (Throwable ignored) {}
    applyDesktopHardening(settings);
    try {
      CookieManager cm = CookieManager.getInstance();
      cm.setAcceptCookie(true);
      cm.setAcceptThirdPartyCookies(view, true);
    } catch (Throwable ignored) {}

    installDocumentStart(view);

    view.setBackgroundColor(Color.BLACK);
    view.setVisibility(View.GONE);
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(0, 0);
    view.setLayoutParams(lp);
    view.setWebViewClient(
      new WebViewClient() {
        @Override
        public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
          return app.jiyu.mediacenter.RendererGone.release(v, "multi-tile");
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
          // IMPORTANT (validated scripts/sandbox-referer-recipe.cjs):
          // HttpURLConnection against embed.st often receives the dead ~1KB stub while
          // Chromium WebView gets the real player. Never proxy embed.st through Java.
          // For other hosts: strip sandbox= from main-frame HTML before parse.
          if (request == null) return null;
          if (!request.isForMainFrame()) return null;
          if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
          String url = request.getUrl() != null ? request.getUrl().toString() : "";
          if (!url.startsWith("http")) return null;
          if (needsNoRefererDocument(url)) return null; // let Chromium fetch; stealth JS handles scare
          if (!shouldFetchHtmlForSandboxStrip(url)) return null;
          try {
            return fetchHtmlForTile(url, request.getRequestHeaders(), false);
          } catch (Throwable t) {
            return null;
          }
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
          injectHelpers(v);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
          if (v == null) return;
          injectHelpers(v);
          // Re-scrub a few times — Clappr injects sandboxed iframes after load.
          main.postDelayed(() -> injectHelpers(v), 400);
          main.postDelayed(() -> injectHelpers(v), 1200);
          main.postDelayed(() -> injectHelpers(v), 2500);
          boolean mute =
            audioPrimaryId == null
              || audioPrimaryId.isEmpty()
              || !idForView(v).equals(audioPrimaryId);
          setPageMuted(v, mute);
          v.evaluateJavascript(autoplayScript(mute), null);
          if (v.getVisibility() == View.VISIBLE) v.onResume();
        }
      }
    );
    TvPointer.prepareOverlayView(view);
    parent.addView(view);
    return view;
  }

  private static boolean shouldFetchHtmlForSandboxStrip(String url) {
    String u = url.toLowerCase();
    if (u.contains(".m3u8")
      || u.contains(".mp4")
      || u.contains(".webm")
      || u.contains(".ts")
      || u.contains(".m4s")
      || u.contains(".aac")
      || u.contains(".js")
      || u.contains(".css")
      || u.contains(".woff")
      || u.contains(".png")
      || u.contains(".jpg")
      || u.contains(".jpeg")
      || u.contains(".gif")
      || u.contains(".webp")
      || u.contains(".svg")
      || u.contains(".json")
      || u.contains(".xml")
      || u.contains("/api/")) {
      return false;
    }
    return true;
  }

  @Nullable
  private WebResourceResponse fetchHtmlForTile(
    String url,
    @Nullable Map<String, String> reqHeaders,
    boolean forceServeWithoutReferer
  ) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout(12000);
    conn.setReadTimeout(15000);
    conn.setRequestMethod("GET");
    conn.setRequestProperty("User-Agent", DESKTOP_UA);
    conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
    conn.setRequestProperty(
      "sec-ch-ua",
      "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\""
    );
    conn.setRequestProperty("sec-ch-ua-mobile", "?0");
    conn.setRequestProperty("sec-ch-ua-platform", "\"Windows\"");
    conn.setRequestProperty("Sec-Fetch-Dest", "document");
    conn.setRequestProperty("Sec-Fetch-Mode", "navigate");
    conn.setRequestProperty("Sec-Fetch-Site", "none");
    conn.setRequestProperty("Upgrade-Insecure-Requests", "1");
    try {
      String cookie = CookieManager.getInstance().getCookie(url);
      if (cookie != null && !cookie.isEmpty()) {
        conn.setRequestProperty("Cookie", cookie);
      }
    } catch (Throwable ignored) {}
    if (reqHeaders != null) {
      for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
        if (e.getKey() == null) continue;
        String k = e.getKey();
        // Never forward Referer / X-Requested-With — both collapse embed.st to a stub.
        if ("cookie".equalsIgnoreCase(k)
          || "user-agent".equalsIgnoreCase(k)
          || "referer".equalsIgnoreCase(k)
          || "x-requested-with".equalsIgnoreCase(k)) {
          continue;
        }
        try {
          conn.setRequestProperty(k, e.getValue());
        } catch (Throwable ignored) {}
      }
    }
    // Explicitly omit Referer for sports embeds (do not set empty — some stacks still send it).
    if (forceServeWithoutReferer) {
      // no-op: we never copied Referer above
    }
    int code = conn.getResponseCode();
    if (code < 200 || code >= 400) {
      conn.disconnect();
      return null;
    }
    // Persist Set-Cookie so CF clearance sticks across tiles.
    try {
      Map<String, List<String>> hdrs = conn.getHeaderFields();
      if (hdrs != null) {
        List<String> setCookies = hdrs.get("Set-Cookie");
        if (setCookies == null) setCookies = hdrs.get("set-cookie");
        if (setCookies != null) {
          CookieManager cm = CookieManager.getInstance();
          for (String sc : setCookies) {
            if (sc != null && !sc.isEmpty()) cm.setCookie(url, sc);
          }
          cm.flush();
        }
      }
    } catch (Throwable ignored) {}
    String contentType = conn.getContentType();
    if (contentType == null || !contentType.toLowerCase().contains("text/html")) {
      conn.disconnect();
      return null;
    }
    String mime = "text/html";
    String charset = "UTF-8";
    try {
      String[] parts = contentType.split(";");
      if (parts.length > 0 && parts[0].trim().length() > 0) mime = parts[0].trim();
      for (String p : parts) {
        String t = p.trim().toLowerCase();
        if (t.startsWith("charset=")) {
          charset = p.trim().substring(8).replace("\"", "");
        }
      }
    } catch (Throwable ignored) {}
    InputStream raw = conn.getInputStream();
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    int total = 0;
    while ((n = raw.read(buf)) >= 0) {
      bos.write(buf, 0, n);
      total += n;
      if (total > 2_500_000) {
        raw.close();
        conn.disconnect();
        return null;
      }
    }
    raw.close();
    Charset cs;
    try {
      cs = Charset.forName(charset);
    } catch (Throwable t) {
      cs = StandardCharsets.UTF_8;
      charset = "UTF-8";
    }
    String html = new String(bos.toByteArray(), cs);
    String stripped = SANDBOX_ATTR.matcher(html).replaceAll("");
    // For no-referer hosts: ALWAYS serve our bytes. Falling through lets WebView
    // refetch with a Referer and returns the dead ~1KB stub player.
    if (stripped.equals(html) && !forceServeWithoutReferer) {
      conn.disconnect();
      return null;
    }
    byte[] out = stripped.getBytes(cs);
    Map<String, String> headers = new HashMap<>();
    headers.put("Access-Control-Allow-Origin", "*");
    headers.put("Cache-Control", "no-store");
    conn.disconnect();
    return new WebResourceResponse(
      mime,
      charset,
      code,
      "OK",
      headers,
      new ByteArrayInputStream(out)
    );
  }

  private void installDocumentStart(WebView view) {
    if (view == null || docStartInstalled.contains(view)) return;
    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        Set<String> origins = new HashSet<>();
        origins.add("*");
        // Sandbox block must run before page JS in every frame.
        WebViewCompat.addDocumentStartJavaScript(view, EMBED_STEALTH_JS, origins);
        WebViewCompat.addDocumentStartJavaScript(view, BLOCK_SANDBOX_AT_START_JS, origins);
        WebViewCompat.addDocumentStartJavaScript(view, HARD_UNSANDBOX_JS, origins);
        WebViewCompat.addDocumentStartJavaScript(view, HIDE_SANDBOX_COMPLAINT_JS, origins);
        WebViewCompat.addDocumentStartJavaScript(view, AD_HIDE_JS, origins);
        docStartInstalled.add(view);
      }
    } catch (Throwable ignored) {}
  }

  private String idForView(WebView target) {
    for (Map.Entry<String, WebView> e : tiles.entrySet()) {
      if (e.getValue() == target) return e.getKey();
    }
    return "";
  }

  private void destroyTile(WebView view) {
    try {
      ViewGroup p = (ViewGroup) view.getParent();
      if (p != null) p.removeView(view);
      view.stopLoading();
      view.loadUrl("about:blank");
      view.onPause();
      view.destroy();
    } catch (Throwable ignored) {}
  }

  private void loadTileUrl(WebView view, String url) {
    installDocumentStart(view);
    // CF clearance from scrape/unlock WebView lives in the shared CookieManager.
    try {
      CookieManager.getInstance().flush();
    } catch (Throwable ignored) {}
    // embed.st: do NOT send Referer at all (empty string still stubs the player).
    // Navigate from about:blank first so Chromium has no prior document referrer.
    if (needsNoRefererDocument(url)) {
      try {
        view.loadUrl("about:blank");
      } catch (Throwable ignored) {}
      main.post(
        () -> {
          try {
            view.loadUrl(url);
          } catch (Throwable ignored) {}
        }
      );
    } else {
      view.loadUrl(url);
    }
  }

  private void setPageMuted(WebView view, boolean muted) {
    if (view == null) return;
    double level = muted ? 0 : 1;
    String script =
      "(function(){try{window.__jiyuVolLevel=" + level + ";"
        + "var nodes=document.querySelectorAll('video,audio');"
        + "for(var i=0;i<nodes.length;i++){nodes[i].muted=" + muted + ";nodes[i].volume=" + level + ";"
        + "try{nodes[i].playsInline=true;}catch(e){}"
        + "if(nodes[i].paused){try{var p=nodes[i].play();if(p&&p.catch)p.catch(function(){});}catch(e){}}"
        + "}"
        + "return " + muted + "?'muted':'unmuted';}catch(e){return 'error'}})()";
    view.evaluateJavascript(script, null);
  }

  private void applyBounds(
    String id,
    WebView view,
    @Nullable BoundsCss b,
    float density
  ) {
    FrameLayout.LayoutParams lp = layoutById.get(id);
    if (lp == null) {
      lp = new FrameLayout.LayoutParams(0, 0);
      layoutById.put(id, lp);
    }
    if (b != null && b.width > 0 && b.height > 0) {
      lp.leftMargin = Math.round(b.x * density);
      lp.topMargin = Math.round(b.y * density);
      lp.width = Math.round(b.width * density);
      lp.height = Math.round(b.height * density);
    } else {
      lp.leftMargin = 0;
      lp.topMargin = 0;
      lp.width = ViewGroup.LayoutParams.MATCH_PARENT;
      lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
    }
    view.setLayoutParams(lp);
  }

  private void scheduleNudge(String id) {
    cancelNudge(id);
    WebView view = tiles.get(id);
    if (view == null) return;
    boolean forceMute =
      audioPrimaryId == null || audioPrimaryId.isEmpty() || !id.equals(audioPrimaryId);
    // Electron scheduleMultiWebAutoplay intervals.
    boolean aggressive = forceMute;
    int[] intervals = aggressive
      ? new int[] { 350, 900, 1800, 3200 }
      : new int[] { 700, 1800 };
    final int[] clicksLeft = { aggressive ? 4 : 1 };
    ArrayList<Runnable> timers = new ArrayList<>();

    Runnable run = () -> {
      WebView v = tiles.get(id);
      if (v == null || v.getVisibility() != View.VISIBLE) return;
      v.onResume();
      resumeAllVisible();
      boolean mute =
        audioPrimaryId == null || audioPrimaryId.isEmpty() || !id.equals(audioPrimaryId);
      setPageMuted(v, mute);
      injectHelpers(v);
      v.evaluateJavascript(
        autoplayScript(mute),
        result -> {
          String r = result == null ? "" : result.toLowerCase();
          if (r.contains("already")) {
            clicksLeft[0] = 0;
            return;
          }
          // <video> present — play() only; stage taps toggle pause on Clappr/JW.
          if (r.contains("play") && !r.contains("noop")) {
            v.evaluateJavascript(
              IS_PLAYING_SCRIPT,
              playing -> {
                if (playing != null && playing.toLowerCase().contains("playing")) {
                  clicksLeft[0] = 0;
                }
              }
            );
            return;
          }
          v.evaluateJavascript(
            IS_PLAYING_SCRIPT,
            playing -> {
              if (playing != null && playing.toLowerCase().contains("playing")) {
                clicksLeft[0] = 0;
                return;
              }
              if (clicksLeft[0] > 0) {
                clicksLeft[0] -= 1;
                clickCenter(v, aggressive);
              }
            }
          );
        }
      );
    };

    run.run();
    for (int ms : intervals) {
      timers.add(run);
      main.postDelayed(run, ms);
    }
    nudgeTimers.put(id, timers);
  }

  private void cancelNudge(String id) {
    ArrayList<Runnable> timers = nudgeTimers.remove(id);
    if (timers == null) return;
    for (Runnable r : timers) main.removeCallbacks(r);
  }

  private static void clickCenter(WebView view, boolean aggressive) {
    if (view == null || view.getVisibility() != View.VISIBLE) return;
    String page = "";
    try {
      page = view.getUrl() == null ? "" : view.getUrl().toLowerCase();
    } catch (Throwable ignored) {}
    if (page.contains("challenges.cloudflare.com")
      || page.contains("cdn-cgi/challenge")
      || page.contains("__cf_chl")
      || page.contains("cf_chl_")
      || page.contains("cinetaro.to")) {
      return;
    }
    int w = view.getWidth();
    int h = view.getHeight();
    if (w < 8 || h < 8) return;
    float[][] points = aggressive
      ? new float[][] { { 0.5f, 0.42f }, { 0.5f, 0.32f }, { 0.5f, 0.55f } }
      : new float[][] { { 0.5f, 0.42f } };
    long now = SystemClock.uptimeMillis();
    for (float[] pt : points) {
      float x = Math.max(1, Math.min(w - 1, w * pt[0]));
      float y = Math.max(1, Math.min(h - 1, h * pt[1]));
      MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
      MotionEvent up = MotionEvent.obtain(now, now + 18, MotionEvent.ACTION_UP, x, y, 0);
      try {
        view.dispatchTouchEvent(down);
        view.dispatchTouchEvent(up);
      } finally {
        down.recycle();
        up.recycle();
      }
      now += 120;
    }
  }

  private static void applyDesktopHardening(WebSettings settings) {
    settings.setUserAgentString(DESKTOP_UA);
    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
        WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, Collections.emptySet());
      }
    } catch (Throwable ignored) {}
    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
        List<UserAgentMetadata.BrandVersion> brands = Arrays.asList(
          new UserAgentMetadata.BrandVersion.Builder()
            .setBrand("Not_A Brand").setMajorVersion("24").setFullVersion("10.0.2.4").build(),
          new UserAgentMetadata.BrandVersion.Builder()
            .setBrand("Chromium").setMajorVersion("131").setFullVersion(DESKTOP_CHROME_FULL).build(),
          new UserAgentMetadata.BrandVersion.Builder()
            .setBrand("Google Chrome").setMajorVersion("131").setFullVersion(DESKTOP_CHROME_FULL).build()
        );
        UserAgentMetadata meta = new UserAgentMetadata.Builder()
          .setBrandVersionList(brands)
          .setFullVersion(DESKTOP_CHROME_FULL)
          .setPlatform("Windows")
          .setPlatformVersion("15.0.0")
          .setArchitecture("x86")
          .setModel("")
          .setMobile(false)
          .setBitness(64)
          .setWow64(false)
          .build();
        WebSettingsCompat.setUserAgentMetadata(settings, meta);
      }
    } catch (Throwable ignored) {}
  }

  private static boolean needsNoRefererDocument(String url) {
    if (url == null || url.isEmpty()) return false;
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return false;
      host = host.replaceFirst("^www\\.", "").toLowerCase();
      return host.equals("embed.st")
        || host.endsWith(".embed.st")
        || host.equals("embedhd.st")
        || host.endsWith(".embedhd.st");
    } catch (Throwable t) {
      return false;
    }
  }
}
