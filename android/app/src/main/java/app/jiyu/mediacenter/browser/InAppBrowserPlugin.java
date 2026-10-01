package app.jiyu.mediacenter.browser;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioManager;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.coordinatorlayout.widget.CoordinatorLayout;
import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * GeckoView overlay for in-app browsing on Android (Electron WebContentsView stand-in).
 * Capacitor UI stays on System WebView; scrape/unlock use a hidden WebView.
 * Coordinates are CSS pixels relative to the Capacitor WebView.
 */
@CapacitorPlugin(name = "InAppBrowser")
public class InAppBrowserPlugin extends Plugin {
  /** GeckoView overlay — System WebView remains for Capacitor UI + scrape/unlock. */
  private GeckoOverlayController gecko;
  /**
   * Multiview tiles — System WebView only (never Gecko). Concurrent media requires
   * Chromium; see {@link MultiWebHost} invariant.
   */
  private MultiWebHost multi;
  /** Multiview owns the single GeckoSession (shell page + unsandboxed iframes). */
  private GeckoMultiHost geckoMulti;
  private boolean geckoMultiActive;
  private boolean pipBoundsSaved = false;
  private int pipLeft;
  private int pipTop;
  private int pipW;
  private int pipH;
  private FrameLayout host;
  private FrameLayout.LayoutParams layoutParams;
  /** Full-screen Cloudflare Verify chrome (banner + Done/Cancel). */
  private LinearLayout unlockPanel;
  private TextView unlockHint;
  private volatile boolean unlockCancelled;
  /** Latch + boxes for the active unlock session (Cancel / hardware Back). */
  private java.util.concurrent.CountDownLatch unlockLatch;
  private boolean[] unlockUnlockedBox;
  private String[] unlockErrorBox;
  private String unlockPageUrl;
  /** Second Done tap accepts after user confirms even if HTML still looks CF-ish. */
  private int unlockDoneTaps;
  private final Handler main = new Handler(Looper.getMainLooper());
  private String currentUrl = "";
  private String currentTitle = "";
  private boolean canGoBack;
  private boolean canGoForward;
  private boolean loading;

  @PluginMethod
  public void show(PluginCall call) {
    main.post(() -> {
      try {
        // PiP showAt() is queued when /web unmounts. It must not tear down
        // Multiview or shrink the shared Gecko surface back to the corner.
        if (geckoMultiActive) {
          call.resolve(ok());
          return;
        }
        ensureOverlay();
        if (gecko == null || gecko.getView() == null) {
          JSObject err = new JSObject();
          err.put("ok", false);
          err.put("error", "Could not attach browser view");
          call.resolve(err);
          return;
        }
        hideUnlockChrome();
        applyBounds(call);
        gecko.setVisibility(View.VISIBLE);
        gecko.resume();
        notifyNav();
        call.resolve(ok());
      } catch (Throwable t) {
        JSObject err = new JSObject();
        err.put("ok", false);
        err.put("error", t.getMessage() != null ? t.getMessage() : "Browser show failed");
        call.resolve(err);
      }
    });
  }

  @PluginMethod
  public void hide(PluginCall call) {
    boolean blank = Boolean.TRUE.equals(call.getBoolean("blank", false));
    boolean pause = Boolean.TRUE.equals(call.getBoolean("pause", true));
    main.post(() -> {
      if (gecko == null) {
        call.resolve(ok());
        return;
      }
      // Park/hide from the React tree races Multiview startup. Once the shell
      // page owns this session, blanking it would kill both tiles.
      if (geckoMultiActive) {
        call.resolve(ok());
        return;
      }
      if (pause && blank) {
        gecko.stopAndBlank();
        currentUrl = "";
        currentTitle = "";
      } else {
        if (pause) gecko.pause();
        if (blank) {
          gecko.blank();
          currentUrl = "";
          currentTitle = "";
        }
      }
      gecko.setVisibility(View.GONE);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void setBounds(PluginCall call) {
    main.post(() -> {
      try {
        ensureOverlay();
        if (gecko == null) {
          call.resolve(ok());
          return;
        }
        if (geckoMultiActive) {
          call.resolve(ok());
          return;
        }
        applyBounds(call);
        if (gecko.getVisibility() == View.VISIBLE) gecko.resume();
        call.resolve(ok());
      } catch (Throwable t) {
        call.resolve(ok());
      }
    });
  }

  @PluginMethod
  public void navigate(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || url.trim().isEmpty()) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("error", "Missing url");
      call.resolve(err);
      return;
    }
    final String target = url.trim();
    // atlantic.st / movy.sx are Referer-only origins for native HLS CDNs.
    // Opening them as documents shows Cloudflare Warp interstitials over playback.
    if (isStreamRefererOnlyUrl(target)) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("error", "Blocked stream-referer page");
      call.resolve(err);
      return;
    }
    main.post(() -> {
      try {
        geckoMultiActive = false;
        hideMultiForSingle();
        ensureOverlay();
        if (gecko == null || gecko.getView() == null) {
          JSObject err = new JSObject();
          err.put("ok", false);
          err.put("error", "Could not attach browser view");
          call.resolve(err);
          return;
        }
        gecko.setVisibility(View.VISIBLE);
        gecko.resume();
        gecko.ensureSession();
        gecko.noteUserNavigation();
        loading = true;
        notifyNav();
        // GeckoView is not Android System WebView — sports embeds stay in-app.
        // embed.st still prefers no document Referer (same as Electron).
        gecko.loadUrl(target, needsNoRefererDocument(target));
        currentUrl = target;
        JSObject out = ok();
        out.put("url", target);
        out.put("external", false);
        call.resolve(out);
        // Nudge after first paint for sports hosts.
        if (needsEmbedSandboxStrip(target)) {
          main.postDelayed(() -> {
            if (gecko == null) return;
            gecko.evaluateJavascript(STRIP_IFRAME_SANDBOX_JS, null);
          }, 600);
        }
      } catch (Throwable t) {
        JSObject err = new JSObject();
        err.put("ok", false);
        err.put("error", t.getMessage() != null ? t.getMessage() : "Navigate failed");
        call.resolve(err);
      }
    });
  }

  @PluginMethod
  public void goBack(PluginCall call) {
    main.post(() -> {
      if (gecko != null) gecko.goBack();
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void goForward(PluginCall call) {
    main.post(() -> {
      if (gecko != null) gecko.goForward();
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void reload(PluginCall call) {
    main.post(() -> {
      if (gecko != null) gecko.reload();
      call.resolve(ok());
    });
  }

  private static final String DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  private static final String DESKTOP_CHROME_FULL = "131.0.6778.69";
  private final Object fetchLock = new Object();
  private WebView scrapeView;
  private FrameLayout.LayoutParams scrapeLayoutParams;

  private static final String STRIP_IFRAME_SANDBOX_JS =
    "(function(){try{"
      + "var allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; *';"
      + "function fix(f){if(!f||f.dataset.jiyuUnsandboxed==='1')return;f.dataset.jiyuUnsandboxed='1';"
      + "var src=f.getAttribute('src')||f.src||'';f.removeAttribute('sandbox');"
      + "f.setAttribute('allow',allow);f.setAttribute('allowfullscreen','');"
      + "if(src){try{f.src=src;}catch(e){}}}"
      + "document.querySelectorAll('iframe').forEach(fix);"
      + "if(!window.__jiyuSandboxObserver){window.__jiyuSandboxObserver=new MutationObserver(function(ms){"
      + "ms.forEach(function(m){if(m.type==='attributes'&&m.attributeName==='sandbox'&&m.target&&m.target.tagName==='IFRAME')fix(m.target);"
      + "m.addedNodes&&m.addedNodes.forEach(function(n){if(!n||n.nodeType!==1)return;if(n.tagName==='IFRAME')fix(n);"
      + "else if(n.querySelectorAll)n.querySelectorAll('iframe').forEach(fix);});});});"
      + "try{window.__jiyuSandboxObserver.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['sandbox']});}catch(e){}}"
      + "}"
      + "}catch(e){}})();";

  private static boolean needsEmbedSandboxStrip(String url) {
    if (url == null || url.isEmpty()) return false;
    String u = url.toLowerCase();
    return u.contains("embed.st")
      || u.contains("embedhd.st")
      || u.contains("embedindia.st")
      || u.contains("streamed.pk")
      || u.contains("ppv.st")
      || u.contains("fstream")
      || u.contains("vsembed")
      || u.contains("soccerfull")
      || u.contains("livextv")
      || u.contains("footreplays");
  }

  /** embed.st returns a dead stub player when any Referer is present (Electron strips it). */
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

  /**
   * Movy / Atlantic site origins are Referer headers for HLS CDNs only.
   * Never open them as in-app browser documents (Cloudflare Warp interstitial).
   */
  private static boolean isStreamRefererOnlyUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return false;
      host = host.replaceFirst("^www\\.", "").toLowerCase();
      if (host.equals("atlantic.st") || host.endsWith(".atlantic.st")) return true;
      if (host.equals("movy.sx") || host.endsWith(".movy.sx")) return true;
      return false;
    } catch (Throwable t) {
      return false;
    }
  }

  private void applyDesktopBrowserHardening(WebSettings settings) {
    settings.setUserAgentString(DESKTOP_UA);
    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
        // Empty allow-list → never send X-Requested-With: app.jiyu.mediacenter
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

  @PluginMethod
  public void fetchHtml(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || url.trim().isEmpty()) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("content", "");
      err.put("status", 0);
      err.put("error", "Missing url");
      call.resolve(err);
      return;
    }
    final String target = url.trim();
    final JSObject headersObj = call.getObject("headers", new JSObject());
    new Thread(() -> {
      synchronized (fetchLock) {
        final String[] htmlBox = new String[] { "" };
        final int[] statusBox = new int[] { 0 };
        final String[] errorBox = new String[] { "" };
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        main.post(() -> loadScrapeHtml(target, headersObj, htmlBox, statusBox, errorBox, latch));
        try {
          if (!latch.await(40, java.util.concurrent.TimeUnit.SECONDS)) {
            errorBox[0] = "Page load timed out";
            statusBox[0] = 504;
          }
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          errorBox[0] = "Interrupted";
        }
        String html = htmlBox[0] == null ? "" : htmlBox[0];
        boolean challenge = isChallengePage(html);
        boolean success = !html.isEmpty() && !challenge && (statusBox[0] == 0 || (statusBox[0] >= 200 && statusBox[0] < 400));
        JSObject out = new JSObject();
        out.put("ok", success);
        out.put("content", html);
        out.put("status", challenge ? 503 : statusBox[0]);
        String err = success ? "" : (challenge ? "Cloudflare challenge" : (errorBox[0].isEmpty() ? "HTTP " + statusBox[0] : errorBox[0]));
        out.put("error", err);
        call.resolve(out);
      }
    }, "jiyu-webview-fetch").start();
  }

  /** Visible Verify overlay — user completes CF once; cookies stay in scrape WebView. */
  @PluginMethod
  public void unlockOrigin(PluginCall call) {
    String origin = call.getString("origin", "");
    if (origin == null || origin.trim().isEmpty()) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("error", "Missing origin");
      call.resolve(err);
      return;
    }
    // Never hijack the browse overlay while a sports/embed stream is on screen.
    if (gecko != null
      && gecko.getVisibility() == View.VISIBLE
      && currentUrl != null
      && !currentUrl.isEmpty()
      && !currentUrl.startsWith("about:")
      && !currentUrl.startsWith(origin.trim().replaceAll("/$", ""))) {
      JSObject busy = new JSObject();
      busy.put("ok", false);
      busy.put("error", "Browser busy — finish watching, then sync again");
      call.resolve(busy);
      return;
    }
    final String target = origin.trim().replaceAll("/$", "") + "/";
    final int timeoutMs = call.getInt("timeoutMs", 90000);
    new Thread(() -> {
      synchronized (fetchLock) {
        final boolean[] unlocked = new boolean[] { false };
        final String[] errorBox = new String[] { "" };
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        main.post(() -> runVisibleUnlock(target, timeoutMs, unlocked, errorBox, latch));
        try {
          if (!latch.await(Math.max(30, timeoutMs / 1000) + 5, java.util.concurrent.TimeUnit.SECONDS)) {
            errorBox[0] = "Unlock timed out";
          }
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          errorBox[0] = "Interrupted";
        }
        JSObject out = new JSObject();
        out.put("ok", unlocked[0]);
        out.put("error", unlocked[0] ? "" : (errorBox[0].isEmpty() ? "Cloudflare unlock failed" : errorBox[0]));
        call.resolve(out);
      }
    }, "jiyu-webview-unlock").start();
  }

  /** Hardware Back while Verify is open — same as tapping Cancel. */
  public boolean cancelUnlockIfVisible() {
    if (unlockPanel == null || unlockPanel.getVisibility() != View.VISIBLE) {
      return false;
    }
    main.post(() -> {
      unlockCancelled = true;
      if (unlockErrorBox != null) {
        unlockErrorBox[0] = "Cloudflare Verify cancelled";
      }
      hideUnlockChrome();
      hideScrapeUnlockView();
      if (unlockLatch != null && unlockLatch.getCount() > 0) {
        unlockLatch.countDown();
      }
    });
    return true;
  }

  private void runVisibleUnlock(
    String url,
    int timeoutMs,
    boolean[] unlocked,
    String[] errorBox,
    java.util.concurrent.CountDownLatch latch
  ) {
    try {
      unlockCancelled = false;
      unlockDoneTaps = 0;
      unlockLatch = latch;
      unlockUnlockedBox = unlocked;
      unlockErrorBox = errorBox;
      unlockPageUrl = url;
      ensureScrapeView();
      if (scrapeView == null) {
        errorBox[0] = "Scrape WebView unavailable";
        latch.countDown();
        return;
      }
      CookieManager cookies = CookieManager.getInstance();
      cookies.setAcceptCookie(true);
      try {
        CookieManager.getInstance().setAcceptThirdPartyCookies(scrapeView, true);
      } catch (Throwable ignored) {}

      showScrapeUnlockView();
      // Keep Gecko from eating Verify taps if a prior stream left it visible.
      if (gecko != null) {
        try {
          gecko.setVisibility(View.GONE);
          gecko.pause();
        } catch (Throwable ignored) {}
      }
      ensureUnlockChrome(unlocked, errorBox, latch, url);
      // Drop the scrape client's onPageFinished hook. It reads the challenge DOM
      // on every redirect, which makes the Verify checkbox restart forever.
      scrapeView.setWebViewClient(new WebViewClient() {});
      final String clearanceBefore = cfClearanceValue(url);
      scrapeView.loadUrl(url);

      final long deadline = System.currentTimeMillis() + Math.max(20_000, timeoutMs);
      final Runnable[] poll = new Runnable[1];
      poll[0] = () -> {
        if (unlockCancelled || latch.getCount() == 0) return;
        if (System.currentTimeMillis() > deadline) {
          errorBox[0] = "Unlock timed out — complete Verify, tap Done, then sync again";
          hideUnlockChrome();
          hideScrapeUnlockView();
          latch.countDown();
          return;
        }
        // Cookie only. Reading document HTML during Turnstile resets the widget.
        String clearanceNow = cfClearanceValue(url);
        if (clearanceNow != null
          && !clearanceNow.isEmpty()
          && !clearanceNow.equals(clearanceBefore)) {
          finishUnlockSuccess(unlocked, latch, url);
          return;
        }
        main.postDelayed(poll[0], 800);
      };
      main.postDelayed(poll[0], 800);
    } catch (Throwable t) {
      errorBox[0] = t.getMessage() != null ? t.getMessage() : "Unlock failed";
      hideUnlockChrome();
      latch.countDown();
    }
  }

  private void finishUnlockSuccess(boolean[] unlocked, java.util.concurrent.CountDownLatch latch, String url) {
    if (latch.getCount() == 0) return;
    unlocked[0] = true;
    try {
      CookieManager.getInstance().flush();
    } catch (Throwable ignored) {}
    // Do not loadUrl here — a second navigation restarts the challenge the user just passed.
    hideUnlockChrome();
    hideScrapeUnlockView();
    latch.countDown();
  }

  /** Full-bleed scrape WebView for Cloudflare Verify (hidden off-screen otherwise). */
  private void showScrapeUnlockView() {
    if (scrapeView == null) return;
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    );
    lp.leftMargin = 0;
    lp.topMargin = dp(52);
    scrapeView.setLayoutParams(lp);
    scrapeView.setAlpha(1f);
    scrapeView.setVisibility(View.VISIBLE);
    scrapeView.bringToFront();
    if (unlockPanel != null) unlockPanel.bringToFront();
  }

  private void hideScrapeUnlockView() {
    if (scrapeView == null || scrapeLayoutParams == null) return;
    try {
      scrapeView.setLayoutParams(scrapeLayoutParams);
      scrapeView.setAlpha(0f);
      scrapeView.setVisibility(View.VISIBLE);
    } catch (Throwable ignored) {}
  }

  private void ensureUnlockChrome(
    boolean[] unlocked,
    String[] errorBox,
    java.util.concurrent.CountDownLatch latch,
    String url
  ) {
    FrameLayout parent = contentHost();
    if (unlockPanel == null) {
      unlockPanel = new LinearLayout(getContext());
      unlockPanel.setOrientation(LinearLayout.HORIZONTAL);
      unlockPanel.setGravity(Gravity.CENTER_VERTICAL);
      unlockPanel.setPadding(dp(12), dp(10), dp(12), dp(10));
      unlockPanel.setBackgroundColor(Color.parseColor("#12161E"));
      FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(52)
      );
      lp.gravity = Gravity.TOP;
      unlockPanel.setLayoutParams(lp);

      unlockHint = new TextView(getContext());
      unlockHint.setTextColor(Color.parseColor("#E8EEF8"));
      unlockHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      unlockHint.setTypeface(Typeface.DEFAULT_BOLD);
      unlockHint.setMaxLines(2);
      LinearLayout.LayoutParams tipLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
      tipLp.rightMargin = dp(8);
      unlockHint.setLayoutParams(tipLp);
      unlockPanel.addView(unlockHint);

      Button cancel = new Button(getContext());
      cancel.setText("Cancel");
      cancel.setAllCaps(false);
      cancel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      cancel.setOnClickListener(v -> {
        java.util.concurrent.CountDownLatch active = unlockLatch;
        if (active == null || active.getCount() == 0) return;
        unlockCancelled = true;
        if (unlockErrorBox != null) unlockErrorBox[0] = "Cloudflare Verify cancelled";
        hideUnlockChrome();
        hideScrapeUnlockView();
        active.countDown();
      });
      unlockPanel.addView(cancel);

      Button done = new Button(getContext());
      done.setText("Done");
      done.setAllCaps(false);
      done.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      done.setOnClickListener(v -> {
        java.util.concurrent.CountDownLatch active = unlockLatch;
        if (active == null || active.getCount() == 0 || scrapeView == null) return;
        String pageUrl = unlockPageUrl == null ? "" : unlockPageUrl;
        unlockDoneTaps += 1;
        if (unlockHint != null) unlockHint.setText("Checking…");
        // User already completed the check — accept clearance cookie even if HTML still looks CF-ish.
        if (hasCfClearance(pageUrl) || unlockDoneTaps >= 2) {
          finishUnlockSuccess(unlockUnlockedBox, active, pageUrl);
          return;
        }
        scrapeView.evaluateJavascript(
          "(function(){try{var h=(document.documentElement&&document.documentElement.outerHTML)||'';return h;}catch(e){return ''}})()",
          value -> {
            if (active.getCount() == 0) return;
            String html = unwrapJsString(value);
            if (isHostDownPage(html)) {
              unlockCancelled = true;
              if (unlockErrorBox != null) {
                unlockErrorBox[0] = "Host error — origin is down behind Cloudflare. Try again later.";
              }
              hideUnlockChrome();
              hideScrapeUnlockView();
              active.countDown();
              return;
            }
            if ((!isChallengePage(html) && html.length() > 120) || hasCfClearance(pageUrl)) {
              finishUnlockSuccess(unlockUnlockedBox, active, pageUrl);
            } else if (unlockHint != null) {
              unlockHint.setText("Still blocked — finish the check, then tap Done again");
            }
          }
        );
      });
      unlockPanel.addView(done);
      parent.addView(unlockPanel);
    }
    if (unlockHint != null) {
      String host = url;
      try {
        host = new java.net.URL(url).getHost();
      } catch (Throwable ignored) {}
      unlockHint.setText("Cloudflare · complete Verify for " + host);
    }
    unlockPanel.setVisibility(View.VISIBLE);
    unlockPanel.bringToFront();
  }

  private void hideUnlockChrome() {
    if (unlockPanel != null) {
      try {
        unlockPanel.setVisibility(View.GONE);
      } catch (Throwable ignored) {}
    }
  }

  private int dp(int value) {
    float density = getContext().getResources().getDisplayMetrics().density;
    return Math.round(value * density);
  }

  private void loadScrapeHtml(
    String url,
    JSObject headersObj,
    String[] htmlBox,
    int[] statusBox,
    String[] errorBox,
    java.util.concurrent.CountDownLatch latch
  ) {
    try {
      ensureScrapeView();
      if (scrapeView == null) {
        errorBox[0] = "Scrape WebView unavailable";
        statusBox[0] = 500;
        latch.countDown();
        return;
      }
      // A catalog fetch must not reload the page while the user is on Verify.
      if (unlockPanel != null && unlockPanel.getVisibility() == View.VISIBLE) {
        errorBox[0] = "Cloudflare Verify in progress";
        statusBox[0] = 503;
        latch.countDown();
        return;
      }
      android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
      cookies.setAcceptCookie(true);
      try {
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(scrapeView, true);
      } catch (Throwable ignored) {}

      final boolean[] delivered = new boolean[] { false };
      final int[] attempts = new int[] { 0 };
      Runnable deliver = () -> {
        if (delivered[0]) return;
        scrapeView.evaluateJavascript(
          "(function(){try{return document.documentElement?document.documentElement.outerHTML:''}catch(e){return ''}})()",
          value -> {
            String html = unwrapJsString(value);
            attempts[0] += 1;
            // Wait out CF auto-challenge a few times before giving up.
            if (isChallengePage(html) && attempts[0] < 14) {
              main.postDelayed(() -> {
                if (!delivered[0]) deliverHtmlPoll(scrapeView, htmlBox, statusBox, errorBox, latch, delivered, attempts);
              }, 1500);
              return;
            }
            if (delivered[0]) return;
            delivered[0] = true;
            htmlBox[0] = html;
            if (statusBox[0] == 0 && !html.isEmpty() && !isChallengePage(html)) statusBox[0] = 200;
            latch.countDown();
          }
        );
      };
      scrapeView.setWebViewClient(new WebViewClient() {
        @Override
        public void onPageFinished(WebView view, String finishedUrl) {
          view.postDelayed(deliver, 1800);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse errorResponse) {
          if (request != null && request.isForMainFrame() && errorResponse != null) {
            statusBox[0] = errorResponse.getStatusCode();
            errorBox[0] = "HTTP " + errorResponse.getStatusCode();
          }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
          if (request != null && request.isForMainFrame() && error != null) {
            errorBox[0] = error.getDescription() != null ? error.getDescription().toString() : "Load failed";
            if (statusBox[0] == 0) statusBox[0] = 520;
          }
        }
      });
      main.postDelayed(() -> {
        if (!delivered[0]) deliver.run();
      }, 35000);

      java.util.Map<String, String> extra = new java.util.HashMap<>();
      if (headersObj != null) {
        java.util.Iterator<String> keys = headersObj.keys();
        while (keys.hasNext()) {
          String key = keys.next();
          Object val = headersObj.opt(key);
          if (val != null) extra.put(key, String.valueOf(val));
        }
      }
      if (!extra.containsKey("User-Agent")) extra.put("User-Agent", DESKTOP_UA);
      if (!extra.containsKey("Accept-Language")) extra.put("Accept-Language", "en-US,en;q=0.9");
      try {
        String origin = new java.net.URI(url).getScheme() + "://" + new java.net.URI(url).getHost() + "/";
        if (!extra.containsKey("Referer")) extra.put("Referer", origin);
      } catch (Throwable ignored) {}

      if (extra.isEmpty()) {
        scrapeView.loadUrl(url);
      } else {
        scrapeView.loadUrl(url, extra);
      }
    } catch (Throwable t) {
      errorBox[0] = t.getMessage() != null ? t.getMessage() : "WebView fetch failed";
      statusBox[0] = 500;
      latch.countDown();
    }
  }

  private void deliverHtmlPoll(
    WebView view,
    String[] htmlBox,
    int[] statusBox,
    String[] errorBox,
    java.util.concurrent.CountDownLatch latch,
    boolean[] delivered,
    int[] attempts
  ) {
    if (delivered[0] || view == null) return;
    view.evaluateJavascript(
      "(function(){try{return document.documentElement?document.documentElement.outerHTML:''}catch(e){return ''}})()",
      value -> {
        String html = unwrapJsString(value);
        attempts[0] += 1;
        if (isChallengePage(html) && attempts[0] < 12) {
          main.postDelayed(() -> deliverHtmlPoll(view, htmlBox, statusBox, errorBox, latch, delivered, attempts), 1500);
          return;
        }
        if (delivered[0]) return;
        delivered[0] = true;
        htmlBox[0] = html;
        if (statusBox[0] == 0 && !html.isEmpty() && !isChallengePage(html)) statusBox[0] = 200;
        latch.countDown();
      }
    );
  }

  @android.annotation.SuppressLint("SetJavaScriptEnabled")
  private void ensureScrapeView() {
    if (scrapeView != null) return;
    FrameLayout parent = contentHost();
    scrapeView = new WebView(getContext());
    WebSettings settings = scrapeView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    applyDesktopBrowserHardening(settings);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    // Real viewport size — Cloudflare fingerprints tiny 8×8 WebViews.
    scrapeLayoutParams = new FrameLayout.LayoutParams(1080, 1920);
    scrapeLayoutParams.leftMargin = -1200;
    scrapeLayoutParams.topMargin = 0;
    scrapeView.setLayoutParams(scrapeLayoutParams);
    scrapeView.setAlpha(0f);
    parent.addView(scrapeView);
  }

  private static boolean isHostDownPage(String html) {
    if (html == null || html.isEmpty()) return false;
    String head = html.length() > 5000 ? html.substring(0, 5000).toLowerCase() : html.toLowerCase();
    return head.contains("error code 520")
      || head.contains("error code 521")
      || head.contains("error code 522")
      || head.contains("error code 523")
      || head.contains("error code 524")
      || head.contains("web server is down")
      || head.contains("host error")
      || head.contains("origin is unreachable")
      || head.contains("connection timed out");
  }

  /** Same-origin CF wall (cinetaro.to) plus the classic challenge URLs. Taps restart it. */
  private static boolean isCloudflareInterstitial(String url, String title) {
    String blob = ((url == null ? "" : url) + " " + (title == null ? "" : title)).toLowerCase();
    if (blob.contains("challenges.cloudflare.com")
      || blob.contains("cdn-cgi/challenge")
      || blob.contains("__cf_chl")
      || blob.contains("cf_chl_")
      || blob.contains("just a moment")
      || blob.contains("verify you are human")
      || blob.contains("performing security verification")
      || blob.contains("security verification")
      || blob.contains("security service to protect")
      || blob.contains("checking your browser")) {
      return true;
    }
    try {
      String host = android.net.Uri.parse(url == null ? "" : url).getHost();
      if (host != null) {
        host = host.toLowerCase();
        if (host.equals("cinetaro.to") || host.endsWith(".cinetaro.to")) return true;
      }
    } catch (Throwable ignored) {}
    return false;
  }

  private static boolean isChallengePage(String html) {
    if (html == null || html.length() < 40) return true;
    // Origin-down CF error pages are not solvable by Verify — don't treat as unlockable.
    if (isHostDownPage(html)) return false;
    String head = html.length() > 5000 ? html.substring(0, 5000).toLowerCase() : html.toLowerCase();
    // Match desktop unlock heuristics — "cloudflare"+"challenge" alone is too broad
    // (cleared pages still ship challenge-platform scripts / Ray IDs).
    if (head.contains("just a moment")
      || head.contains("cf-browser-verification")
      || head.contains("attention required")
      || head.contains("checking your browser")
      || head.contains("verify you are human")
      || head.contains("performing security verification")
      || head.contains("enable javascript and cookies to continue")
      || head.contains("cdn-cgi/challenge")
      || head.contains("cf-mitigated")
      || head.contains("cf-turnstile")) {
      return true;
    }
    return head.contains("cloudflare") && head.contains("challenge-platform");
  }

  /** True when CF clearance cookie is present for this origin. */
  private static boolean hasCfClearance(String url) {
    String value = cfClearanceValue(url);
    return value != null && !value.isEmpty();
  }

  /** Current cf_clearance value, or null. Used to ignore a stale cookie from an earlier visit. */
  private static String cfClearanceValue(String url) {
    try {
      String cookie = CookieManager.getInstance().getCookie(url);
      if (cookie == null || cookie.isEmpty()) return null;
      for (String part : cookie.split(";")) {
        String trimmed = part.trim();
        if (trimmed.toLowerCase().startsWith("cf_clearance=")) {
          String value = trimmed.substring("cf_clearance=".length()).trim();
          return value.isEmpty() ? null : value;
        }
      }
      return null;
    } catch (Throwable t) {
      return null;
    }
  }

  private static String unwrapJsString(String value) {
    if (value == null || "null".equals(value)) return "";
    try {
      return new org.json.JSONArray("[" + value + "]").getString(0);
    } catch (Throwable t) {
      if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        return value.substring(1, value.length() - 1);
      }
      return value;
    }
  }

  @PluginMethod
  public void execute(PluginCall call) {
    String script = call.getString("script", "");
    main.post(() -> {
      if (gecko == null || script == null || script.isEmpty()) {
        JSObject out = ok();
        out.put("result", null);
        call.resolve(out);
        return;
      }
      gecko.evaluateJavascript(script, value -> {
        JSObject out = ok();
        out.put("result", jsResultToObject(value));
        call.resolve(out);
      });
    });
  }

  /** Trusted tap on the paused play control. No-op when the stream is already playing. */
  @PluginMethod
  public void tapPlay(PluginCall call) {
    main.post(() -> {
      JSObject out = ok();
      if (gecko == null || gecko.getVisibility() != View.VISIBLE) {
        out.put("ok", false);
        out.put("error", "Browser not visible");
        call.resolve(out);
        return;
      }
      if (isCloudflareInterstitial(currentUrl, currentTitle)) {
        out.put("ok", false);
        out.put("error", "Cloudflare Verify in progress");
        call.resolve(out);
        return;
      }
      gecko.tapPlayButton(() -> call.resolve(out));
    });
  }

  /** Synthetic center tap — unblocks embed.st / Clappr “press play” overlays. */
  @PluginMethod
  public void clickCenter(PluginCall call) {
    Boolean aggressive = call.getBoolean("aggressive", false);
    final boolean multi = Boolean.TRUE.equals(aggressive);
    main.post(() -> {
      JSObject out = ok();
      if (gecko == null || gecko.getVisibility() != View.VISIBLE) {
        out.put("ok", false);
        out.put("error", "Browser not visible");
        call.resolve(out);
        return;
      }
      if (isCloudflareInterstitial(currentUrl, currentTitle)) {
        out.put("ok", false);
        out.put("error", "Cloudflare Verify in progress");
        call.resolve(out);
        return;
      }
      if (gecko.getWidth() < 8 || gecko.getHeight() < 8) {
        out.put("ok", false);
        out.put("error", "Browser too small");
        call.resolve(out);
        return;
      }
      // One tap per point — a same-spot double-tap play→pauses Clappr/JW.
      float[][] points = multi
        ? new float[][] {
          { 0.5f, 0.42f },
          { 0.5f, 0.32f },
          { 0.5f, 0.55f }
        }
        : new float[][] { { 0.5f, 0.42f } };
      for (int i = 0; i < points.length; i++) {
        gecko.tapAt(points[i][0], points[i][1]);
      }
      out.put("ok", true);
      call.resolve(out);
    });
  }

  /** Gecko on Android ignores video.volume. The slider drives the media stream. */
  private void applyStreamVolume(double pct) {
    try {
      Context ctx = getContext();
      if (ctx == null) return;
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return;
      int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
      if (max <= 0) return;
      int target = (int) Math.round(pct / 100.0 * max);
      am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(0, Math.min(max, target)), 0);
    } catch (Throwable ignored) {}
  }

  private double readStreamVolume() {
    try {
      Context ctx = getContext();
      if (ctx == null) return 100;
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return 100;
      int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
      if (max <= 0) return 100;
      return Math.round(am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100.0 / max);
    } catch (Throwable ignored) {
      return 100;
    }
  }

  @PluginMethod
  public void setVolume(PluginCall call) {
    Double percent = call.getDouble("percent", 100.0);
    final double pct = percent == null ? 100.0 : Math.max(0, Math.min(100, percent));
    main.post(() -> {
      applyStreamVolume(pct);
      if (gecko != null) {
        final double level = pct / 100.0;
        String script =
          "(function(){try{window.__jiyuVolLevel=" + level + ";"
            + "var vids=document.querySelectorAll('video');"
            + "for(var i=0;i<vids.length;i++){vids[i].volume=" + level + ";vids[i].muted=" + (level <= 0.001 ? "true" : "false") + ";}"
            + "if(window.art){try{window.art.muted=" + (level <= 0.001 ? "true" : "false") + ";window.art.volume=" + level + ";}catch(e){}}"
            + "return " + pct + ";}catch(e){return " + pct + ";}})()";
        gecko.evaluateJavascript(script, null);
      }
      JSObject out = ok();
      out.put("percent", pct);
      call.resolve(out);
    });
  }

  @PluginMethod
  public void getVolume(PluginCall call) {
    main.post(() -> {
      JSObject out = ok();
      out.put("percent", readStreamVolume());
      call.resolve(out);
    });
  }

  private Object jsResultToObject(String value) {
    if (value == null || value.equals("null")) return null;
    try {
      if (value.startsWith("\"") || value.startsWith("'")) {
        return unwrapJsString(value);
      }
      if (value.equals("true") || value.equals("false")) {
        return Boolean.parseBoolean(value);
      }
      if (value.matches("-?\\d+(\\.\\d+)?")) {
        if (value.contains(".")) return Double.parseDouble(value);
        return Long.parseLong(value);
      }
      return value;
    } catch (Throwable t) {
      return unwrapJsString(value);
    }
  }

  @PluginMethod
  public void multiShow(PluginCall call) {
    String id = call.getString("id", "");
    String url = call.getString("url", "");
    Boolean primary = call.getBoolean("primary", false);
    if (id == null || id.trim().isEmpty() || url == null || url.trim().isEmpty()) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("error", "Missing id or url");
      call.resolve(err);
      return;
    }
    final String tileId = id.trim();
    final String target = url.trim();
    if (isStreamRefererOnlyUrl(target)) {
      JSObject err = new JSObject();
      err.put("ok", false);
      err.put("error", "Blocked stream-referer page");
      call.resolve(err);
      return;
    }
    final boolean isPrimary = Boolean.TRUE.equals(primary);
    final MultiWebHost.BoundsCss bounds = parseBoundsCss(call);
    main.post(() -> {
      try {
        float density = getContext().getResources().getDisplayMetrics().density;
        // Drop any leftover Chromium tiles. Multiview is one Gecko document now.
        if (multi != null) multi.hideAll(true, true);
        geckoMultiActive = true;
        ensureOverlay();
        ensureGeckoMulti().show(
          gecko,
          tileId,
          target,
          bounds == null ? 0 : bounds.x,
          bounds == null ? 0 : bounds.y,
          bounds == null ? 0 : bounds.width,
          bounds == null ? 0 : bounds.height,
          isPrimary,
          density
        );
        call.resolve(ok());
      } catch (Throwable t) {
        JSObject err = new JSObject();
        err.put("ok", false);
        err.put("error", t.getMessage() != null ? t.getMessage() : "multiShow failed");
        call.resolve(err);
      }
    });
  }

  @PluginMethod
  public void multiSetBounds(PluginCall call) {
    String id = call.getString("id", "");
    if (id == null || id.trim().isEmpty()) {
      call.resolve(ok());
      return;
    }
    final String tileId = id.trim();
    final MultiWebHost.BoundsCss bounds = parseBoundsCss(call);
    main.post(() -> {
      float density = getContext().getResources().getDisplayMetrics().density;
      ensureGeckoMulti().setBounds(
        gecko,
        tileId,
        bounds == null ? 0 : bounds.x,
        bounds == null ? 0 : bounds.y,
        bounds == null ? 0 : bounds.width,
        bounds == null ? 0 : bounds.height,
        density
      );
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void multiSetAudio(PluginCall call) {
    String id = call.getString("id", "");
    Boolean muted = call.getBoolean("muted", true);
    if (id == null || id.trim().isEmpty()) {
      call.resolve(ok());
      return;
    }
    final String tileId = id.trim();
    final boolean isMuted = Boolean.TRUE.equals(muted);
    main.post(() -> {
      ensureGeckoMulti().setAudio(gecko, tileId, isMuted);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void multiSpotlight(PluginCall call) {
    String id = call.getString("id", "");
    if (id == null || id.trim().isEmpty()) {
      call.resolve(ok());
      return;
    }
    final String tileId = id.trim();
    main.post(() -> {
      ensureGeckoMulti().spotlight(gecko, tileId);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void multiNudge(PluginCall call) {
    String id = call.getString("id", "");
    if (id == null || id.trim().isEmpty()) {
      call.resolve(ok());
      return;
    }
    final String tileId = id.trim();
    main.post(() -> {
      ensureGeckoMulti().nudge(gecko, tileId);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void multiHide(PluginCall call) {
    String id = call.getString("id", "");
    boolean blank = Boolean.TRUE.equals(call.getBoolean("blank", false));
    boolean destroy = Boolean.TRUE.equals(call.getBoolean("destroy", false));
    main.post(() -> {
      if (id == null || id.trim().isEmpty()) {
        geckoMultiActive = false;
        ensureGeckoMulti().hideAll(gecko);
        if (multi != null) multi.hideAll(blank, destroy);
      } else {
        ensureGeckoMulti().hide(gecko, id.trim());
        if (!ensureGeckoMulti().isActive()) geckoMultiActive = false;
        if (multi != null) multi.hide(id.trim(), blank, destroy);
      }
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void multiHideAll(PluginCall call) {
    boolean blank = Boolean.TRUE.equals(call.getBoolean("blank", false));
    main.post(() -> {
      geckoMultiActive = false;
      ensureGeckoMulti().hideAll(gecko);
      if (multi != null) multi.hideAll(blank, blank);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void getState(PluginCall call) {
    JSObject out = ok();
    out.put("url", currentUrl);
    out.put("title", currentTitle);
    out.put("canGoBack", canGoBack);
    out.put("canGoForward", canGoForward);
    out.put("loading", loading);
    out.put("external", false);
    call.resolve(out);
  }

  /**
   * Capacitor's root is a CoordinatorLayout, which crashes if a child uses
   * FrameLayout.LayoutParams. Nest browser views in our own FrameLayout.
   */
  private FrameLayout contentHost() {
    if (host != null) return host;
    ViewGroup root = (ViewGroup) getBridge().getWebView().getParent();
    FrameLayout frame = new FrameLayout(getContext());
    if (root instanceof CoordinatorLayout) {
      CoordinatorLayout.LayoutParams lp = new CoordinatorLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      );
      root.addView(frame, lp);
    } else {
      root.addView(frame, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
    }
    host = frame;
    return frame;
  }

  private MultiWebHost ensureMulti() {
    if (multi == null) multi = new MultiWebHost(getContext());
    return multi;
  }

  private GeckoMultiHost ensureGeckoMulti() {
    if (geckoMulti == null) geckoMulti = new GeckoMultiHost();
    return geckoMulti;
  }

  /** Detach multi tiles when single-player browser takes over. Do not blank — navigate loads next. */
  private void hideMultiForSingle() {
    geckoMultiActive = false;
    if (geckoMulti != null) geckoMulti.endWithoutBlank(gecko);
    if (multi == null) return;
    multi.hideAll(false, false);
  }

  /**
   * Park single-stream Gecko when Multiview Chromium tiles take over.
   * Must fully kill audio — pause alone still leaves streams audible under tiles.
   */
  private void hideSingleForMulti() {
    if (gecko == null) return;
    try {
      gecko.killMediaAndBlank();
    } catch (Throwable t) {
      try {
        gecko.setPageMuted(true);
        gecko.pause();
        gecko.blank();
      } catch (Throwable ignored) {}
    }
    gecko.setVisibility(View.GONE);
    currentUrl = "";
    currentTitle = "";
  }

  private MultiWebHost.BoundsCss parseBoundsCss(PluginCall call) {
    try {
      com.getcapacitor.JSObject boundsObj = call.getObject("bounds", null);
      Double x;
      Double y;
      Double w;
      Double h;
      if (boundsObj != null) {
        x = boundsObj.getDouble("x");
        y = boundsObj.getDouble("y");
        w = boundsObj.getDouble("width");
        h = boundsObj.getDouble("height");
      } else {
        x = call.getDouble("x");
        y = call.getDouble("y");
        w = call.getDouble("width");
        h = call.getDouble("height");
      }
      if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) {
        return null;
      }
      return new MultiWebHost.BoundsCss(
        x.floatValue(),
        y.floatValue(),
        w.floatValue(),
        h.floatValue()
      );
    } catch (Throwable ignored) {
      return null;
    }
  }

  private void ensureOverlay() {
    FrameLayout parent = contentHost();
    if (gecko != null && gecko.getView() != null) return;
    if (gecko == null) {
      gecko = new GeckoOverlayController(getContext());
      gecko.setNavListener((url, title, back, forward, load) -> {
        currentUrl = url != null ? url : "";
        currentTitle = title != null ? title : "";
        canGoBack = back;
        canGoForward = forward;
        loading = load;
        notifyNav();
      });
    }
    try {
      gecko.ensureAttached(parent);
    } catch (Throwable t) {
      android.util.Log.e("JiyuBrowser", "Could not attach browser view", t);
      try {
        gecko.destroy();
      } catch (Throwable ignored) {}
      gecko = null;
      return;
    }
    if (gecko.getView() == null) {
      gecko = null;
      return;
    }
    layoutParams = gecko.getLayoutParams();
  }

  private void applyBounds(PluginCall call) {
    if (gecko == null || layoutParams == null) return;
    Double x = call.getDouble("x");
    Double y = call.getDouble("y");
    Double w = call.getDouble("width");
    Double h = call.getDouble("height");
    float density = getContext().getResources().getDisplayMetrics().density;
    if (x != null && y != null && w != null && h != null && w > 0 && h > 0) {
      layoutParams.leftMargin = Math.round(x.floatValue() * density);
      layoutParams.topMargin = Math.round(y.floatValue() * density);
      layoutParams.width = Math.round(w.floatValue() * density);
      layoutParams.height = Math.round(h.floatValue() * density);
    } else {
      layoutParams.leftMargin = 0;
      layoutParams.topMargin = 0;
      layoutParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
      layoutParams.height = ViewGroup.LayoutParams.MATCH_PARENT;
    }
    gecko.setLayoutParams(layoutParams);
  }

  /**
   * System picture-in-picture: the embed surface should fill the small window
   * and stay active. Restoring the previous rect is left to the next setBounds
   * after the page lays out again.
   */
  public void onHostPictureInPicture(boolean active) {
    main.post(() -> {
      try {
        if (
          gecko != null
          && gecko.getView() != null
          && gecko.getVisibility() == View.VISIBLE
          && !geckoMultiActive
          && layoutParams != null
        ) {
          if (active) {
            if (!pipBoundsSaved) {
              pipLeft = layoutParams.leftMargin;
              pipTop = layoutParams.topMargin;
              pipW = layoutParams.width;
              pipH = layoutParams.height;
              pipBoundsSaved = true;
            }
            layoutParams.leftMargin = 0;
            layoutParams.topMargin = 0;
            layoutParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
            layoutParams.height = ViewGroup.LayoutParams.MATCH_PARENT;
            gecko.setLayoutParams(layoutParams);
            gecko.getView().bringToFront();
          } else if (pipBoundsSaved) {
            layoutParams.leftMargin = pipLeft;
            layoutParams.topMargin = pipTop;
            layoutParams.width = pipW;
            layoutParams.height = pipH;
            gecko.setLayoutParams(layoutParams);
            pipBoundsSaved = false;
          }
          gecko.resume();
        }
        if (active && multi != null) multi.resumeVisible();
      } catch (Throwable ignored) {}
    });
  }

  private void notifyNav() {
    JSObject nav = new JSObject();
    nav.put("url", currentUrl);
    nav.put("title", currentTitle.isEmpty() ? "Web browser" : currentTitle);
    nav.put("canGoBack", canGoBack);
    nav.put("canGoForward", canGoForward);
    nav.put("loading", loading);
    nav.put("external", false);
    notifyListeners("nav", nav);
  }

  private static JSObject ok() {
    JSObject o = new JSObject();
    o.put("ok", true);
    return o;
  }

  @Override
  protected void handleOnDestroy() {
    main.post(() -> {
      hideUnlockChrome();
      if (unlockPanel != null) {
        try {
          ((ViewGroup) unlockPanel.getParent()).removeView(unlockPanel);
        } catch (Throwable ignored) {}
        unlockPanel = null;
      }
      if (scrapeView != null) {
        try {
          ((ViewGroup) scrapeView.getParent()).removeView(scrapeView);
          scrapeView.destroy();
        } catch (Throwable ignored) {}
        scrapeView = null;
      }
      if (gecko != null) {
        try {
          gecko.destroy();
        } catch (Throwable ignored) {}
        gecko = null;
      }
      if (multi != null) {
        try {
          multi.destroyAll();
        } catch (Throwable ignored) {}
        multi = null;
      }
    });
    super.handleOnDestroy();
  }
}
