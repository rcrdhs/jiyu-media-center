package app.jiyu.mediacenter.media3;

import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Capacitor bridge for Media3/ExoPlayer overlay playback.
 * Used after Gecko unwraps sports embeds to a real media URL.
 */
@CapacitorPlugin(name = "Media3Player")
public class Media3PlayerPlugin extends Plugin {
  private Media3PlayerController player;
  private FrameLayout.LayoutParams layoutParams;
  private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

  @PluginMethod
  public void show(PluginCall call) {
    main.post(() -> {
      try {
        ensureOverlay();
        if (player == null || player.getView() == null) {
          resolveErr(call, "Could not attach Media3 view");
          return;
        }
        applyBounds(call);
        player.setVisibility(View.VISIBLE);
        call.resolve(ok());
      } catch (Throwable t) {
        resolveErr(call, t.getMessage() != null ? t.getMessage() : "show failed");
      }
    });
  }

  @PluginMethod
  public void hide(PluginCall call) {
    boolean stop = Boolean.TRUE.equals(call.getBoolean("stop", true));
    main.post(() -> {
      if (player != null) player.hide(stop);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void setBounds(PluginCall call) {
    main.post(() -> {
      ensureOverlay();
      applyBounds(call);
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void play(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || url.trim().isEmpty()) {
      resolveErr(call, "Missing url");
      return;
    }
    final String mediaUrl = url.trim();
    final String title = call.getString("title", "");
    final Map<String, String> headers = readHeaders(call);
    main.post(() -> {
      try {
        ensureOverlay();
        if (player == null || player.getView() == null) {
          resolveErr(call, "Could not attach Media3 view");
          return;
        }
        applyBounds(call);
        player.play(mediaUrl, headers, title);
        call.resolve(ok());
      } catch (Throwable t) {
        resolveErr(call, t.getMessage() != null ? t.getMessage() : "play failed");
      }
    });
  }

  @PluginMethod
  public void pause(PluginCall call) {
    main.post(() -> {
      if (player != null) player.pause();
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void resume(PluginCall call) {
    main.post(() -> {
      if (player != null) player.resume();
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void stop(PluginCall call) {
    main.post(() -> {
      if (player != null) player.stop();
      call.resolve(ok());
    });
  }

  @PluginMethod
  public void setVolume(PluginCall call) {
    Double percent = call.getDouble("percent", 100.0);
    final float level = (float) ((percent == null ? 100.0 : Math.max(0, Math.min(100, percent))) / 100.0);
    main.post(() -> {
      if (player != null) player.setVolume(level);
      JSObject out = ok();
      out.put("percent", level * 100.0);
      call.resolve(out);
    });
  }

  @PluginMethod
  public void getState(PluginCall call) {
    main.post(() -> {
      JSObject out = ok();
      out.put("playing", player != null && player.isPlaying());
      out.put("url", player != null ? player.getCurrentUrl() : "");
      out.put("position", player != null ? player.getPositionMs() / 1000.0 : 0);
      out.put("volume", player != null ? player.getVolume() * 100.0 : 100);
      out.put("visible", player != null && player.getVisibility() == View.VISIBLE);
      call.resolve(out);
    });
  }

  @Override
  protected void handleOnDestroy() {
    main.post(() -> {
      if (player != null) {
        player.destroy();
        player = null;
      }
    });
    super.handleOnDestroy();
  }

  private void ensureOverlay() {
    FrameLayout parent = contentHost();
    if (parent == null) return;
    if (player != null && player.getView() != null) return;
    if (player == null) {
      player = new Media3PlayerController(getContext());
      player.setListener((state, detail) -> {
        JSObject ev = new JSObject();
        ev.put("state", state);
        if (detail != null) ev.put("detail", detail);
        notifyListeners("playback", ev);
      });
    }
    player.ensureAttached(parent);
    layoutParams = player.getLayoutParams();
  }

  private FrameLayout contentHost() {
    try {
      ViewGroup root = (ViewGroup) getBridge().getWebView().getParent();
      if (root instanceof FrameLayout) return (FrameLayout) root;
      // Walk up to a FrameLayout host (CoordinatorLayout → FrameLayout).
      ViewGroup cur = root;
      while (cur != null) {
        if (cur instanceof FrameLayout) return (FrameLayout) cur;
        if (!(cur.getParent() instanceof ViewGroup)) break;
        cur = (ViewGroup) cur.getParent();
      }
      return root instanceof FrameLayout ? (FrameLayout) root : null;
    } catch (Throwable t) {
      return null;
    }
  }

  private void applyBounds(PluginCall call) {
    if (player == null || layoutParams == null) return;
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
    player.setLayoutParams(layoutParams);
  }

  private static Map<String, String> readHeaders(PluginCall call) {
    Map<String, String> out = new HashMap<>();
    try {
      JSObject headers = call.getObject("headers");
      if (headers == null) return out;
      Iterator<String> keys = headers.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        Object val = headers.get(key);
        if (val != null) out.put(key, String.valueOf(val));
      }
    } catch (Throwable ignored) {}
    // Also accept referrer / userAgent top-level for convenience.
    String referrer = call.getString("referrer", "");
    String ua = call.getString("userAgent", "");
    if (referrer != null && !referrer.isEmpty()) out.put("Referer", referrer);
    if (ua != null && !ua.isEmpty()) out.put("User-Agent", ua);
    return out;
  }

  private static JSObject ok() {
    JSObject o = new JSObject();
    o.put("ok", true);
    return o;
  }

  private static void resolveErr(PluginCall call, String message) {
    JSObject err = new JSObject();
    err.put("ok", false);
    err.put("error", message != null ? message : "error");
    call.resolve(err);
  }
}
