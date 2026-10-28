package app.jiyu.mediacenter;

import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import app.jiyu.mediacenter.bili.BiliSessionPlugin;
import app.jiyu.mediacenter.browser.InAppBrowserPlugin;
import app.jiyu.mediacenter.browser.TvPointer;
import app.jiyu.mediacenter.media3.Media3PlayerPlugin;
import app.jiyu.mediacenter.torrent.TorrentStreamerPlugin;

public class MainActivity extends BridgeActivity {
  private volatile long pipExitSettleUntil = 0;
  /** Home was pressed and we asked the system to enter picture-in-picture. */
  private boolean pipTransition = false;
  /**
   * Home / leave with nothing playing and no catalog sync — finish after onStop
   * so permission sheets and config changes do not kill the process mid-flight.
   */
  private boolean exitAfterLeave = false;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    SplashScreen.installSplashScreen(this);
    registerPlugin(TorrentStreamerPlugin.class);
    registerPlugin(InAppBrowserPlugin.class);
    registerPlugin(Media3PlayerPlugin.class);
    registerPlugin(AppChromePlugin.class);
    registerPlugin(AppUpdatePlugin.class);
    registerPlugin(CatalogSyncPlugin.class);
    registerPlugin(CastPlugin.class);
    registerPlugin(BiliSessionPlugin.class);
    registerPlugin(app.jiyu.mediacenter.sync.SyncSecretPlugin.class);
    super.onCreate(savedInstanceState);
    applyDarkSystemBars();
    // Splash / Capacitor can flip icon appearance after first paint — re-assert.
    try {
      View decor = getWindow() != null ? getWindow().getDecorView() : null;
      if (decor != null) {
        decor.post(this::applyDarkSystemBars);
        decor.postDelayed(this::applyDarkSystemBars, 400);
        decor.postDelayed(this::applyDarkSystemBars, 1200);
      }
    } catch (Throwable ignored) {}

    try {
      com.google.android.gms.cast.framework.CastContext.getSharedInstance(getApplicationContext());
    } catch (Throwable ignored) {}

    // Register after Capacitor so this callback wins. JS decides navigate vs home.
    getOnBackPressedDispatcher().addCallback(
      this,
      new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
          // Bilibili sign-in sheet: Back steps the login page back, then closes it.
          try {
            BiliSessionPlugin bili =
              (BiliSessionPlugin) getBridge().getPlugin("BiliSession").getInstance();
            if (bili != null && bili.cancelIfVisible()) {
              return;
            }
          } catch (Throwable ignored) {}
          try {
            AppChromePlugin chrome =
              (AppChromePlugin) getBridge().getPlugin("AppChrome").getInstance();
            if (chrome != null && chrome.handleHardwareBack()) {
              return;
            }
          } catch (Throwable ignored) {}
          // No JS handler yet (splash) — soft background instead of killing the process.
          moveTaskToBack(true);
        }
      }
    );
  }

  /**
   * TV remote routing (Android TV / Google TV / Fire TV only; phones untouched):
   * - pointer mode over a Gecko stream eats D-pad / OK / Back;
   * - media keys go to JS as `mediaKey` events;
   * - D-pad / OK always land in the Capacitor WebView (native surfaces such as
   *   GeckoView / PlayerView must not steal focus), with DPAD_CENTER sent as Enter.
   */
  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (!TvMode.isTv(this)) return super.dispatchKeyEvent(event);
    try {
      if (TvPointer.get().isCursor() && TvPointer.get().handleKey(event)) return true;
    } catch (Throwable ignored) {}

    String media = mediaKeyName(event.getKeyCode());
    if (media != null) {
      if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
        AppChromePlugin chrome = chromePlugin();
        if (chrome != null) chrome.emitMediaKey(media);
      }
      return true;
    }

    if (isNavKey(event.getKeyCode())) {
      View web = getBridge() != null ? getBridge().getWebView() : null;
      if (web != null) {
        View focused = getCurrentFocus();
        if (focused == null || focused != web && isOverlaySurface(focused)) {
          web.requestFocus();
        }
        if (getCurrentFocus() == web) {
          if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER
            || event.getKeyCode() == KeyEvent.KEYCODE_BUTTON_A) {
            KeyEvent enter = new KeyEvent(
              event.getDownTime(),
              event.getEventTime(),
              event.getAction(),
              KeyEvent.KEYCODE_ENTER,
              event.getRepeatCount(),
              event.getMetaState(),
              event.getDeviceId(),
              event.getScanCode(),
              event.getFlags(),
              event.getSource()
            );
            return web.dispatchKeyEvent(enter) || super.dispatchKeyEvent(event);
          }
        }
      }
    }
    return super.dispatchKeyEvent(event);
  }

  private static boolean isNavKey(int code) {
    switch (code) {
      case KeyEvent.KEYCODE_DPAD_UP:
      case KeyEvent.KEYCODE_DPAD_DOWN:
      case KeyEvent.KEYCODE_DPAD_LEFT:
      case KeyEvent.KEYCODE_DPAD_RIGHT:
      case KeyEvent.KEYCODE_DPAD_CENTER:
      case KeyEvent.KEYCODE_ENTER:
      case KeyEvent.KEYCODE_NUMPAD_ENTER:
      case KeyEvent.KEYCODE_BUTTON_A:
        return true;
      default:
        return false;
    }
  }

  /** Browser / player surfaces drawn natively over the WebView. */
  private static boolean isOverlaySurface(View v) {
    if (v instanceof org.mozilla.geckoview.GeckoView) return true;
    if (v instanceof androidx.media3.ui.PlayerView) return true;
    android.view.ViewParent p = v.getParent();
    while (p instanceof View) {
      if (p instanceof org.mozilla.geckoview.GeckoView) return true;
      if (p instanceof androidx.media3.ui.PlayerView) return true;
      p = p.getParent();
    }
    return false;
  }

  private static String mediaKeyName(int code) {
    switch (code) {
      case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
      case KeyEvent.KEYCODE_HEADSETHOOK:
        return "playpause";
      case KeyEvent.KEYCODE_MEDIA_PLAY:
        return "play";
      case KeyEvent.KEYCODE_MEDIA_PAUSE:
        return "pause";
      case KeyEvent.KEYCODE_MEDIA_STOP:
        return "stop";
      case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
        return "forward";
      case KeyEvent.KEYCODE_MEDIA_REWIND:
        return "rewind";
      case KeyEvent.KEYCODE_MEDIA_NEXT:
        return "next";
      case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
        return "previous";
      default:
        return null;
    }
  }

  /**
   * Device Home: playing → system PiP; syncing → stay in background; otherwise exit.
   */
  @Override
  public void onUserLeaveHint() {
    super.onUserLeaveHint();
    exitAfterLeave = false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode()) {
      return;
    }
    AppChromePlugin chrome = chromePlugin();
    if (
      chrome != null
      && chrome.isHomePipEnabled()
      && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
    ) {
      pipTransition = true;
      try {
        boolean entered = enterPictureInPictureMode(chrome.buildPipParams());
        if (!entered) pipTransition = false;
      } catch (Throwable t) {
        pipTransition = false;
      }
      return;
    }
    // Catalog sync needs the WebView process — do not finish while it is held.
    if (CatalogSyncPlugin.isSyncHoldActive()) return;
    exitAfterLeave = true;
  }

  @Override
  public void onStop() {
    super.onStop();
    boolean leave = exitAfterLeave;
    exitAfterLeave = false;
    if (!leave || isChangingConfigurations() || isFinishing()) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode()) return;
    if (CatalogSyncPlugin.isSyncHoldActive()) return;
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
        finishAndRemoveTask();
      } else {
        finish();
      }
    } catch (Throwable ignored) {
      finish();
    }
  }

  @Override
  public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
    pipTransition = isInPictureInPictureMode;
    exitAfterLeave = false;
    if (isInPictureInPictureMode) keepWebViewPlaying();
    // Keep this window long enough that focus/resume and PiP-param updates
    // cannot land mid-expand. Those calls make Android re-enter PiP.
    pipExitSettleUntil = isInPictureInPictureMode ? 0 : System.currentTimeMillis() + 2_000;
    AppChromePlugin chrome = chromePlugin();
    if (chrome != null) chrome.onPictureInPictureModeChanged(isInPictureInPictureMode);
  }

  @Override
  public void onResume() {
    super.onResume();
    applyDarkSystemBars();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) applyDarkSystemBars();
  }

  /**
   * Landscape ↔ portrait while immersive often leaves the Capacitor WebView stuck
   * at the old short edge height (home squashed into the top band, black below).
   * Force a full relayout and re-apply immersive so the player fills the screen.
   */
  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    // PiP enter/expand also lands here; touching insets/layout mid-transition
    // makes Android snap the window back into PiP.
    if (inPipOrSettling()) return;
    applyDarkSystemBars();
    AppChromePlugin chrome = chromePlugin();
    if (chrome != null) chrome.reapplyImmersiveIfNeeded();
    try {
      View web = getBridge() != null ? getBridge().getWebView() : null;
      if (web == null) return;
      web.post(() -> {
        try {
          forceWebViewMatchParent(web);
          web.postDelayed(() -> forceWebViewMatchParent(web), 120);
          web.postDelayed(() -> forceWebViewMatchParent(web), 400);
        } catch (Throwable ignored) {}
      });
    } catch (Throwable ignored) {}
  }

  private void forceWebViewMatchParent(View web) {
    try {
      View parent = web.getParent() instanceof View ? (View) web.getParent() : null;
      if (parent != null) {
        parent.requestLayout();
        parent.invalidate();
      }
      android.view.ViewGroup.LayoutParams lp = web.getLayoutParams();
      if (lp != null) {
        lp.width = android.view.ViewGroup.LayoutParams.MATCH_PARENT;
        lp.height = android.view.ViewGroup.LayoutParams.MATCH_PARENT;
        web.setLayoutParams(lp);
      }
      web.requestLayout();
      web.invalidate();
      web.getRootView().requestLayout();
    } catch (Throwable ignored) {}
  }

  @Override
  public void onPause() {
    boolean hold = pipTransition || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode());
    super.onPause();
    // Capacitor pauses the WebView here, which pauses HTML video. PiP stays visible.
    if (hold) {
      keepWebViewPlaying();
      try {
        getWindow().getDecorView().postDelayed(() -> {
          if (isFinishing()) return;
          if (pipTransition || isInPictureInPictureMode()) keepWebViewPlaying();
        }, 250);
      } catch (Throwable ignored) {}
    }
  }

  boolean deferPipParamUpdates() {
    return System.currentTimeMillis() < pipExitSettleUntil;
  }

  /** True while in PiP or just after expanding out of it. */
  private boolean inPipOrSettling() {
    if (pipTransition) return true;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode()) return true;
    return System.currentTimeMillis() < pipExitSettleUntil;
  }

  /**
   * Keep clock / battery / signal light on the black status bar.
   * Target SDK 35+ forces edge-to-edge (statusBarColor is often ignored); if light-mode
   * leaves dark glyphs on #080A0D the strip looks blank.
   */
  void applyDarkSystemBars() {
    if (inPipOrSettling()) return;
    try {
      Window window = getWindow();
      if (window == null) return;
      // Don't fight immersive player chrome — AppChrome owns bars there.
      AppChromePlugin chrome = chromePlugin();
      if (chrome != null && chrome.isImmersive()) return;

      View decor = window.getDecorView();
      final int bar = Color.parseColor("#080A0D");

      window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
      window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
      window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
      // Prefer a real status-bar band (not drawn-under) on the home/browse shell.
      WindowCompat.setDecorFitsSystemWindows(window, true);
      window.setStatusBarColor(bar);
      window.setNavigationBarColor(bar);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        window.setStatusBarContrastEnforced(false);
        window.setNavigationBarContrastEnforced(false);
      }

      // Legacy flags (still honored on some OEMs) — clear LIGHT_* so icons stay pale.
      int vis = decor.getSystemUiVisibility();
      vis &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vis &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
      }
      decor.setSystemUiVisibility(vis);

      WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(window, decor);
      if (controller != null) {
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
        controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController ic = window.getInsetsController();
        if (ic != null) {
          ic.setSystemBarsAppearance(
            0,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
              | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
          );
          ic.show(android.view.WindowInsets.Type.statusBars());
        }
      }
    } catch (Throwable ignored) {}
  }

  private void keepWebViewPlaying() {
    try {
      if (getBridge() == null || getBridge().getWebView() == null) return;
      getBridge().getWebView().onResume();
      getBridge().getWebView().resumeTimers();
    } catch (Throwable ignored) {}
  }

  private AppChromePlugin chromePlugin() {
    try {
      if (getBridge() == null || getBridge().getPlugin("AppChrome") == null) return null;
      return (AppChromePlugin) getBridge().getPlugin("AppChrome").getInstance();
    } catch (Throwable t) {
      return null;
    }
  }
}
