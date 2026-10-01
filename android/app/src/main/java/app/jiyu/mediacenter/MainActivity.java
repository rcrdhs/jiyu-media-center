package app.jiyu.mediacenter;

import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

import app.jiyu.mediacenter.browser.InAppBrowserPlugin;
import app.jiyu.mediacenter.torrent.TorrentStreamerPlugin;

public class MainActivity extends BridgeActivity {
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
    registerPlugin(AppChromePlugin.class);
    registerPlugin(AppUpdatePlugin.class);
    registerPlugin(CatalogSyncPlugin.class);
    registerPlugin(CastPlugin.class);
    super.onCreate(savedInstanceState);

    try {
      com.google.android.gms.cast.framework.CastContext.getSharedInstance(getApplicationContext());
    } catch (Throwable ignored) {}

    // Register after Capacitor so this callback wins. JS decides navigate vs home.
    getOnBackPressedDispatcher().addCallback(
      this,
      new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
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
    AppChromePlugin chrome = chromePlugin();
    if (chrome != null) chrome.onPictureInPictureModeChanged(isInPictureInPictureMode);
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
