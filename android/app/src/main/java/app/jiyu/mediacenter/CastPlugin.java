package app.jiyu.mediacenter;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.format.Formatter;

import androidx.mediarouter.app.MediaRouteChooserDialog;
import androidx.mediarouter.media.MediaControlIntent;
import androidx.mediarouter.media.MediaRouteSelector;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;

/**
 * Google Cast for streams Jiyu owns a real media URL for (HLS / remux MP4).
 * Sports embeds have no castable URL — use {@link #openScreenCastSettings} to mirror.
 */
@CapacitorPlugin(name = "AppCast")
public class CastPlugin extends Plugin {

  private final Handler main = new Handler(Looper.getMainLooper());
  private PendingLoad pending;
  private SessionManagerListener<CastSession> sessionListener;

  private static final class PendingLoad {
    final String url;
    final String title;
    final String subtitle;
    final String imageUrl;
    final String contentType;
    final long positionMs;
    final PluginCall call;

    PendingLoad(
      String url,
      String title,
      String subtitle,
      String imageUrl,
      String contentType,
      long positionMs,
      PluginCall call
    ) {
      this.url = url;
      this.title = title;
      this.subtitle = subtitle;
      this.imageUrl = imageUrl;
      this.contentType = contentType;
      this.positionMs = positionMs;
      this.call = call;
    }
  }

  @Override
  public void load() {
    main.post(() -> {
      try {
        Context app = getContext().getApplicationContext();
        CastContext.getSharedInstance(app);
        ensureSessionListener();
      } catch (Throwable ignored) {}
    });
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    JSObject out = new JSObject();
    try {
      CastContext.getSharedInstance(getContext().getApplicationContext());
      out.put("ok", true);
      out.put("available", true);
    } catch (Throwable t) {
      out.put("ok", true);
      out.put("available", false);
    }
    call.resolve(out);
  }

  @PluginMethod
  public void getState(PluginCall call) {
    main.post(() -> call.resolve(stateObject()));
  }

  @PluginMethod
  public void showPicker(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    main.post(() -> {
      try {
        ensureSessionListener();
        MediaRouteChooserDialog dialog = new MediaRouteChooserDialog(activity);
        dialog.setRouteSelector(
          new MediaRouteSelector.Builder()
            .addControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)
            .addControlCategory(com.google.android.gms.cast.CastMediaControlIntent.categoryForCast(
              com.google.android.gms.cast.CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
            ))
            .build()
        );
        dialog.show();
        call.resolve(ok());
      } catch (Throwable t) {
        call.reject(t.getMessage() != null ? t.getMessage() : "Cast picker failed");
      }
    });
  }

  @PluginMethod
  public void castMedia(PluginCall call) {
    String rawUrl = call.getString("url", "");
    if (rawUrl == null || rawUrl.trim().isEmpty()) {
      call.reject("Missing url");
      return;
    }
    final String url = rewriteLocalhostToLan(rawUrl.trim());
    if (url.startsWith("http://127.") || url.startsWith("http://localhost")) {
      call.reject("This stream is only on the phone. Stay on Wi‑Fi so the TV can reach it, or try again.");
      return;
    }
    final String title = call.getString("title", "Jiyu");
    final String subtitle = call.getString("subtitle", "");
    final String imageUrl = call.getString("imageUrl", "");
    final String contentType = guessContentType(url, call.getString("contentType", ""));
    Double posSec = call.getDouble("position", 0d);
    final long positionMs = Math.max(0L, Math.round((posSec != null ? posSec : 0d) * 1000d));

    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }

    main.post(() -> {
      try {
        ensureSessionListener();
        CastSession session = currentSession();
        if (session != null && session.isConnected()) {
          loadOnSession(session, url, title, subtitle, imageUrl, contentType, positionMs);
          call.resolve(stateObject());
          notifyCastState();
          return;
        }
        pending = new PendingLoad(url, title, subtitle, imageUrl, contentType, positionMs, call);
        MediaRouteChooserDialog dialog = new MediaRouteChooserDialog(activity);
        dialog.setRouteSelector(
          new MediaRouteSelector.Builder()
            .addControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)
            .addControlCategory(com.google.android.gms.cast.CastMediaControlIntent.categoryForCast(
              com.google.android.gms.cast.CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
            ))
            .build()
        );
        dialog.setOnDismissListener(d -> {
          if (pending != null && pending.call == call) {
            // User closed picker without connecting.
            PendingLoad left = pending;
            pending = null;
            try {
              left.call.resolve(stateObject());
            } catch (Throwable ignored) {}
          }
        });
        dialog.show();
      } catch (Throwable t) {
        pending = null;
        call.reject(t.getMessage() != null ? t.getMessage() : "Cast failed");
      }
    });
  }

  @PluginMethod
  public void stop(PluginCall call) {
    main.post(() -> {
      try {
        CastSession session = currentSession();
        if (session != null) {
          RemoteMediaClient client = session.getRemoteMediaClient();
          if (client != null) client.stop();
          SessionManager mgr = CastContext.getSharedInstance(getContext()).getSessionManager();
          mgr.endCurrentSession(true);
        }
        pending = null;
        call.resolve(stateObject());
        notifyCastState();
      } catch (Throwable t) {
        call.reject(t.getMessage() != null ? t.getMessage() : "Stop cast failed");
      }
    });
  }

  /** Opens system Cast / screen-cast settings — used when a stream has no media URL (sports embeds). */
  @PluginMethod
  public void openScreenCastSettings(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    main.post(() -> {
      try {
        Intent intent = new Intent("android.settings.CAST_SETTINGS");
        if (intent.resolveActivity(activity.getPackageManager()) == null) {
          intent = new Intent(Settings.ACTION_CAST_SETTINGS);
        }
        if (intent.resolveActivity(activity.getPackageManager()) == null) {
          intent = new Intent(Settings.ACTION_SETTINGS);
        }
        activity.startActivity(intent);
        call.resolve(ok());
      } catch (Throwable t) {
        call.reject(t.getMessage() != null ? t.getMessage() : "Could not open Cast settings");
      }
    });
  }

  private void ensureSessionListener() {
    if (sessionListener != null) return;
    SessionManager mgr = CastContext.getSharedInstance(getContext()).getSessionManager();
    sessionListener = new SessionManagerListener<CastSession>() {
      @Override
      public void onSessionStarted(CastSession session, String sessionId) {
        flushPending(session);
        notifyCastState();
      }

      @Override
      public void onSessionResumed(CastSession session, boolean wasSuspended) {
        flushPending(session);
        notifyCastState();
      }

      @Override
      public void onSessionEnded(CastSession session, int error) {
        notifyCastState();
      }

      @Override
      public void onSessionSuspended(CastSession session, int reason) {
        notifyCastState();
      }

      @Override
      public void onSessionStarting(CastSession session) {}

      @Override
      public void onSessionStartFailed(CastSession session, int error) {
        PendingLoad left = pending;
        pending = null;
        if (left != null) {
          try {
            left.call.reject("Could not connect to the TV");
          } catch (Throwable ignored) {}
        }
        notifyCastState();
      }

      @Override
      public void onSessionEnding(CastSession session) {}

      @Override
      public void onSessionResuming(CastSession session, String sessionId) {}

      @Override
      public void onSessionResumeFailed(CastSession session, int error) {
        notifyCastState();
      }
    };
    mgr.addSessionManagerListener(sessionListener, CastSession.class);
  }

  private void flushPending(CastSession session) {
    PendingLoad load = pending;
    if (load == null || session == null) return;
    pending = null;
    try {
      loadOnSession(
        session,
        load.url,
        load.title,
        load.subtitle,
        load.imageUrl,
        load.contentType,
        load.positionMs
      );
      load.call.resolve(stateObject());
    } catch (Throwable t) {
      try {
        load.call.reject(t.getMessage() != null ? t.getMessage() : "Cast load failed");
      } catch (Throwable ignored) {}
    }
  }

  private void loadOnSession(
    CastSession session,
    String url,
    String title,
    String subtitle,
    String imageUrl,
    String contentType,
    long positionMs
  ) {
    RemoteMediaClient client = session.getRemoteMediaClient();
    if (client == null) throw new IllegalStateException("No media client");

    MediaMetadata meta = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
    if (title != null && !title.isEmpty()) meta.putString(MediaMetadata.KEY_TITLE, title);
    if (subtitle != null && !subtitle.isEmpty()) {
      meta.putString(MediaMetadata.KEY_SUBTITLE, subtitle);
    }
    if (imageUrl != null && imageUrl.startsWith("http")) {
      try {
        meta.addImage(new WebImage(Uri.parse(imageUrl)));
      } catch (Throwable ignored) {}
    }

    MediaInfo info =
      new MediaInfo.Builder(url)
        .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
        .setContentType(contentType)
        .setMetadata(meta)
        .build();

    MediaLoadRequestData request =
      new MediaLoadRequestData.Builder()
        .setMediaInfo(info)
        .setAutoplay(true)
        .setCurrentTime(positionMs)
        .build();
    client.load(request);
  }

  private CastSession currentSession() {
    try {
      return CastContext.getSharedInstance(getContext()).getSessionManager().getCurrentCastSession();
    } catch (Throwable t) {
      return null;
    }
  }

  private JSObject stateObject() {
    JSObject out = ok();
    CastSession session = currentSession();
    boolean casting = session != null && session.isConnected();
    out.put("casting", casting);
    out.put("deviceName", casting && session.getCastDevice() != null
      ? session.getCastDevice().getFriendlyName()
      : "");
    if (casting) {
      try {
        RemoteMediaClient client = session.getRemoteMediaClient();
        if (client != null) {
          out.put("position", client.getApproximateStreamPosition() / 1000.0);
          MediaStatus status = client.getMediaStatus();
          out.put("playing", status != null && status.getPlayerState() == MediaStatus.PLAYER_STATE_PLAYING);
        }
      } catch (Throwable ignored) {}
    }
    return out;
  }

  private void notifyCastState() {
    notifyListeners("castState", stateObject());
  }

  private static JSObject ok() {
    JSObject o = new JSObject();
    o.put("ok", true);
    return o;
  }

  private static String guessContentType(String url, String hint) {
    if (hint != null && !hint.trim().isEmpty()) return hint.trim();
    String lower = url.toLowerCase(Locale.US);
    if (lower.contains(".m3u8") || lower.contains("format=m3u8")) {
      return "application/x-mpegurl";
    }
    if (lower.contains("stream.mp4") || lower.contains(".mp4")) {
      return "video/mp4";
    }
    if (lower.contains(".mkv")) return "video/x-matroska";
    return "video/mp4";
  }

  /** Chromecast cannot read 127.0.0.1 on the phone — rewrite to the LAN address. */
  private String rewriteLocalhostToLan(String url) {
    if (!url.contains("127.0.0.1") && !url.contains("localhost")) return url;
    String lan = lanIpv4();
    if (lan == null || lan.isEmpty()) return url;
    return url.replace("127.0.0.1", lan).replace("localhost", lan);
  }

  private String lanIpv4() {
    try {
      WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      if (wifi != null) {
        int ip = wifi.getConnectionInfo().getIpAddress();
        if (ip != 0) {
          String formatted = Formatter.formatIpAddress(ip);
          if (formatted != null && !formatted.startsWith("0.")) return formatted;
        }
      }
    } catch (Throwable ignored) {}
    try {
      Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
      for (NetworkInterface net : Collections.list(nets)) {
        if (!net.isUp() || net.isLoopback()) continue;
        for (InetAddress addr : Collections.list(net.getInetAddresses())) {
          if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
            String host = addr.getHostAddress();
            if (host != null && !host.startsWith("169.254.")) return host;
          }
        }
      }
    } catch (Throwable ignored) {}
    return null;
  }
}
