package app.jiyu.mediacenter.browser;

import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;

import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * GeckoView-backed in-app browser surface (Electron WebContentsView stand-in).
 * Capacitor's main UI stays on Android System WebView — only this overlay uses Gecko.
 */
final class GeckoOverlayController {
  interface NavListener {
    void onNav(String url, String title, boolean canGoBack, boolean canGoForward, boolean loading);
  }

  interface EvalCallback {
    void onResult(@Nullable String jsonOrNull);
  }

  private static final String DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
  private static final String BRIDGE_ID = "jiyu-bridge@jiyu.app";
  private static final String BRIDGE_RESOURCE = "resource://android/assets/jiyu-gecko-bridge/";

  /** Mirror MultiWebHost STREAMCORNER_BOOT_JS — pick a source and hide chat. */
  static final String STREAMCORNER_BOOT_JS =
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

  /**
   * Return CSS-pixel center of the StreamCorner source card or PLAY control.
   * Used with MotionEvent taps — React ignores synthetic clicks alone.
   */
  static final String STREAMCORNER_TAP_RECT_JS =
    "(function(){try{"
      + "if(window!==window.top)return JSON.stringify({ok:false,skip:1});"
      + "var host=String(location.hostname||'').replace(/^www\\./i,'').toLowerCase();"
      + "if(!/(^|\\.)(streamcorner|strmcrnr|streamninja)\\.(st|foo|cloud|fun|top)$/i.test(host))"
      + "return JSON.stringify({ok:false,skip:1});"
      + "var vv=window.visualViewport;var vw=(vv&&vv.width)||window.innerWidth||0;"
      + "var vh=(vv&&vv.height)||window.innerHeight||0;var offX=vv?vv.offsetLeft:0;var offY=vv?vv.offsetTop:0;"
      + "function box(el,kind){if(!el)return null;try{el.scrollIntoView({block:'center',inline:'nearest'});}catch(e){}"
      + "var r=el.getBoundingClientRect();if(!r||r.width<24||r.height<18)return null;"
      + "return {ok:true,kind:kind,cx:r.left+r.width/2-offX,cy:r.top+r.height/2-offY,vw:vw,vh:vh};}"
      + "function reactClick(el){try{if(!el)return;var keys=Object.keys(el);"
      + "for(var i=0;i<keys.length;i++){"
      + "if(keys[i].indexOf('__reactProps')!==0&&keys[i].indexOf('__reactEventHandlers')!==0)continue;"
      + "var p=el[keys[i]];var fn=p&&(p.onClick||p.onPointerUp||p.onMouseDown);"
      + "if(typeof fn==='function'){fn.call(el,{bubbles:true,cancelable:true,target:el,currentTarget:el,"
      + "preventDefault:function(){},stopPropagation:function(){},nativeEvent:{}});return;}}}catch(e){}}"
      + "var vids=document.querySelectorAll('video');"
      + "for(var v=0;v<vids.length;v++){"
      + "var vid=vids[v];if((vid.currentSrc||vid.src)&&!vid.paused&&vid.readyState>=2)"
      + "return JSON.stringify({ok:true,playing:true});}"
      + "var bodyText='';try{bodyText=String((document.body&&document.body.innerText)||'');}catch(e){}"
      + "var need=/SELECT A SOURCE TO START PLAYBACK/i.test(bodyText);"
      + "function pickSource(){var root=document.body;var hs=document.querySelectorAll('h1,h2,h3,h4,div,span,p,section');"
      + "for(var h=0;h<hs.length;h++){"
      + "if(/^AVAILABLE SOURCES$/i.test(String(hs[h].textContent||'').replace(/\\s+/g,' ').trim())){"
      + "root=hs[h].parentElement||hs[h];break;}}"
      + "var nodes=(root||document).querySelectorAll('button,a,[role=button],div,li,label');"
      + "var best=null,bestA=0;"
      + "for(var j=0;j<nodes.length;j++){"
      + "var t=String(nodes[j].innerText||'').replace(/\\s+/g,' ').trim();"
      + "if(t.length<3||t.length>160)continue;"
      + "if(/AVAILABLE SOURCES|CONTROLS|Hide Chat|Float Chat|Reload Player|BITMOVIN|Loading up|"
      + "SELECT A SOURCE|STREAMCORNER CHAT|Keep it friendly|^PLAY$/i.test(t))continue;"
      + "if(!/^(HD|SD|FHD|UHD|4K)\\b/i.test(t)&&!/\\b(BEIN|ESPN|DAZN|SKY|SPORTS?|LIGUE|PREMIER|ESPA.?OL|FOX|TNT|NBC|CBS|ABC)\\b/i.test(t))continue;"
      + "var rr=nodes[j].getBoundingClientRect();if(!rr||rr.width<80||rr.height<28||rr.height>220)continue;"
      + "var a=rr.width*rr.height;if(a>bestA){best=nodes[j];bestA=a;}}"
      + "return best;}"
      + "function pickPlay(){var nodes=document.querySelectorAll('button,a,[role=button],div');"
      + "var best=null,bestA=0;"
      + "for(var i=0;i<nodes.length;i++){"
      + "var el=nodes[i];var t=String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();"
      + "var al=String(el.getAttribute('aria-label')||el.title||'');"
      + "if(!/^PLAY$/i.test(t)&&!/^play$/i.test(al))continue;"
      + "var r=el.getBoundingClientRect();if(!r||r.width<40||r.height<24)continue;"
      + "var a=r.width*r.height;if(a>bestA){best=el;bestA=a;}}return best;}"
      + "var src=pickSource();"
      + "if(need&&src){reactClick(src);var b=box(src,'source');if(b)return JSON.stringify(b);}"
      + "var play=pickPlay();"
      + "if(play){reactClick(play);var pb=box(play,'play');if(pb)return JSON.stringify(pb);}"
      + "if(src){reactClick(src);var sb=box(src,'source');if(sb)return JSON.stringify(sb);}"
      + "return JSON.stringify({ok:false});"
      + "}catch(e){return JSON.stringify({ok:false});}})()";

  /**
   * Soft Google "viral trick" notification tiles on any sports/replay embed.
   * Soft-allow still loads ad scripts so the player mounts; this only strips the overlay DOM.
   */
  private static final String REPLAY_VIRAL_SCRUB_JS =
    "(function(){try{"
      + "if(window.__jiyuViralScrub)return 'viral-bound';window.__jiyuViralScrub=1;"
      + "function looks(t){if(!t)return false;"
      + "if(/going viral|simple trick|thousands of people|why thousands|is going viral/i.test(t)&&t.length<280)return true;"
      + "if(/You received a message!?/i.test(t))return true;"
      + "if(/You have (?:a |received a )?message!?/i.test(t))return true;"
      + "if(/A Surprise Is Waiting/i.test(t)&&/OPEN\\\\s*NOW/i.test(t))return true;"
      + "return false;}"
      + "function hide(){try{"
      + "var nodes=document.querySelectorAll('div,section,aside,article');"
      + "for(var i=0;i<nodes.length;i++){var el=nodes[i];"
      + "if(!el||el.getAttribute('data-jiyu-ad-hide')==='1')continue;"
      + "if(el.querySelector&&el.querySelector('video'))continue;"
      + "var text='';try{text=String(el.innerText||el.textContent||'');}catch(e){continue;}"
      + "text=text.replace(/\\\\s+/g,' ').trim();"
      + "if(!text||text.length>360||!looks(text))continue;"
      + "var target=el;"
      + "for(var d=0;d<6&&target.parentElement;d++){"
      + "var p=target.parentElement;"
      + "if(!p||p===document.body||p===document.documentElement)break;"
      + "var st=window.getComputedStyle(p);var pos=st?String(st.position||''):'';"
      + "if(pos==='fixed'||pos==='absolute'||pos==='sticky'){target=p;break;}"
      + "var pt='';try{pt=String(p.innerText||'').replace(/\\\\s+/g,' ').trim();}catch(e){}"
      + "if(pt&&pt.length<=text.length+64&&looks(pt)){target=p;continue;}break;}"
      + "if(target.querySelector&&target.querySelector('video'))continue;"
      + "try{target.setAttribute('data-jiyu-ad-hide','1');"
      + "target.style.setProperty('display','none','important');"
      + "target.style.setProperty('visibility','hidden','important');"
      + "target.style.setProperty('pointer-events','none','important');"
      + "target.style.setProperty('opacity','0','important');"
      + "try{target.remove();}catch(e){}}catch(e){}}}"
      + "}catch(e){}}hide();"
      + "try{new MutationObserver(function(){hide();})"
      + ".observe(document.documentElement,{childList:true,subtree:true});"
      + "setInterval(hide,1500);}catch(e){}"
      + "return 'viral-ok';}catch(e){return 'viral-err'}})();";

  /**
   * Playmogo / DoodStream: soft-allow Google ads so the player mounts, then scrub
   * visual creatives (anime interstitial, viral banners, network-error card) and kick play.
   * Mirrors electron scheduleBrowserAdShield playmogo scrub + PLAYMOGO_CLEANUP_SCRIPT.
   */
  private static final String PLAYMOGO_BOOT_JS =
    "(function(){try{"
      + "var h=String(location.hostname||'').replace(/^www\\./i,'').toLowerCase();"
      + "var path=String(location.pathname||'');"
      + "var on=h==='playmogo.com'||h.indexOf('.playmogo.com')>=0"
      + "||(/^\\/e\\/[a-z0-9]{6,}/i.test(path)&&/(playmogo|dood)/i.test(h));"
      + "if(!on)return 'pm-none';"
      + "if(window.__jiyuPmClean)return 'pm-bound';window.__jiyuPmClean=1;"
      + "function hide(el){try{if(!el||el.getAttribute('data-jiyu-pm')==='1')return;"
      + "el.setAttribute('data-jiyu-pm','1');"
      + "el.style.setProperty('display','none','important');"
      + "el.style.setProperty('visibility','hidden','important');"
      + "el.style.setProperty('pointer-events','none','important');"
      + "el.style.setProperty('opacity','0','important');"
      + "try{el.remove();}catch(e){}}catch(e){}}"
      + "function looks(el){try{"
      + "var st=window.getComputedStyle(el);if(!st)return false;"
      + "var pos=String(st.position||'');if(pos!=='fixed'&&pos!=='absolute'&&pos!=='sticky')return false;"
      + "var r=el.getBoundingClientRect();if(r.width<100||r.height<80)return false;"
      + "if(el.querySelector&&el.querySelector('video'))return false;"
      + "var t=String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();"
      + "var hasPlay=/^\\s*play\\s*$/i.test(t)||(/\\bplay\\b/i.test(t)&&t.length<48);"
      + "var hasImg=!!(el.querySelector&&el.querySelector('img,canvas,picture'));"
      + "if(hasPlay&&hasImg)return true;"
      + "if(/get\\s*link|continue|click\\s*here|download\\s*now/i.test(t)&&r.width>Math.min(280,window.innerWidth*0.35))return true;"
      + "if(/getlink|get-link|dlbutton|downloadn/i.test(String(el.id||'')+' '+String(el.className||'')))return true;"
      + "if(/going viral|simple trick|thousands of people|why thousands|is going viral/i.test(t)&&r.width>140)return true;"
      + "if(hasImg&&r.width>=Math.min(180,window.innerWidth*0.42)&&r.height>=Math.min(160,window.innerHeight*0.28)"
      + "&&r.left<window.innerWidth*0.75&&r.top<window.innerHeight*0.85&&t.length<80)return true;"
      + "return false;}catch(e){return false;}}"
      + "function scrub(){try{"
      + "if(!document.getElementById('jiyu-pm-hide')){var css=document.createElement('style');css.id='jiyu-pm-hide';"
      + "css.textContent='iframe[src*=\"googlesyndication\"],iframe[src*=\"doubleclick\"],iframe[src*=\"googleadservices\"],"
      + "iframe[id*=\"google_ads\"],ins.adsbygoogle,[id*=\"google_ads_iframe\"],[class*=\"adsbygoogle\"]{"
      + "display:none!important;visibility:hidden!important;pointer-events:none!important;width:0!important;height:0!important;opacity:0!important;}';"
      + "(document.head||document.documentElement).appendChild(css);}"
      + "var nodes=document.querySelectorAll('div,section,aside,a,button,ins,iframe');"
      + "for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!el||el.getAttribute('data-jiyu-pm')==='1')continue;"
      + "var idc=(String(el.id||'')+' '+String(el.className||'')).toLowerCase();"
      + "if(/getlink|get-link|dlbutton|downloadn|pop-under|popunder|ol-ads|adsbygoogle|google_ads/.test(idc)){hide(el);continue;}"
      + "try{var src=String(el.getAttribute&&el.getAttribute('src')||el.src||'');"
      + "if(/googlesyndication|doubleclick|googleadservices|pagead\\/html/i.test(src)){hide(el);continue;}}catch(e){}"
      + "var txt=String(el.innerText||'').replace(/\\s+/g,' ').trim();"
      + "if(/Network error!?\\s*Please reload/i.test(txt)&&txt.length<220){hide(el);continue;}"
      + "if(looks(el))hide(el);}"
      + "var vids=document.querySelectorAll('video');"
      + "for(var v=0;v<vids.length;v++){var video=vids[v];if(!video)continue;"
      + "if(video.error||video.networkState===3){try{video.load();}catch(e){}}"
      + "if(video.paused){try{var p=video.play();if(p&&p.catch)p.catch(function(){});}catch(e){}}}"
      + "}catch(e){}}"
      + "scrub();"
      + "try{new MutationObserver(function(){scrub();}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}"
      + "setInterval(scrub,1500);"
      + "return 'pm-ok';}catch(e){return 'pm-err'}})();";

  private static GeckoRuntime sRuntime;
  private static WebExtension sBridgeExtension;

  private final Context appContext;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final AtomicLong evalSeq = new AtomicLong(1);
  private final Map<Long, EvalCallback> pendingEval = new HashMap<>();

  private GeckoView view;
  /** Black cover over Gecko until the first page paints (empty compositor is white). */
  @Nullable private View loadCover;
  private GeckoSession session;
  private FrameLayout.LayoutParams layoutParams;
  private NavListener navListener;
  private final java.util.concurrent.CopyOnWriteArrayList<WebExtension.Port> bridgePorts =
    new java.util.concurrent.CopyOnWriteArrayList<>();
  private final Map<Long, Integer> pendingEvalExpect = new HashMap<>();
  private final Map<Long, String> pendingEvalBest = new HashMap<>();
  private final java.util.ArrayList<PendingEval> bridgeQueue = new java.util.ArrayList<>();
  private String currentUrl = "";
  /** Last known player/embed URL — restore if an ad hijacks the top-level document. */
  private String lastPlayerEmbedUrl = "";
  /** How many times the current embed bounced onto atlantic.st / movy.sx. */
  private int streamRefererBounces = 0;
  /** Cover stays up while that error page is the committed document. */
  private boolean coveringStreamReferer = false;
  private long streamRefererLeaveAt = 0;
  /** Page starts minus stops, so an older error page cannot drop the cover. */
  private int pageLoadsInFlight = 0;
  private String lastStartedUrl = "";
  /** URL we already sent the start taps for. Buffering must not tap again. */
  private String playTapUrl = "";
  private String currentTitle = "";
  private boolean canGoBack;
  private boolean canGoForward;
  private boolean loading;
  @Nullable private Runnable pageStopListener;
  /** Active embed→media URL probe (Media3 path). */
  @Nullable private MediaResolveProbe mediaProbe;
  /** Last sniffable playlist/segment seen while a sports page is open (late Media3 promote). */
  @Nullable private String lastLiveMediaUrl = "";
  @Nullable private String lastLiveMediaPage = "";

  interface MediaResolveCallback {
    void onResult(@Nullable String mediaUrl, @Nullable String pageUrl, @Nullable String error);
  }

  /** Shared scrape used by Media3 unwrap polls and sniffCurrentMedia. */
  static final String MEDIA_SNIFF_JS =
    "(() => {try{"
      + "if(!window.__jiyuMediaHook){"
      + "window.__jiyuMediaHook=1;window.__jiyuMediaHits=[];"
      + "const push=u=>{try{const s=String(u||'');"
      + "if(/m3u8|\\.mpd|format=m3u8|\\/hls\\/|\\.m4s|mime=video/i.test(s))"
      + "window.__jiyuMediaHits.push(s);}catch(e){}};"
      + "const of=window.fetch;if(typeof of==='function'){"
      + "window.fetch=function(i,n){try{push(i&&i.url?i.url:i);}catch(e){}"
      + "return of.apply(this,arguments);};}"
      + "const xo=XMLHttpRequest.prototype.open;"
      + "XMLHttpRequest.prototype.open=function(m,u){try{push(u);}catch(e){}"
      + "return xo.apply(this,arguments);};"
      + "try{const po=new PerformanceObserver(function(list){"
      + "list.getEntries().forEach(function(e){push(e&&e.name);});});"
      + "po.observe({type:'resource',buffered:true});}catch(e){}"
      + "}"
      + "const urls=[...(window.__jiyuMediaHits||[])];"
      + "window.__jiyuMediaHits=[];"
      + "document.querySelectorAll('video').forEach(v=>{"
      + "if(v.currentSrc)urls.push(v.currentSrc);if(v.src)urls.push(v.src);"
      + "v.querySelectorAll('source').forEach(s=>{if(s.src)urls.push(s.src);});"
      + "});"
      + "try{performance.getEntriesByType('resource').forEach(function(e){"
      + "if(e&&e.name)urls.push(e.name);});}catch(e){}"
      + "try{const html=String(document.documentElement&&document.documentElement.innerHTML||'');"
      + "const re=/https?:\\\\/\\\\/[^\\\\s\"'<>]+\\\\.m3u8[^\\\\s\"'<>]*/gi;let m;"
      + "while((m=re.exec(html)))urls.push(m[0]);}catch(e){}"
      // Bitmovin Player API (StreamCorner) — getSource().hls after playback starts.
      + "try{if(window.bitmovin&&window.bitmovin.player){"
      + "document.querySelectorAll('[id]').forEach(function(el){"
      + "try{const p=window.bitmovin.player(el.id);if(!p||typeof p.getSource!=='function')return;"
      + "const s=p.getSource();if(!s)return;"
      + "if(s.hls)urls.push(String(s.hls));if(s.dash)urls.push(String(s.dash));"
      + "const pr=s.progressive;const list=Array.isArray(pr)?pr:(pr?[pr]:[]);"
      + "list.forEach(function(x){if(x&&x.url)urls.push(String(x.url));});"
      + "}catch(e){}});}}catch(e){}"
      + "return urls.filter(Boolean).slice(0,24).join('\\n');"
      + "}catch(e){return '';}})()";


  private static final class MediaResolveProbe {
    final String pageUrl;
    final long deadlineMs;
    final MediaResolveCallback callback;
    @Nullable String bestMediaUrl;
    boolean finished;
    int pollCount;

    MediaResolveProbe(String pageUrl, long timeoutMs, MediaResolveCallback callback) {
      this.pageUrl = pageUrl;
      this.deadlineMs = System.currentTimeMillis() + Math.max(3000, timeoutMs);
      this.callback = callback;
    }
  }

  private static final class PendingEval {
    final long id;
    final String code;
    @Nullable final EvalCallback callback;

    PendingEval(long id, String code, @Nullable EvalCallback callback) {
      this.id = id;
      this.code = code;
      this.callback = callback;
    }
  }

  GeckoOverlayController(Context context) {
    this.appContext = context.getApplicationContext();
  }

  void setNavListener(NavListener listener) {
    this.navListener = listener;
  }

  void setPageStopListener(@Nullable Runnable listener) {
    this.pageStopListener = listener;
  }

  GeckoView getView() {
    return view;
  }

  FrameLayout.LayoutParams getLayoutParams() {
    return layoutParams;
  }

  String getCurrentUrl() {
    return currentUrl;
  }

  String getCurrentTitle() {
    return currentTitle;
  }

  boolean canGoBack() {
    return canGoBack;
  }

  boolean canGoForward() {
    return canGoForward;
  }

  boolean isLoading() {
    return loading;
  }

  int getVisibility() {
    return view == null ? View.GONE : view.getVisibility();
  }

  int getWidth() {
    return view == null ? 0 : view.getWidth();
  }

  int getHeight() {
    return view == null ? 0 : view.getHeight();
  }

  boolean dispatchTouchEvent(MotionEvent event) {
    if (view == null || session == null || event == null) return false;
    boolean handled = false;
    try {
      session.getPanZoomController().onTouchEvent(event);
      handled = true;
    } catch (Throwable ignored) {}
    try {
      // Also hit the view — some players only see View touch delivery.
      if (view.dispatchTouchEvent(MotionEvent.obtain(event))) handled = true;
    } catch (Throwable ignored) {}
    return handled;
  }

  /** Normalized 0–1 point inside this GeckoView. One DOWN/UP pair, trusted by the page. */
  void tapAt(float normX, float normY) {
    tapAt(view, session, normX, normY, 1);
  }

  /**
   * Same tap, aimed at a multiview tile. The tile has its own session, so the
   * overlay view would miss the play button.
   */
  void tapAt(GeckoView target, GeckoSession targetSession, float normX, float normY) {
    tapAt(target, targetSession, normX, normY, 1);
  }

  /**
   * These embeds ignore a single tap. The second tap is the same point, 0.8s later.
   */
  /** A newly chosen title may be tapped again. Player redirects must not re-arm taps. */
  void noteUserNavigation() {
    playTapsSent = false;
    playTapUrl = "";
    playTapBudgetUrl = "";
    playTapCount = 0;
    playBlindTaps = 0;
    playWatchGen = 0;
    cornerKickGen++;
  }

  void tapTwice(float normX, float normY) {
    // Only a confirmed-playing answer marks the URL done (see finishPlayButtonTap);
    // marking it here stopped every later, play-state-checked look on this page.
    playTapsSent = true;
    dispatchTap(view, session, normX, normY);
    main.postDelayed(() -> {
      if (view == null || view.getVisibility() != View.VISIBLE) return;
      dispatchTap(view, session, normX, normY);
    }, 800);
  }

  private void tapAt(
    GeckoView target,
    GeckoSession targetSession,
    float normX,
    float normY,
    int times
  ) {
    dispatchTap(target, targetSession, normX, normY);
    if (times < 2 || target == null) return;
    main.postDelayed(() -> dispatchTap(target, targetSession, normX, normY), 800);
  }

  private void dispatchTap(GeckoView target, GeckoSession targetSession, float normX, float normY) {
    if (target == null || targetSession == null) return;
    int w = target.getWidth();
    int h = target.getHeight();
    if (w < 8 || h < 8) return;
    float nx = Math.max(0f, Math.min(1f, normX));
    float ny = Math.max(0f, Math.min(1f, normY));
    float x = Math.max(1f, Math.min(w - 1f, w * nx));
    float y = Math.max(1f, Math.min(h - 1f, h * ny));
    // PanZoom uses getRawX()-getX() as the view's screen origin. A plain
    // obtain() leaves that at 0, so the hit slides to the top-left of the page.
    int[] origin = new int[2];
    target.getLocationOnScreen(origin);
    long now = android.os.SystemClock.uptimeMillis();
    MotionEvent down = obtainViewTap(x, y, origin[0], origin[1], now, now);
    MotionEvent up = obtainViewTap(x, y, origin[0], origin[1], now, now + 18);
    try {
      // GeckoView.onTouchEvent already forwards this to PanZoom. A second direct
      // PanZoom call is another click, and that extra click pauses a stream the
      // first click just started.
      MotionEvent viewDown = MotionEvent.obtain(down);
      target.dispatchTouchEvent(viewDown);
      viewDown.recycle();
      MotionEvent viewUp = MotionEvent.obtain(up);
      target.dispatchTouchEvent(viewUp);
      viewUp.recycle();
    } catch (Throwable ignored) {
    } finally {
      down.recycle();
      up.recycle();
    }
  }

  private static MotionEvent obtainViewTap(
    float viewX,
    float viewY,
    int screenX,
    int screenY,
    long downTime,
    long eventTime
  ) {
    MotionEvent event =
      MotionEvent.obtain(
        downTime,
        eventTime,
        eventTime == downTime ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP,
        viewX + screenX,
        viewY + screenY,
        0
      );
    event.offsetLocation(-screenX, -screenY);
    event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  void setLayoutParams(FrameLayout.LayoutParams lp) {
    layoutParams = lp;
    if (view != null) view.setLayoutParams(lp);
    if (loadCover != null) {
      FrameLayout.LayoutParams coverLp = new FrameLayout.LayoutParams(lp);
      loadCover.setLayoutParams(coverLp);
    }
  }

  void ensureAttached(FrameLayout parent) {
    if (view != null) return;

    ensureRuntime(appContext);
    openFreshSession();

    view = new GeckoView(parent.getContext());
    view.setSession(session);
    view.setBackgroundColor(Color.BLACK);
    layoutParams =
      new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      );
    view.setLayoutParams(layoutParams);
    view.setVisibility(View.GONE);
    TvPointer.prepareOverlayView(view);
    parent.addView(view);

    loadCover = new View(parent.getContext());
    loadCover.setBackgroundColor(Color.BLACK);
    loadCover.setLayoutParams(new FrameLayout.LayoutParams(layoutParams));
    loadCover.setVisibility(View.GONE);
    loadCover.setClickable(false);
    parent.addView(loadCover);

    installBridge(session);
  }

  void setVisibility(int visibility) {
    if (view != null) view.setVisibility(visibility);
    if (loadCover != null) {
      // Cover only while loading and the surface is meant to be seen.
      if (visibility == View.VISIBLE && loading) {
        loadCover.setVisibility(View.VISIBLE);
      } else if (visibility != View.VISIBLE) {
        loadCover.setVisibility(View.GONE);
      }
    }
  }

  private void showLoadCover(boolean show) {
    if (loadCover == null) return;
    if (show) {
      if (view != null && view.getVisibility() == View.VISIBLE) {
        loadCover.setVisibility(View.VISIBLE);
        // Safety: never leave the cover forever if onPageStop never fires.
        main.removeCallbacks(hideLoadCoverRunnable);
        main.postDelayed(hideLoadCoverRunnable, 12_000);
      }
    } else {
      main.removeCallbacks(hideLoadCoverRunnable);
      loadCover.setVisibility(View.GONE);
    }
  }

  private final Runnable hideLoadCoverRunnable = () -> showLoadCover(false);

  /** Build delegates + open a new GeckoSession (view may already exist). */
  private void openFreshSession() {
    ensureRuntime(appContext);

    GeckoSessionSettings sessionSettings =
      new GeckoSessionSettings.Builder()
        .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
        .userAgentOverride(DESKTOP_UA)
        .allowJavascript(true)
        .suspendMediaWhenInactive(false)
        .build();

    session = new GeckoSession(sessionSettings);
    installSessionDelegates(session);
    session.open(sRuntime);
  }

  /** Single-stream delegates (permissions, nav, progress, history) for {@code target}. */
  private void installSessionDelegates(GeckoSession target) {
    // Without this, Clappr/JW stay in "Idle" — Gecko blocks audible autoplay by default.
    target.setPermissionDelegate(
      new GeckoSession.PermissionDelegate() {
        @Override
        public GeckoResult<Integer> onContentPermissionRequest(
          GeckoSession s,
          ContentPermission perm
        ) {
          if (perm == null) {
            return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
          }
          int p = perm.permission;
          if (p == PERMISSION_AUTOPLAY_AUDIBLE
            || p == PERMISSION_AUTOPLAY_INAUDIBLE
            || p == PERMISSION_MEDIA_KEY_SYSTEM_ACCESS) {
            return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
          }
          // Don't prompt for geo/notifications inside the overlay.
          return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
        }
      }
    );
    // Workaround for Bug 1758212
    target.setContentDelegate(
      new GeckoSession.ContentDelegate() {
        @Override
        public void onTitleChange(GeckoSession s, String title) {
          currentTitle = title != null ? title : "";
          emitNav();
        }

        // Android kills Gecko's content process while Jiyu sits in the background.
        // GeckoView then closes the session, but the field stayed non-null, so every
        // later load/unwrap went nowhere until Jiyu was restarted.
        @Override
        public void onCrash(GeckoSession s) {
          main.post(() -> recoverDeadSession(s, "crash"));
        }

        @Override
        public void onKill(GeckoSession s) {
          main.post(() -> recoverDeadSession(s, "kill"));
        }
      }
    );
    target.setProgressDelegate(
      new GeckoSession.ProgressDelegate() {
        @Override
        public void onPageStart(GeckoSession s, String url) {
          loading = true;
          pageLoadsInFlight += 1;
          lastStartedUrl = url != null ? url : "";
          // A committed atlantic.st / movy.sx document is the blue error page.
          // Keep the cover up and leave it; do not adopt it as the current page.
          if (url != null && BrowserAdBlock.shouldBlockNavigation(url)) {
            coveringStreamReferer = true;
            showLoadCover(true);
            leaveStreamRefererDocument(url, "page-start");
            return;
          }
          coveringStreamReferer = false;
          if (url != null && !url.isEmpty()) currentUrl = url;
          emitNav();
        }

        @Override
        public void onPageStop(GeckoSession s, boolean success) {
          loading = false;
          pageLoadsInFlight = Math.max(0, pageLoadsInFlight - 1);
          String live = currentUrl != null ? currentUrl : "";
          // An older atlantic.st stop must not uncover the page while the
          // restore load is still starting.
          if (pageLoadsInFlight > 0) return;
          if (coveringStreamReferer || BrowserAdBlock.shouldBlockNavigation(lastStartedUrl)
            || BrowserAdBlock.shouldBlockNavigation(live)) {
            showLoadCover(true);
            return;
          }
          streamRefererBounces = 0;
          showLoadCover(false);
          emitNav();
          if (live.contains("streamcorner") || live.contains("strmcrnr") || live.contains("streamninja")) {
            // SPA mounts sources late; keep boot + native source/PLAY taps alive.
            // Install media hooks early so Bitmovin HLS URLs are caught for Media3 promote.
            main.post(() -> {
              evaluateJavascript(MEDIA_SNIFF_JS, null);
              evaluateJavascript(STREAMCORNER_BOOT_JS, null);
              kickStreamCornerPlayback();
            });
            main.postDelayed(() -> evaluateJavascript(STREAMCORNER_BOOT_JS, null), 800);
            main.postDelayed(() -> {
              evaluateJavascript(MEDIA_SNIFF_JS, null);
              evaluateJavascript(STREAMCORNER_BOOT_JS, null);
            }, 2000);
            main.postDelayed(() -> evaluateJavascript(STREAMCORNER_BOOT_JS, null), 4500);
          }
          if (
            BrowserAdBlock.isPlayerEmbedHost(live)
              || BrowserAdBlock.isReplayAdSensitiveUrl(live)
          ) {
            main.post(() -> evaluateJavascript(REPLAY_VIRAL_SCRUB_JS, null));
            main.postDelayed(() -> evaluateJavascript(REPLAY_VIRAL_SCRUB_JS, null), 900);
            main.postDelayed(() -> evaluateJavascript(REPLAY_VIRAL_SCRUB_JS, null), 2500);
          }
          if (isPlaymogoUrl(live)) {
            main.post(() -> evaluateJavascript(PLAYMOGO_BOOT_JS, null));
            main.postDelayed(() -> evaluateJavascript(PLAYMOGO_BOOT_JS, null), 800);
            main.postDelayed(() -> evaluateJavascript(PLAYMOGO_BOOT_JS, null), 2200);
          }
          if (pageStopListener != null) {
            Runnable listener = pageStopListener;
            main.post(listener);
          }
          if (playTapAfterLoad) {
            playTapAfterLoad = false;
            Runnable pending = playTapAfterLoadDone;
            playTapAfterLoadDone = null;
            main.post(() -> tapPlayButton(pending));
          }
        }
      }
    );
    target.setNavigationDelegate(
      new GeckoSession.NavigationDelegate() {
        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(
          GeckoSession s,
          GeckoSession.NavigationDelegate.LoadRequest request
        ) {
          if (request == null) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
          String uri = request.uri;
          noteMediaCandidate(uri);
          // During Media3 unwrap, capture playlist navigations without leaving the embed.
          if (mediaProbe != null && !mediaProbe.finished && isSniffableMediaUrl(uri)) {
            return GeckoResult.fromValue(AllowOrDeny.DENY);
          }
          if (BrowserAdBlock.isExternalAppScheme(uri)) {
            android.util.Log.w("JiyuGecko", "denied external scheme " + safeUrl(uri));
            restorePlayerEmbedIfNeeded("external-scheme");
            return GeckoResult.fromValue(AllowOrDeny.DENY);
          }
          String softPage =
            BrowserAdBlock.isReplayAdSensitiveUrl(currentUrl)
              ? currentUrl
              : lastPlayerEmbedUrl;
          if (
            BrowserAdBlock.shouldBlockNavigation(uri)
              && !BrowserAdBlock.softAllowAdOnReplayPage(softPage, uri)
          ) {
            android.util.Log.w("JiyuGecko", "denied ad/hijack nav " + safeUrl(uri));
            restorePlayerEmbedIfNeeded("blocked-nav");
            return GeckoResult.fromValue(AllowOrDeny.DENY);
          }
          // Top-level leave from a locked player/embed (sports) → adware landing pages.
          boolean topLevel =
            request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_CURRENT
              || request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW
              || request.isDirectNavigation;
          String lockedFrom =
            BrowserAdBlock.isPlayerEmbedHost(currentUrl)
              ? currentUrl
              : lastPlayerEmbedUrl;
          if (topLevel
            && BrowserAdBlock.isPlayerEmbedHost(lockedFrom)
            && !BrowserAdBlock.isAllowedPlayerNav(lockedFrom, uri)
            && !BrowserAdBlock.softAllowAdOnReplayPage(lockedFrom, uri)) {
            android.util.Log.w("JiyuGecko", "denied embed hijack " + safeUrl(uri));
            restorePlayerEmbedIfNeeded("embed-hijack");
            return GeckoResult.fromValue(AllowOrDeny.DENY);
          }
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }

        @Override
        public GeckoResult<AllowOrDeny> onSubframeLoadRequest(
          GeckoSession s,
          GeckoSession.NavigationDelegate.LoadRequest request
        ) {
          if (request != null) {
            noteMediaCandidate(request.uri);
            if (BrowserAdBlock.isExternalAppScheme(request.uri)) {
              android.util.Log.w("JiyuGecko", "denied subframe external scheme " + safeUrl(request.uri));
              return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
            String softPage =
              BrowserAdBlock.isReplayAdSensitiveUrl(currentUrl)
                ? currentUrl
                : lastPlayerEmbedUrl;
            if (
              BrowserAdBlock.shouldBlockNavigation(request.uri)
                && !BrowserAdBlock.softAllowAdOnReplayPage(softPage, request.uri)
            ) {
            android.util.Log.w("JiyuGecko", "denied subframe ad " + safeUrl(request.uri));
            return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
          }
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }

        @Override
        public GeckoResult<GeckoSession> onNewSession(GeckoSession s, String uri) {
          // Sports embeds open adware as window.open / tabup — never spawn a session.
          android.util.Log.w("JiyuGecko", "denied popup session " + safeUrl(uri));
          return GeckoResult.fromValue(null);
        }

        @Override
        public void onLocationChange(
          GeckoSession s,
          String url,
          java.util.List<GeckoSession.PermissionDelegate.ContentPermission> perms,
          Boolean hasUserGesture
        ) {
          if (url != null && !url.isEmpty()) {
            // Top-level hijacks onto ad domains always restore — soft Google-ads
            // allow is only for subframe/script loads while staying on the player.
            if (BrowserAdBlock.shouldBlockNavigation(url)) {
              android.util.Log.w("JiyuGecko", "restore after location hijack " + safeUrl(url));
              showLoadCover(true);
              leaveStreamRefererDocument(url, "location");
              return;
            }
            currentUrl = url;
            if (BrowserAdBlock.isPlayerEmbedHost(url)) {
              lastPlayerEmbedUrl = url;
            }
            emitNav();
          }
        }

        @Override
        public void onCanGoBack(GeckoSession s, boolean value) {
          canGoBack = value;
          main.post(GeckoOverlayController.this::emitNav);
        }

        @Override
        public void onCanGoForward(GeckoSession s, boolean value) {
          canGoForward = value;
          main.post(GeckoOverlayController.this::emitNav);
        }
      }
    );
    target.setHistoryDelegate(
      new GeckoSession.HistoryDelegate() {
        @Override
        public void onHistoryStateChange(
          GeckoSession s,
          GeckoSession.HistoryDelegate.HistoryList history
        ) {
          if (history == null) return;
          int index = history.getCurrentIndex();
          int count = history.size();
          canGoBack = index > 0;
          canGoForward = count > 0 && index < count - 1;
          main.post(GeckoOverlayController.this::emitNav);
        }
      }
    );

  }

  /**
   * Multiview collapsed to one stream: adopt that tile's live session as the
   * single-stream session (no reload). Returns false if the view refused it.
   */
  boolean adoptSession(GeckoSession adopted, String url) {
    if (adopted == null || view == null) return false;
    GeckoSession old = session;
    if (old != null && old != adopted) {
      try {
        old.setActive(false);
      } catch (Throwable ignored) {}
      try {
        view.releaseSession();
      } catch (Throwable ignored) {}
      try {
        old.close();
      } catch (Throwable ignored) {}
    }
    session = adopted;
    bridgePorts.clear();
    try {
      installSessionDelegates(adopted);
      adopted.setMediaSessionDelegate(null);
    } catch (Throwable ignored) {}
    try {
      view.setSession(adopted);
    } catch (Throwable t) {
      try {
        adopted.close();
      } catch (Throwable ignored) {}
      session = null;
      ensureSession();
      return false;
    }
    installBridge(adopted);
    try {
      adopted.setActive(true);
    } catch (Throwable ignored) {}
    String live = url == null ? "" : url;
    currentUrl = live;
    if (BrowserAdBlock.isPlayerEmbedHost(live)) lastPlayerEmbedUrl = live;
    loading = false;
    main.removeCallbacks(hideLoadCoverRunnable);
    showLoadCover(false);
    emitNav();
    return true;
  }

  /**
   * A second session on the same runtime, for one multiview tile.
   * Does not replace the single-stream session attached to the overlay view.
   */
  GeckoSession openTileSession(
    org.mozilla.geckoview.MediaSession.Delegate mediaDelegate,
    java.util.function.BooleanSupplier blockAudible
  ) {
    ensureRuntime(appContext);
    boolean silentAtOpen = false;
    try {
      silentAtOpen = blockAudible != null && blockAudible.getAsBoolean();
    } catch (Throwable ignored) {}
    // A fresh context id on every tile disables the HTTP cache, so the player
    // JS is downloaded from scratch and the play button shows up very late.
    // The audible tile stays in the default context (same cache as the stream
    // just watched). The silent tile uses one stable context so a stored
    // autoplay deny cannot stick to the audible origin.
    GeckoSessionSettings.Builder settings =
      new GeckoSessionSettings.Builder()
        .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
        .userAgentOverride(DESKTOP_UA)
        .allowJavascript(true)
        .suspendMediaWhenInactive(false);
    if (silentAtOpen) settings.contextId("jiyu-silent");
    GeckoSessionSettings sessionSettings = settings.build();
    GeckoSession tile = new GeckoSession(sessionSettings);
    tile.setNavigationDelegate(
      new GeckoSession.NavigationDelegate() {
        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(
          GeckoSession s,
          GeckoSession.NavigationDelegate.LoadRequest request
        ) {
          if (request != null) {
            String page = currentUrl != null && !currentUrl.isEmpty() ? currentUrl : lastPlayerEmbedUrl;
            if (
              BrowserAdBlock.shouldBlockNavigation(request.uri)
                && !BrowserAdBlock.softAllowAdOnReplayPage(page, request.uri)
            ) {
              android.util.Log.w("JiyuGecko", "denied tile stream-referer " + safeUrl(request.uri));
              return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
            if (BrowserAdBlock.isExternalAppScheme(request.uri)) {
              return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
          }
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }

        @Override
        public GeckoResult<AllowOrDeny> onSubframeLoadRequest(
          GeckoSession s,
          GeckoSession.NavigationDelegate.LoadRequest request
        ) {
          if (request != null) {
            if (BrowserAdBlock.isExternalAppScheme(request.uri)) {
              return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
            String page = currentUrl != null && !currentUrl.isEmpty() ? currentUrl : lastPlayerEmbedUrl;
            if (
              BrowserAdBlock.shouldBlockNavigation(request.uri)
                && !BrowserAdBlock.softAllowAdOnReplayPage(page, request.uri)
            ) {
              return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
          }
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }
      }
    );
    tile.setPermissionDelegate(
      new GeckoSession.PermissionDelegate() {
        @Override
        public GeckoResult<Integer> onContentPermissionRequest(
          GeckoSession s,
          ContentPermission perm
        ) {
          if (perm == null) return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
          int p = perm.permission;
          if (p == PERMISSION_AUTOPLAY_INAUDIBLE || p == PERMISSION_MEDIA_KEY_SYSTEM_ACCESS) {
            return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
          }
          if (p == PERMISSION_AUTOPLAY_AUDIBLE) {
            boolean block = false;
            try {
              block = blockAudible != null && blockAudible.getAsBoolean();
            } catch (Throwable ignored) {}
            // A silent tile may paint, but it must not open an audible stream.
            return GeckoResult.fromValue(
              block ? ContentPermission.VALUE_DENY : ContentPermission.VALUE_ALLOW
            );
          }
          return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
        }
      }
    );
    if (mediaDelegate != null) tile.setMediaSessionDelegate(mediaDelegate);
    tile.open(sRuntime);
    try {
      tile.setActive(true);
    } catch (Throwable ignored) {}
    return tile;
  }

  private static synchronized void ensureRuntime(Context appContext) {
    if (sRuntime != null) return;
    BrowserAdBlock.init(appContext);
    // GV 140 has no Builder.*Pref — ship autoplay prefs via config file so
    // PermissionDelegate actually receives AUTOPLAY_* requests (else Clappr stays Idle).
    String configPath = null;
    try {
      java.io.File cfg = new java.io.File(appContext.getFilesDir(), "jiyu-geckoview-config.yaml");
      String body =
        "prefs:\n"
          + "  media.geckoview.autoplay.request: true\n"
          + "  media.autoplay.default: 0\n";
      java.nio.file.Files.write(
        cfg.toPath(),
        body.getBytes(java.nio.charset.StandardCharsets.UTF_8)
      );
      configPath = cfg.getAbsolutePath();
    } catch (Throwable ignored) {}
    GeckoRuntimeSettings.Builder builder =
      new GeckoRuntimeSettings.Builder()
        .javaScriptEnabled(true)
        .consoleOutput(false);
    if (configPath != null) {
      builder.configFilePath(configPath);
    }
    sRuntime = GeckoRuntime.create(appContext, builder.build());
  }

  private void installBridge(GeckoSession target) {
    if (sRuntime == null) return;
    GeckoResult<WebExtension> result =
      sBridgeExtension != null
        ? GeckoResult.fromValue(sBridgeExtension)
        : sRuntime.getWebExtensionController().ensureBuiltIn(BRIDGE_RESOURCE, BRIDGE_ID);

    result.accept(
      extension -> {
        if (extension == null) return;
        sBridgeExtension = extension;
        try {
          target
            .getWebExtensionController()
            .setMessageDelegate(
              extension,
              new WebExtension.MessageDelegate() {
                @Override
                public void onConnect(WebExtension.Port port) {
                  bridgePorts.add(port);
                  port.setDelegate(
                    new WebExtension.PortDelegate() {
                      @Override
                      public void onPortMessage(Object message, WebExtension.Port port) {
                        if (isPlayButtonRect(message)) {
                          main.post(() -> onPlayButtonRect(message));
                          return;
                        }
                        handleBridgeMessage(message);
                      }

                      @Override
                      public void onDisconnect(WebExtension.Port port) {
                        bridgePorts.remove(port);
                      }
                    }
                  );
                  flushBridgeQueue();
                }
              },
              "jiyu"
            );
        } catch (Throwable ignored) {}
      },
      e -> {}
    );
  }

  /**
   * Tell every frame of this tile whether it is the silent one.
   * The delegate is attached before the embed loads, so document_start can mute
   * the player before it requests audio focus.
   */
  void bindTileAudio(
    GeckoSession target,
    java.util.List<WebExtension.Port> ports,
    java.util.function.BooleanSupplier muted,
    Runnable ready,
    java.util.function.Consumer<Object> onMessage
  ) {
    if (sRuntime == null || target == null) {
      if (ready != null) ready.run();
      return;
    }
    GeckoResult<WebExtension> result =
      sBridgeExtension != null
        ? GeckoResult.fromValue(sBridgeExtension)
        : sRuntime.getWebExtensionController().ensureBuiltIn(BRIDGE_RESOURCE, BRIDGE_ID);
    result.accept(
      extension -> {
        if (extension == null) {
          if (ready != null) ready.run();
          return;
        }
        sBridgeExtension = extension;
        try {
          target
            .getWebExtensionController()
            .setMessageDelegate(
              extension,
              new WebExtension.MessageDelegate() {
                @Override
                public void onConnect(WebExtension.Port port) {
                  ports.add(port);
                  port.setDelegate(
                    new WebExtension.PortDelegate() {
                      @Override
                      public void onPortMessage(Object message, WebExtension.Port port) {
                        if (isTileAudioQuery(message)) {
                          postTileAudio(port, muted.getAsBoolean());
                          return;
                        }
                        if (onMessage != null) onMessage.accept(message);
                      }

                      @Override
                      public void onDisconnect(WebExtension.Port port) {
                        ports.remove(port);
                      }
                    }
                  );
                  final boolean silent = muted.getAsBoolean();
                  main.post(() -> postTileAudio(port, silent));
                }
              },
              "jiyu"
            );
        } catch (Throwable ignored) {}
        if (ready != null) ready.run();
      },
      e -> {
        if (ready != null) ready.run();
      }
    );
  }

  private static boolean isTileAudioQuery(Object message) {
    try {
      if (message instanceof JSONObject) {
        return "tileAudioQuery".equals(((JSONObject) message).optString("action"));
      }
      if (message instanceof Map) {
        return "tileAudioQuery".equals(String.valueOf(((Map<?, ?>) message).get("action")));
      }
    } catch (Throwable ignored) {}
    return false;
  }

  static void postTileAudio(WebExtension.Port port, boolean muted) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "tileAudio");
      msg.put("muted", muted);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  private int cornerKickGen;
  private static final int CORNER_KICK_MAX = 36;
  private static final int CORNER_KICK_INTERVAL_MS = 550;

  /**
   * StreamCorner: repeatedly find AVAILABLE SOURCES / PLAY via page JS, then
   * MotionEvent-tap those CSS coords. Synthetic clicks alone leave SELECT A SOURCE idle.
   */
  void kickStreamCornerPlayback() {
    int gen = ++cornerKickGen;
    runStreamCornerKick(gen, 0);
  }

  private void runStreamCornerKick(int gen, int attempt) {
    if (gen != cornerKickGen) return;
    if (attempt >= CORNER_KICK_MAX) return;
    String live = currentUrl == null ? "" : currentUrl;
    if (
      !live.contains("streamcorner")
        && !live.contains("strmcrnr")
        && !live.contains("streamninja")
    ) {
      return;
    }
    if (view == null || session == null || view.getVisibility() != View.VISIBLE) {
      main.postDelayed(() -> runStreamCornerKick(gen, attempt + 1), CORNER_KICK_INTERVAL_MS);
      return;
    }
    if (loading) {
      main.postDelayed(() -> runStreamCornerKick(gen, attempt + 1), CORNER_KICK_INTERVAL_MS);
      return;
    }
    evaluateJavascript(STREAMCORNER_BOOT_JS, null);
    evaluateJavascript(
      STREAMCORNER_TAP_RECT_JS,
      raw -> {
        if (gen != cornerKickGen) return;
        JSONObject o = parseCornerTapResult(raw);
        if (o != null && o.optBoolean("playing")) {
          android.util.Log.i("JiyuGecko", "streamcorner kick: playing");
          return;
        }
        boolean tapped = false;
        if (o != null && o.optBoolean("ok")) {
          float cx = (float) o.optDouble("cx", 0);
          float cy = (float) o.optDouble("cy", 0);
          float vw = (float) o.optDouble("vw", 0);
          float vh = (float) o.optDouble("vh", 0);
          if (vw >= 1f && vh >= 1f && view != null) {
            String kind = o.optString("kind", "");
            android.util.Log.i(
              "JiyuGecko",
              "streamcorner kick tap kind=" + kind + " attempt=" + attempt
            );
            dispatchTap(view, session, cx / vw, cy / vh);
            tapped = true;
            // Source then PLAY: give React a beat after selecting the card.
            int delay = "source".equals(kind) ? 900 : CORNER_KICK_INTERVAL_MS;
            main.postDelayed(() -> runStreamCornerKick(gen, attempt + 1), delay);
            return;
          }
        }
        if (!tapped && attempt == 8) {
          // Rough fallback: mid-player PLAY pill, then lower source row.
          dispatchTap(view, session, 0.5f, 0.32f);
          main.postDelayed(() -> dispatchTap(view, session, 0.5f, 0.78f), 700);
        }
        main.postDelayed(() -> runStreamCornerKick(gen, attempt + 1), CORNER_KICK_INTERVAL_MS);
      }
    );
  }

  @Nullable
  private static JSONObject parseCornerTapResult(@Nullable String raw) {
    if (raw == null || raw.isEmpty() || "null".equals(raw)) return null;
    String s = raw.trim();
    try {
      if (s.startsWith("\"") && s.endsWith("\"")) {
        s = new JSONObject("{\"v\":" + s + "}").optString("v", s);
      }
      int start = s.indexOf('{');
      int end = s.lastIndexOf('}');
      if (start >= 0 && end > start) s = s.substring(start, end + 1);
      return new JSONObject(s);
    } catch (Throwable ignored) {
      return null;
    }
  }

  /**
   * Keep measuring until the paused play control is on screen, then tap it.
   * A missing button is not a skip — the player often mounts after the document loads.
   * A playing video reports no rect, so this does not pause a live stream.
   */
  void tapPlayButton(@Nullable Runnable done) {
    if (loading) {
      // Look once the document stops. A newer caller replaces the pending one;
      // resolve the older callback so its promise does not hang.
      Runnable prev = playTapAfterLoadDone;
      playTapAfterLoad = true;
      playTapAfterLoadDone = done;
      if (prev != null && prev != done) prev.run();
      return;
    }
    String url = currentUrl == null ? "" : currentUrl;
    // Confirmed playing on this URL: never tap again (a tap would pause it).
    if (!url.isEmpty() && url.equals(playTapUrl)) {
      if (done != null) done.run();
      return;
    }
    if (!url.equals(playTapBudgetUrl)) {
      playTapBudgetUrl = url;
      playTapCount = 0;
      playBlindTaps = 0;
    }
    // A watch is already running for this page: let it continue instead of
    // restarting from attempt 0 (repeated callers used to reset the clock).
    if (playWatchGen != 0 && url.equals(playWatchUrl)) {
      if (done != null) done.run();
      return;
    }
    int gen = ++playWatchSeq;
    playWatchGen = gen;
    playWatchUrl = url;
    beginPlayButtonWatch(gen, done, 0);
  }

  private static final int PLAY_LOOK_INTERVAL_MS = 400;
  /** About 20s+ of looking after the caller asks. The button is often late. */
  private static final int PLAY_LOOK_MAX = 50;
  /**
   * No play control and no paused video found by this attempt (~5-10s): tap the middle.
   * 0.3.84 did this at attempt 3 (~1.5s after page stop) - before most players mount -
   * and then stopped looking, so the stream sat paused (or the blind taps toggled a
   * stream that had just started).
   */
  private static final int PLAY_BLIND_AT = 12;
  /** Without a bridge port we cannot see play state: one late blind tap pair, then stop. */
  private static final int PLAY_BLIND_NO_BRIDGE_AT = 8;
  /** Re-check this long after a tap; tap again only if the frame still reports paused. */
  private static final int PLAY_RETAP_DELAY_MS = 800;
  /**
   * Taps per page URL (button taps + blind taps). StreamCorner needs source +
   * PLAY (+ retries); keep headroom beyond typical single-button embeds.
   */
  private static final int PLAY_TAP_MAX = 8;

  private void endPlayWatch(int gen, @Nullable Runnable done) {
    if (gen == playWatchGen) playWatchGen = 0;
    if (done != null) done.run();
  }

  private void beginPlayButtonWatch(int gen, @Nullable Runnable done, int attempt) {
    if (gen != playWatchGen) {
      if (done != null) done.run();
      return;
    }
    if (view == null || session == null || view.getVisibility() != View.VISIBLE || attempt >= PLAY_LOOK_MAX) {
      endPlayWatch(gen, done);
      return;
    }
    if (loading) {
      // A new document started under us: look again once it stops.
      playWatchGen = 0;
      tapPlayButton(done);
      return;
    }
    String url = currentUrl == null ? "" : currentUrl;
    if (!url.equals(playWatchUrl)) {
      playWatchGen = 0;
      tapPlayButton(done);
      return;
    }
    if (bridgePorts.isEmpty()) {
      if (attempt >= PLAY_BLIND_NO_BRIDGE_AT) {
        if (playBlindTaps == 0 && playTapCount < PLAY_TAP_MAX) {
          playBlindTaps = 2;
          playTapCount += 2;
          tapTwice(0.5f, 0.5f);
        }
        endPlayWatch(gen, done);
        return;
      }
      main.postDelayed(() -> beginPlayButtonWatch(gen, done, attempt + 1), PLAY_LOOK_INTERVAL_MS);
      return;
    }
    PlayTap stale = playTap;
    if (stale != null && !stale.done) {
      // A superseded watch's query is still in flight: resolve its caller.
      stale.done = true;
      playTap = null;
      if (stale.doneCb != null && stale.doneCb != done) stale.doneCb.run();
    }
    int id = ++playTapSeq;
    PlayTap tap = new PlayTap();
    tap.id = id;
    tap.gen = gen;
    tap.expect = bridgePorts.size();
    tap.attempt = attempt;
    tap.doneCb = done;
    playTap = tap;
    for (WebExtension.Port port : bridgePorts) {
      postQueryPlayButtonRect(port, id, tap.attempt);
    }
    main.postDelayed(() -> finishPlayButtonTap(id), 700);
  }

  private int playTapSeq;
  @Nullable private PlayTap playTap;
  private boolean playTapsSent;
  private boolean playTapAfterLoad;
  @Nullable private Runnable playTapAfterLoadDone;
  /** Running play watch (0 = none) and the page it is watching. */
  private int playWatchSeq;
  private int playWatchGen;
  private String playWatchUrl = "";
  /** Tap budget for one page URL. */
  private String playTapBudgetUrl = "";
  private int playTapCount;
  private int playBlindTaps;

  private static final class PlayTap {
    int id;
    int gen;
    int expect;
    int got;
    int attempt;
    boolean done;
    boolean have;
    boolean playing;
    boolean fromTop;
    float cx;
    float cy;
    float vw;
    float vh;
    float area;
    @Nullable Runnable doneCb;
  }

  private static boolean isPlayButtonRect(Object message) {
    try {
      if (message instanceof JSONObject) {
        return "playButtonRect".equals(((JSONObject) message).optString("action"));
      }
      if (message instanceof Map) {
        return "playButtonRect".equals(String.valueOf(((Map<?, ?>) message).get("action")));
      }
    } catch (Throwable ignored) {}
    return false;
  }

  @SuppressWarnings("unchecked")
  private void onPlayButtonRect(Object message) {
    PlayTap tap = playTap;
    int id = -1;
    boolean found = false;
    String frame = "";
    float cx = 0f;
    float cy = 0f;
    float vw = 0f;
    float vh = 0f;
    float width = 0f;
    float height = 0f;
    boolean playing = false;
    try {
      if (message instanceof JSONObject) {
        JSONObject o = (JSONObject) message;
        id = o.optInt("id", -1);
        found = o.optBoolean("found");
        playing = o.optBoolean("playing");
        frame = o.optString("frame");
        cx = (float) o.optDouble("cx");
        cy = (float) o.optDouble("cy");
        vw = (float) o.optDouble("vw");
        vh = (float) o.optDouble("vh");
        width = (float) o.optDouble("w");
        height = (float) o.optDouble("h");
      } else if (message instanceof Map) {
        Map<String, Object> map = (Map<String, Object>) message;
        Object idObj = map.get("id");
        id = idObj instanceof Number ? ((Number) idObj).intValue() : -1;
        Object foundObj = map.get("found");
        found = Boolean.TRUE.equals(foundObj) || "true".equals(String.valueOf(foundObj));
        Object playingObj = map.get("playing");
        playing = Boolean.TRUE.equals(playingObj) || "true".equals(String.valueOf(playingObj));
        Object frameObj = map.get("frame");
        frame = frameObj == null ? "" : String.valueOf(frameObj);
        cx = map.get("cx") instanceof Number ? ((Number) map.get("cx")).floatValue() : 0f;
        cy = map.get("cy") instanceof Number ? ((Number) map.get("cy")).floatValue() : 0f;
        vw = map.get("vw") instanceof Number ? ((Number) map.get("vw")).floatValue() : 0f;
        vh = map.get("vh") instanceof Number ? ((Number) map.get("vh")).floatValue() : 0f;
        width = map.get("w") instanceof Number ? ((Number) map.get("w")).floatValue() : 0f;
        height = map.get("h") instanceof Number ? ((Number) map.get("h")).floatValue() : 0f;
      } else {
        return;
      }
    } catch (Throwable ignored) {
      return;
    }
    if (tap == null || id != tap.id) return;
    if (playing) tap.playing = true;
    tap.got++;
    boolean top = "top".equals(frame);
    float area = Math.max(0f, width) * Math.max(0f, height);
    boolean better =
      found
        && vw > 1f
        && vh > 1f
        && (!tap.have || (top && !tap.fromTop) || (top == tap.fromTop && area > tap.area));
    if (better) {
      tap.have = true;
      tap.fromTop = top;
      tap.cx = cx;
      tap.cy = cy;
      tap.vw = vw;
      tap.vh = vh;
      tap.area = area;
    }
    if (tap.got >= tap.expect) finishPlayButtonTap(id);
  }

  private void finishPlayButtonTap(int id) {
    PlayTap tap = playTap;
    if (tap == null || tap.done || tap.id != id) return;
    tap.done = true;
    playTap = null;
    Runnable done = tap.doneCb;
    int gen = tap.gen;
    int next = tap.attempt + 1;
    if (gen != playWatchGen) {
      if (done != null) done.run();
      return;
    }
    if (tap.playing) {
      // Some frame has a real, unpaused video: done for this page, never toggle it.
      playTapUrl = currentUrl == null ? "" : currentUrl;
      endPlayWatch(gen, done);
      return;
    }
    if (view == null || session == null) {
      endPlayWatch(gen, done);
      return;
    }
    if (tap.have && tap.vw >= 1f && tap.vh >= 1f) {
      if (playTapCount >= PLAY_TAP_MAX) {
        endPlayWatch(gen, done);
        return;
      }
      playTapCount++;
      playTapsSent = true;
      dispatchTap(view, session, tap.cx / tap.vw, tap.cy / tap.vh);
      // Some embeds ignore the first tap. Look again and tap only if still paused
      // (the old blind second tap paused streams the first tap had started).
      main.postDelayed(() -> beginPlayButtonWatch(gen, done, next), PLAY_RETAP_DELAY_MS);
      return;
    }
    if (tap.attempt >= PLAY_BLIND_AT && playBlindTaps < 2 && playTapCount < PLAY_TAP_MAX) {
      playBlindTaps++;
      playTapCount++;
      playTapsSent = true;
      dispatchTap(view, session, 0.5f, 0.5f);
      main.postDelayed(() -> beginPlayButtonWatch(gen, done, next), PLAY_RETAP_DELAY_MS);
      return;
    }
    main.postDelayed(() -> beginPlayButtonWatch(gen, done, next), PLAY_LOOK_INTERVAL_MS);
  }

  /** Ask this frame for the play control's CSS-pixel box. There is no executeScript on GV 140. */
  static void postQueryPlayButtonRect(WebExtension.Port port, int id, int attempt) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "queryPlayButtonRect");
      msg.put("id", id);
      msg.put("attempt", attempt);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  /** Ask this frame to click the embed play control once. There is no executeScript on GV 140. */
  static void postTileKick(WebExtension.Port port, boolean muted) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "tileKick");
      msg.put("muted", muted);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  @SuppressWarnings("unchecked")
  private void handleBridgeMessage(Object message) {
    if (isTileAudioQuery(message)) return;
    try {
      long id = -1;
      Object result = null;
      Object error = null;
      if (message instanceof JSONObject) {
        JSONObject o = (JSONObject) message;
        id = o.optLong("id", -1);
        result = o.isNull("result") ? null : o.get("result");
        error = o.isNull("error") ? null : o.opt("error");
      } else if (message instanceof Map) {
        Map<String, Object> map = (Map<String, Object>) message;
        Object idObj = map.get("id");
        id = idObj instanceof Number ? ((Number) idObj).longValue() : -1;
        result = map.get("result");
        error = map.get("error");
      } else {
        return;
      }
      if (error != null && !"null".equals(String.valueOf(error))) {
        // Keep waiting for other frames unless this was the only reply.
        finishEvalIfReady(id, null, false);
        return;
      }
      final String json = toJsResult(result);
      finishEvalIfReady(id, json, true);
    } catch (Throwable ignored) {}
  }

  /** Prefer play/unmute outcomes from any frame over no-video / idle. */
  private static int evalRank(@Nullable String json) {
    if (json == null || "null".equals(json)) return 0;
    String s = json.toLowerCase();
    if (s.contains("already-playing") || s.contains("play-with-sound") || s.contains("\"play\"")) {
      return 5;
    }
    if (s.contains("already-muted") || s.contains("play-kept-muted") || s.contains("unmute")) {
      return 4;
    }
    if (s.contains("play-ui") || s.contains("play-called") || s.contains("\"already\"")) {
      return 3;
    }
    if (s.contains("playing")) return 4;
    if (s.contains("installed") || s.contains("\"ready\"") || s.contains("placed")) return 6;
    if (s.contains("\"child\"") || s.contains("\"skip\"")) return 0;
    if (s.contains("no-video") || s.contains("idle") || s.contains("noop")) return 1;
    return 2;
  }

  private void finishEvalIfReady(long id, @Nullable String json, boolean haveResult) {
    EvalCallback cb = null;
    String best = null;
    synchronized (pendingEval) {
      if (!pendingEval.containsKey(id) && !pendingEvalExpect.containsKey(id)) return;
      if (haveResult) {
        String prev = pendingEvalBest.get(id);
        if (prev == null || evalRank(json) >= evalRank(prev)) {
          pendingEvalBest.put(id, json);
        }
      }
      Integer left = pendingEvalExpect.get(id);
      if (left == null) {
        // Fire-and-forget or already completed.
        return;
      }
      left = left - 1;
      if (left > 0) {
        pendingEvalExpect.put(id, left);
        return;
      }
      pendingEvalExpect.remove(id);
      best = pendingEvalBest.remove(id);
      cb = pendingEval.remove(id);
    }
    if (cb != null) {
      final String out = best;
      final EvalCallback done = cb;
      main.post(() -> done.onResult(out));
    }
  }

  void evaluateJavascript(String script, @Nullable EvalCallback callback) {
    if (session == null || script == null || script.isEmpty()) {
      if (callback != null) callback.onResult(null);
      return;
    }
    long id = evalSeq.getAndIncrement();
    if (callback != null) {
      synchronized (pendingEval) {
        pendingEval.put(id, callback);
      }
      main.postDelayed(
        () -> {
          EvalCallback stuck;
          String best;
          synchronized (pendingEval) {
            stuck = pendingEval.remove(id);
            pendingEvalExpect.remove(id);
            best = pendingEvalBest.remove(id);
          }
          if (stuck != null) stuck.onResult(best);
        },
        6000
      );
    }
    if (!bridgePorts.isEmpty()) {
      postEval(id, script, callback);
      return;
    }
    synchronized (bridgeQueue) {
      bridgeQueue.add(new PendingEval(id, script, callback));
      if (bridgeQueue.size() > 40) {
        PendingEval dropped = bridgeQueue.remove(0);
        if (dropped.callback != null) {
          synchronized (pendingEval) {
            pendingEval.remove(dropped.id);
          }
          main.post(() -> dropped.callback.onResult(null));
        }
      }
    }
  }

  private void postEval(long id, String script, @Nullable EvalCallback callback) {
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "eval");
      msg.put("id", id);
      msg.put("code", script);
      int ports = 0;
      for (WebExtension.Port port : bridgePorts) {
        try {
          port.postMessage(msg);
          ports++;
        } catch (Throwable ignored) {}
      }
      if (callback == null) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
          pendingEvalExpect.remove(id);
          pendingEvalBest.remove(id);
        }
        return;
      }
      if (ports <= 0) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
        }
        main.post(() -> callback.onResult(null));
        return;
      }
      synchronized (pendingEval) {
        pendingEvalExpect.put(id, ports);
      }
    } catch (Throwable t) {
      if (callback != null) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
          pendingEvalExpect.remove(id);
        }
        main.post(() -> callback.onResult(null));
      }
    }
  }

  private void flushBridgeQueue() {
    java.util.ArrayList<PendingEval> batch;
    synchronized (bridgeQueue) {
      if (bridgeQueue.isEmpty()) return;
      batch = new java.util.ArrayList<>(bridgeQueue);
      bridgeQueue.clear();
    }
    for (PendingEval item : batch) {
      postEval(item.id, item.code, item.callback);
    }
  }

  private static String toJsResult(Object result) {
    if (result == null) return "null";
    if (result instanceof Boolean || result instanceof Number) return String.valueOf(result);
    if (result instanceof String) {
      try {
        return JSONObject.quote((String) result);
      } catch (Throwable t) {
        return "\"" + String.valueOf(result).replace("\"", "\\\"") + "\"";
      }
    }
    try {
      return String.valueOf(result);
    } catch (Throwable t) {
      return "null";
    }
  }

  void loadUrl(String url) {
    loadUrl(url, shouldStripDocumentReferer(url));
  }

  /**
   * Load an embed page and sniff the first playable media URL for Media3.
   * Keeps the SurfaceView tiny/invisible-ish; caller should hide afterward.
   */
  void resolveMediaFromEmbed(String pageUrl, long timeoutMs, MediaResolveCallback callback) {
    if (pageUrl == null || pageUrl.isEmpty()) {
      if (callback != null) callback.onResult(null, null, "Missing url");
      return;
    }
    cancelMediaProbe("superseded");
    mediaProbe = new MediaResolveProbe(pageUrl, timeoutMs, callback);
    loadUrl(pageUrl, shouldStripDocumentReferer(pageUrl));
    scheduleMediaProbePoll(0);
  }

  /** embed.st / embedhd.st return a black stub player when any Referer is sent. */
  static boolean shouldStripDocumentReferer(String url) {
    String host = hostOf(url);
    if (host.isEmpty()) return false;
    return host.equals("embed.st")
      || host.endsWith(".embed.st")
      || host.equals("embedhd.st")
      || host.endsWith(".embedhd.st");
  }

  void cancelMediaProbe(@Nullable String reason) {
    MediaResolveProbe probe = mediaProbe;
    if (probe == null || probe.finished) {
      mediaProbe = null;
      return;
    }
    probe.finished = true;
    mediaProbe = null;
    // "superseded" = quiet replace for a new probe.
    if (probe.callback != null && reason != null && !"superseded".equals(reason)) {
      main.post(() -> probe.callback.onResult(null, probe.pageUrl, reason));
    }
  }

  private void rememberLiveMedia(@Nullable String uri) {
    if (uri == null || uri.isEmpty()) return;
    if (!isSniffableMediaUrl(uri)) return;
    if (BrowserAdBlock.isAdHijackUrl(uri) || BrowserAdBlock.shouldBlockNavigation(uri)) return;
    int score = mediaUrlScore(uri);
    int prev =
      lastLiveMediaUrl == null || lastLiveMediaUrl.isEmpty() ? -1 : mediaUrlScore(lastLiveMediaUrl);
    if (score >= prev) {
      lastLiveMediaUrl = uri;
      lastLiveMediaPage = currentUrl == null ? "" : currentUrl;
      android.util.Log.i("JiyuGecko", "live media score=" + score + " " + safeUrl(uri));
    }
  }

  private void noteMediaCandidate(@Nullable String uri) {
    rememberLiveMedia(uri);
    MediaResolveProbe probe = mediaProbe;
    if (probe == null || probe.finished || uri == null || uri.isEmpty()) return;
    if (!isSniffableMediaUrl(uri)) return;
    if (BrowserAdBlock.isAdHijackUrl(uri) || BrowserAdBlock.shouldBlockNavigation(uri)) return;
    // Prefer playlists over single segments.
    int score = mediaUrlScore(uri);
    int prev = probe.bestMediaUrl == null ? -1 : mediaUrlScore(probe.bestMediaUrl);
    if (score >= prev) {
      probe.bestMediaUrl = uri;
      android.util.Log.i("JiyuGecko", "media candidate score=" + score + " " + safeUrl(uri));
      if (score >= 50) finishMediaProbe(probe, uri);
    }
  }

  /**
   * Return the best media URL already seen for the current page (network + page scrape).
   * Used to promote StreamCorner Bitmovin → Media3 after playback starts in Gecko.
   */
  void sniffCurrentMedia(MediaResolveCallback callback) {
    if (callback == null) return;
    final String page = currentUrl == null ? "" : currentUrl;
    final String cached = lastLiveMediaUrl == null ? "" : lastLiveMediaUrl;
    if (!cached.isEmpty() && mediaUrlScore(cached) >= 50) {
      main.post(() -> callback.onResult(cached, page, null));
      return;
    }
    evaluateJavascript(
      MEDIA_SNIFF_JS,
      (json) -> {
        String raw = json == null ? "" : String.valueOf(json);
        if (raw.startsWith("\"") && raw.endsWith("\"")) {
          raw = raw.substring(1, raw.length() - 1).replace("\\n", "\n").replace("\\\"", "\"");
        }
        String best = cached;
        int bestScore = best.isEmpty() ? -1 : mediaUrlScore(best);
        for (String line : raw.split("\n")) {
          String u = line.trim();
          if (u.isEmpty() || u.startsWith("iframe:")) continue;
          if (!isSniffableMediaUrl(u)) continue;
          if (BrowserAdBlock.isAdHijackUrl(u) || BrowserAdBlock.shouldBlockNavigation(u)) continue;
          int score = mediaUrlScore(u);
          if (score >= bestScore) {
            best = u;
            bestScore = score;
          }
        }
        if (!best.isEmpty()) {
          lastLiveMediaUrl = best;
          lastLiveMediaPage = page;
          callback.onResult(best, page, null);
        } else {
          callback.onResult(null, page, "No media URL found");
        }
      }
    );
  }

  private void scheduleMediaProbePoll(int attempt) {
    MediaResolveProbe probe = mediaProbe;
    if (probe == null || probe.finished) return;
    if (System.currentTimeMillis() > probe.deadlineMs) {
      if (probe.bestMediaUrl != null) finishMediaProbe(probe, probe.bestMediaUrl);
      else {
        probe.finished = true;
        mediaProbe = null;
        MediaResolveCallback cb = probe.callback;
        main.post(() -> {
          if (cb != null) cb.onResult(null, probe.pageUrl, "No media URL found");
        });
      }
      return;
    }
    // StreamCorner Bitmovin needs source-pick / Hide Chat before it fetches HLS.
    if (probe.pageUrl != null
      && (probe.pageUrl.contains("streamcorner")
        || probe.pageUrl.contains("strmcrnr")
        || probe.pageUrl.contains("streamninja"))) {
      evaluateJavascript(STREAMCORNER_BOOT_JS, null);
    }
    evaluateJavascript(
      MEDIA_SNIFF_JS,
      (json) -> {
        MediaResolveProbe p = mediaProbe;
        if (p == null || p.finished) return;
        String raw = json == null ? "" : String.valueOf(json);
        if (raw.startsWith("\"") && raw.endsWith("\"")) {
          raw = raw.substring(1, raw.length() - 1).replace("\\n", "\n").replace("\\\"", "\"");
        }
        for (String line : raw.split("\n")) {
          String u = line.trim();
          if (u.startsWith("iframe:")) continue;
          noteMediaCandidate(u);
        }
        p.pollCount += 1;
        // Nudge play so Clappr starts fetching segments (early: first poll).
        if (p.pollCount == 1 || p.pollCount == 3 || p.pollCount == 6) {
          evaluateJavascript(
            "(() => {try{document.querySelectorAll('video').forEach(v=>{try{v.muted=true;v.play();}catch(e){}});"
              + "return 'kick';}catch(e){return 'x';}})()",
            null
          );
        }
        main.postDelayed(() -> scheduleMediaProbePoll(attempt + 1), 400);
      }
    );
  }

  private void finishMediaProbe(MediaResolveProbe probe, String mediaUrl) {
    if (probe.finished) return;
    probe.finished = true;
    if (mediaProbe == probe) mediaProbe = null;
    MediaResolveCallback cb = probe.callback;
    main.post(() -> {
      if (cb != null) cb.onResult(mediaUrl, probe.pageUrl, null);
    });
  }

  static boolean isSniffableMediaUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
    String u = url.toLowerCase();
    if (u.contains(".m3u8") || u.contains("format=m3u8") || u.contains("/hls/")) return true;
    if (u.contains(".mpd") || u.contains("dash")) return true;
    if (u.contains(".m4s") || u.contains("fragmented") || u.contains("cmaf")) return true;
    if (u.matches("(?i).*\\.(ts|mp4|m4v)(\\?|#|$).*")) return true;
    if (u.contains("mime=video") || u.contains("contenttype=video")) return true;
    return false;
  }

  static int mediaUrlScore(String url) {
    String u = url.toLowerCase();
    if (u.contains(".m3u8") || u.contains("format=m3u8")) return 80;
    if (u.contains(".mpd")) return 75;
    if (u.contains(".mp4") && !u.contains(".m4s")) return 60;
    if (u.contains(".m4s")) return 40;
    if (u.endsWith(".ts") || u.contains(".ts?")) return 20;
    return 30;
  }

  /** Movy / Atlantic origins are HLS Referers only — never open as documents. */
  private static boolean isStreamRefererOnlyUrl(String url) {
    return BrowserAdBlock.isStreamRefererOnlyUrl(url);
  }

  private static String safeUrl(String url) {
    if (url == null) return "";
    return url.length() > 160 ? url.substring(0, 160) : url;
  }

  private void restorePlayerEmbedIfNeeded(String reason) {
    if (lastPlayerEmbedUrl == null || lastPlayerEmbedUrl.isEmpty()) return;
    if (lastPlayerEmbedUrl.equals(currentUrl)) return;
    android.util.Log.i("JiyuGecko", "restoring embed after " + reason + " → " + safeUrl(lastPlayerEmbedUrl));
    main.post(() -> loadUrl(lastPlayerEmbedUrl, shouldStripDocumentReferer(lastPlayerEmbedUrl)));
  }

  /**
   * atlantic.st / movy.sx (and other blocked documents) paint a full-screen
   * error page. Cover it. Restore the previous embed once; a second bounce
   * means that embed only leads back here, so stop instead of reloading.
   */
  private void leaveStreamRefererDocument(String url, String reason) {
    showLoadCover(true);
    coveringStreamReferer = true;
    long now = android.os.SystemClock.uptimeMillis();
    if (now - streamRefererLeaveAt < 750) return;
    streamRefererLeaveAt = now;
    streamRefererBounces += 1;
    String back = lastPlayerEmbedUrl == null ? "" : lastPlayerEmbedUrl;
    boolean canRestore =
      streamRefererBounces <= 1
        && !back.isEmpty()
        && !back.equals(url)
        && !BrowserAdBlock.shouldBlockNavigation(back);
    android.util.Log.w(
      "JiyuGecko",
      "leaving stream-referer page (" + reason + ", bounce " + streamRefererBounces + ") "
        + safeUrl(url)
    );
    if (canRestore) {
      final String restore = back;
      main.post(() -> loadUrl(restore, shouldStripDocumentReferer(restore)));
      return;
    }
    streamRefererBounces = 0;
    lastPlayerEmbedUrl = "";
    if (url != null && url.equals(currentUrl)) currentUrl = "";
    main.post(this::blank);
  }

  void loadUrl(String url, boolean stripReferer) {
    if (url == null || url.isEmpty()) return;
    ensureSession();
    if (session == null) return;
    if (isStreamRefererOnlyUrl(url) || BrowserAdBlock.shouldBlockNavigation(url)) {
      android.util.Log.w("JiyuGecko", "blocked stream-referer/ad page " + safeUrl(url));
      return;
    }
    try {
      session.setActive(true);
    } catch (Throwable ignored) {}
    loading = true;
    currentUrl = url;
    lastLiveMediaUrl = "";
    lastLiveMediaPage = "";
    if (BrowserAdBlock.isPlayerEmbedHost(url)) {
      lastPlayerEmbedUrl = url;
    }
    emitNav();
    // Empty Gecko compositor is white — keep a black cover until first paint.
    showLoadCover(true);
    try {
      GeckoSession.Loader loader = new GeckoSession.Loader().uri(url);
      Map<String, String> headers = new HashMap<>();
      headers.put("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      headers.put("Accept-Language", "en-US,en;q=0.9");
      if (stripReferer) {
        // embed.st / embedhd.st: any Referer yields a black stub (~1KB) player.
        // Explicit empty overrides Gecko's automatic previous-page Referer.
        headers.put("Referer", "");
      } else {
        String referer = documentRefererForUrl(url);
        if (referer != null && !referer.isEmpty()) {
          headers.put("Referer", referer);
        }
        // GeckoView drops a "Referer" in additionalHeaders (only CORS-safelisted
        // headers pass the default filter), so YouTube embeds loaded with no
        // embedder identity and showed Error 153. Loader.referrer() sets the real
        // navigation referrer (Referer header + document.referrer).
        String ytReferer = youTubeEmbedderReferrer(url);
        if (ytReferer != null) {
          loader.referrer(ytReferer);
        }
      }
      loader.additionalHeaders(headers);
      session.load(loader);
    } catch (Throwable t) {
      try {
        session.loadUri(url);
      } catch (Throwable ignored) {}
    }
  }

  /**
   * Document Referer for embeds that 404/blank without a site identity
   * (mirrors electron/main.cjs httpReferrerForBrowserUrl).
   */
  @Nullable
  static String documentRefererForUrl(String url) {
    String host = hostOf(url);
    if (host.isEmpty()) return null;
    if (host.equals("playmate.to") || host.endsWith(".playmate.to")) {
      return "https://fullmatchshows.com/";
    }
    if (host.equals("playmogo.com") || host.endsWith(".playmogo.com")) {
      return "https://fullmatchshows.com/";
    }
    if (host.equals("fullmatchshows.com") || host.endsWith(".fullmatchshows.com")) {
      return "https://fullmatchshows.com/";
    }
    if (host.equals("soccerfull.net") || host.endsWith(".soccerfull.net")) {
      return "https://livextv.hybrows.workers.dev/";
    }
    if (host.contains("livextv")) {
      return "https://livextv.hybrows.workers.dev/";
    }
    if (host.equals("fstream365.com") || host.endsWith(".fstream365.com")) {
      return "https://ww.ymovies.vip/";
    }
    if (host.equals("vsembed.ru") || host.endsWith(".vsembed.ru")) {
      return "https://freemovies.lol/";
    }
    if (host.equals("embedindia.st") || host.endsWith(".embedindia.st")) {
      return "https://ppv.st/";
    }
    if (host.equals("rivestream.ru") || host.endsWith(".rivestream.ru")) {
      return "https://rivestream.ru/";
    }
    // YouTube Error 153 / blank embed: needs an https embedder identity (not youtube.com).
    if (
      host.equals("youtube.com")
      || host.endsWith(".youtube.com")
      || host.equals("youtube-nocookie.com")
      || host.endsWith(".youtube-nocookie.com")
      || host.equals("youtu.be")
    ) {
      return "https://jiyu.app/";
    }
    return null;
  }

  /** https embedder identity for YouTube document loads (Error 153), else null. */
  @Nullable
  static String youTubeEmbedderReferrer(String url) {
    String host = hostOf(url);
    if (
      host.equals("youtube.com")
      || host.endsWith(".youtube.com")
      || host.equals("youtube-nocookie.com")
      || host.endsWith(".youtube-nocookie.com")
      || host.equals("youtu.be")
    ) {
      return "https://jiyu.app/";
    }
    return null;
  }

  private static boolean isPlaymogoUrl(String url) {
    String host = hostOf(url);
    if (host.equals("playmogo.com") || host.endsWith(".playmogo.com")) return true;
    try {
      String path = new java.net.URI(url).getPath();
      if (path != null && path.matches("(?i)^/e/[a-z0-9]{6,}.*") && host.matches("(?i).*(playmogo|dood).*")) {
        return true;
      }
    } catch (Throwable ignored) {}
    return false;
  }

  private static String hostOf(String url) {
    if (url == null || url.isEmpty()) return "";
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return "";
      return host.replaceFirst("^www\\.", "").toLowerCase();
    } catch (Throwable t) {
      return "";
    }
  }

  /** Replace the document with HTML. Used for the multiview shell (two iframes, no sandbox). */
  void loadHtml(String html) {
    ensureSession();
    if (session == null || html == null || html.isEmpty()) return;
    try {
      session.setActive(true);
    } catch (Throwable ignored) {}
    loading = true;
    currentUrl = "multiview";
    emitNav();
    try {
      // The String overload builds data:text/html,<html> without encoding.
      // background:#000 then becomes a URL fragment, so the iframes never load
      // and both tiles paint the default white page.
      session.load(
        new GeckoSession.Loader()
          .data(html.getBytes(java.nio.charset.StandardCharsets.UTF_8), "text/html")
      );
    } catch (Throwable t) {
      loadUrl("data:text/html;charset=utf-8," + android.net.Uri.encode(html));
    }
  }

  void goBack() {
    if (session == null) return;
    try {
      session.goBack();
    } catch (Throwable ignored) {}
  }

  void goForward() {
    if (session == null) return;
    try {
      session.goForward();
    } catch (Throwable ignored) {}
  }

  void reload() {
    if (session != null) session.reload();
  }

  void pause() {
    if (session != null) {
      try {
        session.setActive(false);
      } catch (Throwable ignored) {}
    }
  }

  void resume() {
    if (session != null) {
      try {
        session.setActive(true);
      } catch (Throwable ignored) {}
    }
  }

  /** Pause in-page media. Cross-origin embeds stop when the session is closed. */
  void pauseMediaForDismiss() {
    evaluateJavascript(
      "(function(){try{var nodes=document.querySelectorAll('video,audio');"
        + "for(var i=0;i<nodes.length;i++){try{nodes[i].pause();}catch(e){}}"
        + "return 'paused';}catch(e){return 'error';}})()",
      null
    );
    try {
      if (session != null) session.setActive(false);
    } catch (Throwable ignored) {}
  }

  void blank() {
    // about:blank is white. Prefer a real black document via byte data —
    // the data:text/html,string form can paint white empty pages in GeckoView
    // (same bug we fixed for multiview loadHtml).
    currentUrl = "";
    lastPlayerEmbedUrl = "";
    currentTitle = "";
    if (session == null) return;
    loading = true;
    emitNav();
    try {
      String html = "<html><body style=\"background:#000;margin:0\"></body></html>";
      session.load(
        new GeckoSession.Loader()
          .data(html.getBytes(java.nio.charset.StandardCharsets.UTF_8), "text/html")
      );
    } catch (Throwable t) {
      try {
        session.loadUri(
          "data:text/html;charset=utf-8,"
            + android.net.Uri.encode("<html><body style='background:#000'></body></html>")
        );
      } catch (Throwable ignored) {}
    }
  }

  /**
   * Stop playback without closing the session. Replacing the session on hide
   * left GeckoView with no attached session, so the next stream stayed white.
   */
  void stopAndBlank() {
    evaluateJavascript(
      "(function(){try{"
        + "function kill(root){try{(root||document).querySelectorAll('video,audio').forEach(function(m){"
        + "try{m.pause();m.muted=true;m.volume=0;}catch(e){}});}catch(e){}}"
        + "kill(document);"
        + "return 'stopped';}catch(e){return 'error'}})()",
      null
    );
    try {
      if (session != null) session.setActive(true);
    } catch (Throwable ignored) {}
    blank();
  }

  /** Content process crashed / was killed: drop the dead session and open a fresh one. */
  private void recoverDeadSession(GeckoSession dead, String reason) {
    if (dead == null || dead != session) return;
    android.util.Log.w("JiyuGecko", "content process " + reason + " - reopening session");
    boolean wasVisible = view != null && view.getVisibility() == View.VISIBLE;
    String reloadUrl = !lastPlayerEmbedUrl.isEmpty() ? lastPlayerEmbedUrl : currentUrl;
    try {
      if (view != null) view.releaseSession();
    } catch (Throwable ignored) {}
    try {
      dead.close();
    } catch (Throwable ignored) {}
    session = null;
    bridgePorts.clear();
    loading = false;
    currentUrl = "";
    ensureSession();
    // On screen (crash mid-play): put the player back. Hidden: next open loads fresh.
    if (wasVisible && session != null && reloadUrl != null && !reloadUrl.isEmpty()
      && !reloadUrl.startsWith("about:")) {
      loadUrl(reloadUrl, shouldStripDocumentReferer(reloadUrl));
    }
  }

  /** Reattach a session if a previous hard-reset detached it (or Gecko closed it). */
  void ensureSession() {
    if (view == null) return;
    if (session != null) {
      boolean open = true;
      try {
        open = session.isOpen();
      } catch (Throwable ignored) {}
      if (open) return;
      android.util.Log.w("JiyuGecko", "session was closed - reopening");
      try {
        view.releaseSession();
      } catch (Throwable ignored) {}
      session = null;
      bridgePorts.clear();
    }
    try {
      openFreshSession();
      view.setSession(session);
      installBridge(session);
    } catch (Throwable ignored) {}
  }

  /** Mute/unmute media in-page (multi-view spotlight). */
  void setPageMuted(boolean muted) {
    double level = muted ? 0 : 1;
    String script =
      "(function(){try{window.__jiyuVolLevel=" + level + ";"
        + "var nodes=document.querySelectorAll('video,audio');"
        + "for(var i=0;i<nodes.length;i++){nodes[i].muted=" + muted + ";nodes[i].volume=" + level + ";"
        + "if(!" + muted + "){try{nodes[i].play();}catch(e){}}}"
        + "return " + muted + "?'muted':'unmuted';}catch(e){return 'error'}})()";
    evaluateJavascript(script, null);
  }

  /**
   * Hard-stop all media — used when Multiview takes over so Gecko cannot keep
   * playing audio under Chromium tiles. Closing the session is required because
   * suspendMediaWhenInactive is false (needed for autoplay) and cross-origin
   * iframe media ignores top-document pause scripts.
   */
  void killMediaAndBlank() {
    evaluateJavascript(
      "(function(){try{"
        + "function kill(root){try{(root||document).querySelectorAll('video,audio').forEach(function(m){"
        + "try{m.pause();m.muted=true;m.volume=0;"
        + "m.removeAttribute('src');m.src='';m.srcObject=null;m.load();}catch(e){}});}catch(e){}}"
        + "kill(document);"
        + "try{for(var i=0;i<window.frames.length;i++){try{kill(window.frames[i].document);}catch(e){}}}catch(e){}"
        + "return 'killed';}catch(e){return 'error'}})()",
      null
    );
    try {
      if (session != null) session.setActive(false);
    } catch (Throwable ignored) {}

    GeckoSession old = session;
    try {
      if (view != null) view.releaseSession();
    } catch (Throwable ignored) {}
    try {
      if (old != null) old.close();
    } catch (Throwable ignored) {}
    session = null;
    bridgePorts.clear();
    currentUrl = "";
    lastPlayerEmbedUrl = "";
    currentTitle = "";
    canGoBack = false;
    canGoForward = false;
    loading = false;

    if (view == null) return;
    try {
      openFreshSession();
      view.setSession(session);
      installBridge(session);
      try {
        session.setActive(false);
      } catch (Throwable ignored) {}
      blank();
    } catch (Throwable t) {
      try {
        blank();
      } catch (Throwable ignored) {}
    }
  }

  void destroy() {
    try {
      if (session != null) {
        session.setActive(false);
        session.close();
      }
    } catch (Throwable ignored) {}
    session = null;
    bridgePorts.clear();
    if (loadCover != null) {
      try {
        ViewGroup parent = (ViewGroup) loadCover.getParent();
        if (parent != null) parent.removeView(loadCover);
      } catch (Throwable ignored) {}
      loadCover = null;
    }
    if (view != null) {
      try {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.releaseSession();
      } catch (Throwable ignored) {}
    }
    view = null;
    synchronized (pendingEval) {
      pendingEval.clear();
      pendingEvalExpect.clear();
      pendingEvalBest.clear();
    }
    synchronized (bridgeQueue) {
      bridgeQueue.clear();
    }
  }

  private void emitNav() {
    if (navListener == null) return;
    navListener.onNav(currentUrl, currentTitle, canGoBack, canGoForward, loading);
  }
}
