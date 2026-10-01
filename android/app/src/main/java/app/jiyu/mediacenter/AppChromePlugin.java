package app.jiyu.mediacenter;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.os.Build;
import android.util.Rational;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Immersive chrome + Android hardware back → JS.
 * HTML Fullscreen API on WebView zooms/crops video — we use CSS shell + immersive instead.
 */
@CapacitorPlugin(name = "AppChrome")
public class AppChromePlugin extends Plugin {

  private volatile boolean jsHandlesBack = false;
  private volatile boolean homePipEnabled = false;
  private volatile int pipWidth = 16;
  private volatile int pipHeight = 9;

  @PluginMethod
  public void setImmersive(PluginCall call) {
    Boolean enabled = call.getBoolean("enabled", false);
    final boolean on = Boolean.TRUE.equals(enabled);
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        applyImmersive(activity, on);
        call.resolve();
      } catch (Throwable t) {
        call.reject(t.getMessage() != null ? t.getMessage() : "Immersive failed");
      }
    });
  }

  /** When enabled, hardware Back is delivered as a `backButton` listener event. */
  @PluginMethod
  public void setBackHandling(PluginCall call) {
    jsHandlesBack = Boolean.TRUE.equals(call.getBoolean("enabled", true));
    JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }

  /** Soft-background the app (home) instead of destroying the activity. */
  @PluginMethod
  public void moveTaskToBack(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        activity.moveTaskToBack(true);
        call.resolve();
      } catch (Throwable t) {
        call.reject(t.getMessage() != null ? t.getMessage() : "moveTaskToBack failed");
      }
    });
  }

  /** Leave the app after Back confirm (removes the task from Recents). */
  @PluginMethod
  public void exitApp(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
          activity.finishAndRemoveTask();
        } else {
          activity.finish();
        }
        call.resolve();
      } catch (Throwable t) {
        try {
          activity.finish();
          call.resolve();
        } catch (Throwable ignored) {
          call.reject(t.getMessage() != null ? t.getMessage() : "exitApp failed");
        }
      }
    });
  }

  /**
   * Arm system picture-in-picture for the device Home button.
   * Enabled only while a stream is actually playing.
   */
  @PluginMethod
  public void setHomePip(PluginCall call) {
    homePipEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
    Integer width = call.getInt("width", 16);
    Integer height = call.getInt("height", 9);
    pipWidth = width != null && width > 0 ? width : 16;
    pipHeight = height != null && height > 0 ? height : 9;
    Activity activity = getActivity();
    if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.runOnUiThread(() -> {
        try {
          if (activity.isInPictureInPictureMode() && !homePipEnabled) {
            // Leave the window up until the user closes it; just stop re-entering.
          }
          activity.setPictureInPictureParams(buildPipParams());
        } catch (Throwable ignored) {}
      });
    }
    JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }

  public boolean isHomePipEnabled() {
    return homePipEnabled;
  }

  public PictureInPictureParams buildPipParams() {
    int w = pipWidth > 0 ? pipWidth : 16;
    int h = pipHeight > 0 ? pipHeight : 9;
    float aspect = (float) w / (float) h;
    // Android rejects ratios outside about 1:2.39 … 2.39:1.
    if (aspect < 0.42f || aspect > 2.39f) {
      w = 16;
      h = 9;
    }
    PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
      .setAspectRatio(new Rational(w, h));
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(homePipEnabled);
      builder.setSeamlessResizeEnabled(true);
    }
    return builder.build();
  }

  /** Activity entered or left the system picture-in-picture window. */
  public void onPictureInPictureModeChanged(boolean active) {
    JSObject data = new JSObject();
    data.put("active", active);
    notifyListeners("systemPip", data);
    try {
      app.jiyu.mediacenter.browser.InAppBrowserPlugin browser =
        (app.jiyu.mediacenter.browser.InAppBrowserPlugin)
          bridge.getPlugin("InAppBrowser").getInstance();
      if (browser != null) browser.onHostPictureInPicture(active);
    } catch (Throwable ignored) {}
  }

  /** Called from MainActivity. Returns true when Back was consumed (JS or unlock). */
  public boolean handleHardwareBack() {
    try {
      app.jiyu.mediacenter.browser.InAppBrowserPlugin browser =
        (app.jiyu.mediacenter.browser.InAppBrowserPlugin)
          bridge.getPlugin("InAppBrowser").getInstance();
      if (browser != null && browser.cancelUnlockIfVisible()) {
        return true;
      }
    } catch (Throwable ignored) {}
    if (!jsHandlesBack) return false;
    notifyListeners("backButton", new JSObject());
    return true;
  }

  static void applyImmersive(Activity activity, boolean on) {
    Window window = activity.getWindow();
    View decor = window.getDecorView();
    WindowCompat.setDecorFitsSystemWindows(window, !on);
    WindowInsetsControllerCompat controller =
      WindowCompat.getInsetsController(window, decor);
    if (controller != null) {
      if (on) {
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars());
      }
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      // Fallback for very old devices
      int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
      if (on) {
        flags |= View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_FULLSCREEN
          | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
      }
      decor.setSystemUiVisibility(on ? flags : View.SYSTEM_UI_FLAG_VISIBLE);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams lp = window.getAttributes();
      lp.layoutInDisplayCutoutMode = on
        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
      window.setAttributes(lp);
    }
    if (on) {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }
  }
}
